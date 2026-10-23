"""Native Gemini for Vertex Express/API keys and standard Vertex/ADC."""

import copy
import json
import mimetypes
import re
from urllib.parse import urlsplit
from uuid import uuid4

import httpx

from app.agents.llm import (
    PROVIDER_FAILURES, TRANSIENT_FAILURES, ProviderError, _TransientStreamError,
    provider_endpoint, request_error, shared_ssl_context, status_error,
)
from app.config import Settings


def content_parts(content) -> list[dict]:
    if isinstance(content, str):
        return [{"text": content}] if content else []
    parts = []
    for item in content or []:
        if item.get("type") == "text":
            parts.append({"text": item["text"]})
        elif item.get("type") == "image_url":
            url = item["image_url"]["url"]
            inline = re.fullmatch(r"data:(image/[\w.+-]+);base64,([A-Za-z0-9+/=\s]+)", url)
            if inline:
                parts.append({"inlineData": {"mimeType": inline[1], "data": inline[2]}})
            elif urlsplit(url).scheme in {"https", "http", "gs"}:
                mime = mimetypes.guess_type(urlsplit(url).path)[0] or "image/jpeg"
                parts.append({"fileData": {"mimeType": mime, "fileUri": url}})
            else:
                raise ProviderError(502, "Gemini 图片格式不支持，请重新上传图片。")
        else:
            raise ProviderError(502, "Gemini 暂不支持这类消息内容。")
    return parts


def native_payload(messages: list[dict], tools: list[dict] | None = None, *, structured=False) -> dict:
    contents, system = [], []
    call_names = {}

    def append(role, parts):
        if not parts:
            return
        if contents and contents[-1]["role"] == role:
            contents[-1]["parts"].extend(parts)
        else:
            contents.append({"role": role, "parts": parts})

    for message in messages:
        role = message["role"]
        if role in {"system", "developer"}:
            system.extend(content_parts(message.get("content")))
        elif role == "tool":
            name = call_names.get(message.get("tool_call_id"))
            if not name:
                raise ProviderError(502, "工具结果缺少对应调用，请重新发送消息。")
            output = message.get("content", "")
            try:
                output = json.loads(output) if isinstance(output, str) else output
            except ValueError:
                pass
            response = output if isinstance(output, dict) else {"result": output}
            function = {"name": name, "response": response}
            # Native models may supply their own IDs; our locally generated IDs are not native IDs.
            native_id = call_names.get((message.get("tool_call_id"), "native_id"))
            if native_id:
                function["id"] = native_id
            append("user", [{"functionResponse": function}])
        else:
            parts = content_parts(message.get("content"))
            for call in message.get("tool_calls") or []:
                function = call.get("function") or {}
                call_names[call["id"]] = function["name"]
                original = call.get("gemini_part")
                if isinstance(original, dict) and isinstance(original.get("functionCall"), dict):
                    part = copy.deepcopy(original)
                    native_id = part["functionCall"].get("id")
                    if native_id:
                        call_names[(call["id"], "native_id")] = native_id
                else:
                    # Only for app-injected / old OpenAI tool history, never a replacement for a real signature.
                    # Google's documented migration escape hatch: cloud.google.com/vertex-ai/generative-ai/docs/thought-signatures
                    args = function.get("arguments") or "{}"
                    try:
                        args = json.loads(args) if isinstance(args, str) else args
                    except ValueError:
                        raise ProviderError(502, "历史工具参数无法解析，请重新发送消息。") from None
                    part = {"functionCall": {"name": function["name"], "args": args},
                            "thoughtSignature": "skip_thought_signature_validator"}
                parts.append(part)
            append("model" if role == "assistant" else "user", parts)
    payload = {"contents": contents}
    if system:
        payload["systemInstruction"] = {"parts": system}
    if structured:
        payload["generationConfig"] = {"responseMimeType": "application/json"}
    else:
        payload["generationConfig"] = {"thinkingConfig": {"includeThoughts": True}}
        if tools:
            payload["tools"] = [{"functionDeclarations": [{
                "name": tool["function"]["name"],
                "description": tool["function"].get("description", ""),
                "parametersJsonSchema": tool["function"].get("parameters", {"type": "object", "properties": {}}),
            } for tool in tools]}]
    return payload


def native_usage(body: dict) -> dict | None:
    raw = body.get("usageMetadata")
    if not isinstance(raw, dict):
        return None
    usage = {"prompt_tokens": raw.get("promptTokenCount")}
    candidates, thoughts = raw.get("candidatesTokenCount"), raw.get("thoughtsTokenCount", 0)
    if type(candidates) is int and type(thoughts) is int and candidates >= 0 and thoughts >= 0:
        usage["completion_tokens"] = candidates + thoughts
    if "cachedContentTokenCount" in raw:
        usage["prompt_tokens_details"] = {"cached_tokens": raw["cachedContentTokenCount"]}
    return usage


def candidate_of(body: dict) -> dict:
    if body.get("error"):
        raise ProviderError(502, "Gemini 在生成过程中返回错误，请检查模型权限与接口配置。")
    if (body.get("promptFeedback") or {}).get("blockReason"):
        raise ProviderError(502, "Gemini 拦截了本次请求，请调整内容后重试。", usage=native_usage(body))
    candidates = body.get("candidates") or []
    candidate = candidates[0] if candidates else {}
    reason = candidate.get("finishReason")
    if reason and reason not in {"STOP", "MAX_TOKENS"}:
        raise ProviderError(502, "Gemini 未能完成本次回复，可能受到安全或工具调用限制，请重试。", usage=native_usage(body))
    return candidate


async def stream_packets(response):
    """SSE events may span HTTP chunks and contain multiple data lines."""
    data = []
    async for line in response.aiter_lines():
        if line.startswith("data:"):
            data.append(line[5:].lstrip())
        elif not line and data:
            raw = "\n".join(data)
            data = []
            if raw.strip() and raw != "[DONE]":
                yield json.loads(raw)
    if data and "\n".join(data).strip() and "\n".join(data) != "[DONE]":
        yield json.loads("\n".join(data))


class GeminiNativeChat:
    def __init__(self, settings: Settings, transport: httpx.AsyncBaseTransport | None = None):
        self.settings = settings
        self.transport = transport

    def status_error(self, status_code: int):
        if self.settings.llm_auth_mode == "adc" and status_code in {401, 403}:
            return ProviderError(503, "Google 拒绝了 ADC 请求，请检查登录账号、项目模型权限、配额项目及组织策略；不会自动改用 API Key。")
        return status_error(status_code)

    async def endpoint(self, method: str):
        model = self.settings.llm_model.strip().removeprefix("google/")
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", model):
            raise ProviderError(503, "Gemini 模型名称无效，请填写如 gemini-4-argon 的模型 ID。")
        if self.settings.llm_auth_mode == "adc":
            from app.agents.vertex_config import adc_base_url
            from app.services.google_adc import adc_headers
            if not self.settings.llm_configured:
                raise ProviderError(503, "ADC 模型配置无效，请检查项目 ID、区域和原生接口地址。")
            base = adc_base_url(self.settings.llm_project_id, self.settings.llm_location)
            url = f"{base}/{model}:{method}"
            return url, {**await adc_headers(self.settings.llm_project_id, url), "Content-Type": "application/json"}
        base, key = provider_endpoint(self.settings)
        return f"{base}/{model}:{method}", {"x-goog-api-key": key, "Content-Type": "application/json"}

    async def stream(self, messages: list[dict], tools: list[dict] | None = None):
        url, headers = await self.endpoint("streamGenerateContent")
        payload = native_payload(messages, tools)
        calls, finish = [], None
        try:
            async with httpx.AsyncClient(timeout=self.settings.llm_timeout_seconds, transport=self.transport,
                                         verify=shared_ssl_context()) as client:
                async with client.stream("POST", url, params={"alt": "sse"}, headers=headers, json=payload) as response:
                    error = self.status_error(response.status_code)
                    if error:
                        await response.aread()
                        raise error
                    if "text/event-stream" in response.headers.get("content-type", ""):
                        packets = stream_packets(response)
                    else:
                        body = json.loads(await response.aread())

                        async def single():
                            for item in body if isinstance(body, list) else [body]:
                                yield item
                        packets = single()
                    async for body in packets:
                        candidate = candidate_of(body)
                        if usage := native_usage(body):
                            yield "usage", usage
                        for part in (candidate.get("content") or {}).get("parts") or []:
                            if part.get("text"):
                                yield "reasoning" if part.get("thought") else "text", part["text"]
                            if "functionCall" in part:
                                call = part["functionCall"]
                                if not call.get("name") or not isinstance(call.get("args", {}), dict):
                                    raise ValueError("Invalid function call")
                                # Keep the exact opaque signature with its functionCall for subsequent rounds/restarts.
                                calls.append({"id": call.get("id") or f"gemini_{uuid4().hex}", "name": call["name"],
                                              "arguments": json.dumps(call.get("args", {}), ensure_ascii=False),
                                              "gemini_part": copy.deepcopy(part)})
                        finish = candidate.get("finishReason") or finish
            if finish is None:
                raise ProviderError(502, "Gemini 回复流提前结束，请重试。")
            if finish == "MAX_TOKENS" and calls:
                raise ProviderError(502, "Gemini 工具调用未生成完整，请重试。")
            if calls:
                yield "tool_calls", calls
            yield "finish", "length" if finish == "MAX_TOKENS" else "tool_calls" if calls else "stop"
        except ProviderError:
            raise
        except TRANSIENT_FAILURES as exc:
            raise _TransientStreamError(exc) from None
        except PROVIDER_FAILURES as exc:
            raise request_error(exc) from None
        except (ValueError, KeyError, IndexError, TypeError, AttributeError):
            raise ProviderError(502, "Gemini 原生响应格式无法解析，请检查接口配置。") from None

    async def complete_json_with_usage(self, messages: list[dict]) -> tuple[dict, dict | None]:
        url, headers = await self.endpoint("generateContent")
        try:
            async with httpx.AsyncClient(timeout=self.settings.llm_timeout_seconds, transport=self.transport,
                                         verify=shared_ssl_context()) as client:
                response = await client.post(url, headers=headers, json=native_payload(messages, structured=True))
        except PROVIDER_FAILURES as exc:
            raise request_error(exc) from None
        error = self.status_error(response.status_code)
        if error:
            raise error
        usage = None
        try:
            body = response.json()
            usage = native_usage(body)
            candidate = candidate_of(body)
            if candidate.get("finishReason") != "STOP":
                raise ValueError("Incomplete generation")
            text = "".join(part.get("text", "") for part in (candidate.get("content") or {}).get("parts", [])
                           if not part.get("thought"))
            result = json.loads(text)
            if not isinstance(result, dict):
                raise ValueError("Not an object")
            return result, usage
        except ProviderError:
            raise
        except (ValueError, KeyError, IndexError, TypeError, AttributeError):
            raise ProviderError(502, "Gemini 输出不是完整有效的 JSON 对象，请重试。", usage=usage) from None

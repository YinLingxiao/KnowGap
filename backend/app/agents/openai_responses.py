"""OpenAI Responses adapter for ChatGPT plan usage (OAuth), not Chat Completions."""

import json
from typing import AsyncIterator

import httpx

from app.agents.llm import ProviderError, request_error, shared_ssl_context, TRANSIENT_FAILURES, _TransientStreamError
from app.config import Settings

RESPONSES_URL = "https://api.openai.com/v1/responses"
USAGE_LIMIT = "subscription_sharing_usage_limit_exceeded"
PLAN_ERRORS = {
    "subscription_sharing_user_not_eligible": "当前 ChatGPT 账号或工作区不能使用套餐额度。",
    "subscription_sharing_usage_limit_exceeded": "ChatGPT 套餐额度已用完，请在 ChatGPT 设置 → 用量中查看或稍后再试。",
    "subscription_sharing_usage_unavailable": "暂时无法确认 ChatGPT 套餐额度，请稍后重试。",
    "subscription_sharing_unsupported_capability": "ChatGPT 套餐接口不支持当前请求的能力，请检查模型或输入。",
    "subscription_sharing_route_not_supported": "ChatGPT 套餐接口不支持当前调用方式。",
    "subscription_sharing_invalid_user": "ChatGPT 账号身份校验失败，请重新连接。",
    "subscription_sharing_user_unavailable": "ChatGPT 账号信息暂时不可用，请稍后重试。",
    "chatpass_v2_scope_not_authorized": "ChatGPT 套餐授权范围不足，请重新连接并同意套餐用量权限。",
    "chatpass_v2_invalid_authorization_context": "ChatGPT 套餐授权上下文无效，请重新连接。",
}


def is_chatgpt(settings: Settings) -> bool:
    return (settings.llm_auth_mode == "chatgpt"
            and settings.llm_base_url.strip().rstrip("/") == "https://api.openai.com/v1"
            and bool(settings.llm_model.strip()))


def _text_of(content) -> str:
    if isinstance(content, str):
        return content
    return "".join(item.get("text", "") for item in content or [] if isinstance(item, dict))


def input_items(messages: list[dict]) -> tuple[list[dict], str]:
    """Fold system/developer into instructions; explicit system items are rejected on this route."""
    systems, items = [], []
    for message in messages:
        role = message.get("role")
        if role in {"system", "developer"}:
            text = _text_of(message.get("content"))
            if text:
                systems.append(text)
            continue
        if role == "tool":
            items.append({"type": "function_call_output", "call_id": message.get("tool_call_id", ""),
                          "output": message.get("content", "")})
            continue
        if role == "assistant":
            text = _text_of(message.get("content"))
            if text:
                items.append({"role": "assistant", "content": text})
            for call in message.get("tool_calls") or []:
                function = call.get("function") or {}
                items.append({"type": "function_call", "call_id": call.get("id", ""),
                              "name": function.get("name", ""), "arguments": function.get("arguments") or "{}"})
            continue
        content = message.get("content")
        if isinstance(content, str):
            items.append({"role": "user", "content": content})
        else:
            parts = []
            for item in content or []:
                if item.get("type") == "text":
                    parts.append({"type": "input_text", "text": item["text"]})
                elif item.get("type") == "image_url":
                    url = item["image_url"]["url"]
                    parts.append({"type": "input_image", "image_url": url})
            if parts:
                items.append({"role": "user", "content": parts})
    return items, "\n\n".join(systems)


def response_tools(tools: list[dict] | None) -> list[dict]:
    result = []
    for tool in tools or []:
        function = tool.get("function") or {}
        if not function.get("name"):
            continue
        result.append({"type": "function", "name": function["name"],
                       "description": function.get("description", ""),
                       "parameters": function.get("parameters") or {"type": "object", "properties": {}}})
    return result


def response_usage(raw) -> dict | None:
    if not isinstance(raw, dict):
        return None
    inputs, outputs = raw.get("input_tokens"), raw.get("output_tokens")
    if type(inputs) is not int or type(outputs) is not int:
        return None
    result = {"prompt_tokens": inputs, "completion_tokens": outputs}
    details = raw.get("input_tokens_details")
    if isinstance(details, dict) and type(details.get("cached_tokens")) is int:
        result["prompt_tokens_details"] = {"cached_tokens": details["cached_tokens"]}
    return result


def _error_code(body) -> str:
    if not isinstance(body, dict):
        return ""
    error = body.get("error")
    if isinstance(error, dict):
        return str(error.get("code") or "")
    if isinstance(error, str):
        return error
    return ""


def _http_error(status: int, body, request_id: str = "") -> ProviderError:
    code = _error_code(body)
    suffix = f"（请求 ID：{request_id}）" if request_id else ""
    if code in PLAN_ERRORS:
        mapped = {
            USAGE_LIMIT: 402,
            "subscription_sharing_user_not_eligible": 403,
            "subscription_sharing_unsupported_capability": 400,
            "subscription_sharing_route_not_supported": 403,
            "subscription_sharing_invalid_user": 401,
            "subscription_sharing_usage_unavailable": 503,
            "subscription_sharing_user_unavailable": 503,
            "chatpass_v2_scope_not_authorized": 403,
            "chatpass_v2_invalid_authorization_context": 403,
        }.get(code, 502)
        return ProviderError(mapped, PLAN_ERRORS[code] + suffix)
    if status == 401:
        return ProviderError(401, "ChatGPT 身份或套餐权限校验失败，请重新连接。" + suffix)
    if status == 403:
        return ProviderError(403, "ChatGPT 套餐请求被拒绝，请检查账号、工作区或组织策略。" + suffix)
    if status == 429:
        return ProviderError(402, "ChatGPT 套餐请求过于频繁或额度不足，请稍后重试。" + suffix)
    if status == 503:
        return ProviderError(503, "ChatGPT 套餐路由暂时不可用，请稍后重试。" + suffix)
    return ProviderError(502, f"ChatGPT 套餐请求失败（HTTP {status}），请检查配置后重试。" + suffix)


def _stream_error(body, request_id: str = "") -> ProviderError:
    error = body.get("error") if isinstance(body, dict) else None
    code = str((error or {}).get("code") or "") if isinstance(error, dict) else ""
    message = PLAN_ERRORS.get(code) or "ChatGPT 在生成过程中返回错误，请稍后重试。"
    statuses = {
        USAGE_LIMIT: 402,
        "subscription_sharing_user_not_eligible": 403,
        "subscription_sharing_unsupported_capability": 400,
        "subscription_sharing_route_not_supported": 403,
        "subscription_sharing_invalid_user": 401,
        "subscription_sharing_usage_unavailable": 503,
        "subscription_sharing_user_unavailable": 503,
        "chatpass_v2_scope_not_authorized": 403,
        "chatpass_v2_invalid_authorization_context": 403,
    }
    status = statuses.get(code, 502)
    suffix = f"（请求 ID：{request_id}）" if request_id else ""
    return ProviderError(status, message + suffix)


class OpenAIResponsesChat:
    def __init__(self, settings: Settings, auth, transport: httpx.AsyncBaseTransport | None = None):
        self.settings = settings
        self.auth = auth
        self.transport = transport

    async def _token(self, force: bool = False) -> str:
        if self.auth is None:
            raise ProviderError(503, "ChatGPT 登录服务未初始化。")
        return await self.auth.access_token(force)

    async def stream(self, messages: list[dict], tools: list[dict] | None = None) -> AsyncIterator[tuple[str, object]]:
        if not is_chatgpt(self.settings):
            raise ProviderError(503, "ChatGPT 套餐配置无效，请检查地址、模型和认证方式。")
        for attempt in range(2):
            produced = False
            try:
                async for item in self._stream_once(messages, tools, force=attempt > 0):
                    produced = True
                    yield item
                return
            except _AuthRetry:
                if produced or attempt:
                    raise ProviderError(401, "ChatGPT 授权已失效，请重新连接。") from None
            except _TransientStreamError as exc:
                if produced or attempt:
                    raise request_error(exc.cause) from None

    async def _stream_once(self, messages: list[dict], tools, *, force: bool):
        token = await self._token(force)
        items, instructions = input_items(messages)
        payload = {"model": self.settings.llm_model.strip(), "input": items, "store": False, "stream": True}
        if instructions:
            payload["instructions"] = instructions
        if tool_specs := response_tools(tools):
            payload["tools"] = tool_specs
        timeout = httpx.Timeout(self.settings.llm_timeout_seconds, read=self.settings.llm_timeout_seconds)
        try:
            async with httpx.AsyncClient(timeout=timeout, transport=self.transport,
                                         verify=shared_ssl_context()) as client:
                async with client.stream("POST", RESPONSES_URL, json=payload,
                                         headers={"Authorization": f"Bearer {token}",
                                                  "Accept": "text/event-stream"}) as response:
                    request_id = response.headers.get("x-request-id", "")
                    if not response.is_success:
                        raw = await response.aread()
                        try:
                            body = json.loads(raw)
                        except (ValueError, TypeError):
                            body = None
                        if response.status_code == 401 and not force:
                            raise _AuthRetry()
                        raise _http_error(response.status_code, body, request_id)
                    if "text/event-stream" not in response.headers.get("content-type", ""):
                        body = json.loads(await response.aread())
                        async for item in self._from_body(body, request_id):
                            yield item
                        return
                    calls: dict[str, dict] = {}
                    completed = False
                    finish = "stop"
                    async for event, data in self._events(response):
                        kind = data.get("type") or event
                        if kind == "response.output_text.delta":
                            delta = data.get("delta")
                            if isinstance(delta, str) and delta:
                                yield "text", delta
                        elif kind in {"response.reasoning_summary_text.delta", "response.reasoning_text.delta"}:
                            delta = data.get("delta")
                            if isinstance(delta, str) and delta:
                                yield "reasoning", delta
                        elif kind == "response.output_item.added":
                            item = data.get("item") or {}
                            if item.get("type") == "function_call":
                                calls[item.get("id") or item.get("call_id") or ""] = {
                                    "id": item.get("call_id") or item.get("id") or "",
                                    "name": item.get("name") or "",
                                    "arguments": item.get("arguments") or "",
                                }
                        elif kind == "response.function_call_arguments.delta":
                            key = data.get("item_id") or ""
                            if key in calls and isinstance(data.get("delta"), str):
                                calls[key]["arguments"] += data["delta"]
                        elif kind == "response.function_call_arguments.done":
                            key = data.get("item_id") or ""
                            if key in calls and isinstance(data.get("arguments"), str):
                                calls[key]["arguments"] = data["arguments"]
                        elif kind == "response.output_item.done":
                            item = data.get("item") or {}
                            if item.get("type") == "function_call":
                                calls[item.get("id") or item.get("call_id") or ""] = {
                                    "id": item.get("call_id") or item.get("id") or "",
                                    "name": item.get("name") or "",
                                    "arguments": item.get("arguments") or "{}",
                                }
                        elif kind == "response.completed":
                            body = data.get("response") or {}
                            if usage := response_usage(body.get("usage")):
                                yield "usage", usage
                            for item in body.get("output") or []:
                                if isinstance(item, dict) and item.get("type") == "function_call":
                                    calls[item.get("call_id") or item.get("id") or ""] = {
                                        "id": item.get("call_id") or item.get("id") or "",
                                        "name": item.get("name") or "", "arguments": item.get("arguments") or "{}"}
                            completed = True
                            finish = "stop"
                        elif kind == "response.incomplete":
                            completed = True
                            finish = "length"
                        elif kind in {"response.failed", "error"}:
                            raise _stream_error(data.get("response") or data, request_id)
                    if not completed:
                        raise ProviderError(502, "ChatGPT 回复流提前结束，请重试。")
                    valid = [{"id": call["id"], "name": call["name"], "arguments": call["arguments"] or "{}"}
                             for call in calls.values() if call.get("name")]
                    if valid:
                        yield "tool_calls", valid
                    yield "finish", finish
        except ProviderError:
            raise
        except _AuthRetry:
            raise
        except TRANSIENT_FAILURES as exc:
            raise _TransientStreamError(exc) from None
        except httpx.RequestError as exc:
            raise request_error(exc) from None
        except (ValueError, KeyError, IndexError, TypeError, AttributeError):
            raise ProviderError(502, "ChatGPT 套餐响应格式无法解析，请检查接口兼容性。") from None

    async def _events(self, response):
        event = ""
        data_lines: list[str] = []
        async for line in response.aiter_lines():
            if line.startswith("event:"):
                event = line[6:].strip()
            elif line.startswith("data:"):
                data_lines.append(line[5:].lstrip())
            elif not line and data_lines:
                raw = "\n".join(data_lines)
                data_lines = []
                if raw and raw != "[DONE]":
                    try:
                        yield event, json.loads(raw)
                    except ValueError:
                        raise ProviderError(502, "ChatGPT 套餐流式响应无法解析。") from None
        if data_lines:
            raw = "\n".join(data_lines)
            if raw and raw != "[DONE]":
                yield event, json.loads(raw)

    async def _from_body(self, body: dict, request_id: str):
        if not isinstance(body, dict):
            raise ProviderError(502, "ChatGPT 套餐响应格式无法解析。")
        if body.get("status") == "failed":
            raise _stream_error(body, request_id)
        if usage := response_usage(body.get("usage")):
            yield "usage", usage
        calls = []
        for item in body.get("output") or []:
            if not isinstance(item, dict):
                continue
            if item.get("type") == "function_call":
                calls.append({"id": item.get("call_id") or item.get("id") or "",
                              "name": item.get("name") or "", "arguments": item.get("arguments") or "{}"})
            if item.get("type") == "message":
                for part in item.get("content") or []:
                    if part.get("type") == "output_text" and part.get("text"):
                        yield "text", part["text"]
        if calls:
            yield "tool_calls", calls
        yield "finish", "length" if body.get("status") == "incomplete" else "stop"

    async def complete_json(self, messages: list[dict]) -> dict:
        result, _ = await self.complete_json_with_usage(messages)
        return result

    async def complete_json_with_usage(self, messages: list[dict]) -> tuple[dict, dict | None]:
        if not is_chatgpt(self.settings):
            raise ProviderError(503, "ChatGPT 套餐配置无效，请检查地址、模型和认证方式。")
        items, instructions = input_items(messages)
        payload = {"model": self.settings.llm_model.strip(), "input": items, "store": False, "stream": True,
                   "text": {"format": {"type": "json_object"}}}
        if instructions:
            payload["instructions"] = instructions
        token = await self._token()
        timeout = httpx.Timeout(self.settings.llm_timeout_seconds, read=self.settings.llm_timeout_seconds)
        try:
            async with httpx.AsyncClient(timeout=timeout, transport=self.transport,
                                         verify=shared_ssl_context()) as client:
                async with client.stream("POST", RESPONSES_URL, json=payload,
                                         headers={"Authorization": f"Bearer {token}",
                                                  "Accept": "text/event-stream"}) as response:
                    request_id = response.headers.get("x-request-id", "")
                    if not response.is_success:
                        raw = await response.aread()
                        try:
                            body = json.loads(raw)
                        except ValueError:
                            body = None
                        raise _http_error(response.status_code, body, request_id)
                    text, usage, completed = [], None, False
                    async for event, data in self._events(response):
                        kind = data.get("type") or event
                        if kind == "response.output_text.delta" and data.get("delta"):
                            text.append(data["delta"])
                        elif kind == "response.completed":
                            body = data.get("response") or {}
                            usage = response_usage(body.get("usage"))
                            completed = True
                        elif kind in {"response.failed", "error"}:
                            raise _stream_error(data.get("response") or data, request_id)
                    if not completed:
                        raise ProviderError(502, "ChatGPT 回复流提前结束，请重试。")
                    raw_text = "".join(text).strip()
                    raw_text = raw_text.removeprefix("```json").removeprefix("```").removesuffix("```").strip()
                    result = json.loads(raw_text)
                    if not isinstance(result, dict):
                        raise ValueError("Not an object")
                    return result, usage
        except ProviderError:
            raise
        except httpx.RequestError as exc:
            raise request_error(exc) from None
        except (ValueError, KeyError, IndexError, TypeError, AttributeError):
            raise ProviderError(502, "ChatGPT 输出不是有效的 JSON 对象，请重试。") from None


class _AuthRetry(Exception):
    pass

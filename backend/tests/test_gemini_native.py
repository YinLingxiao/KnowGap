"""Native Vertex Express contract; no credentials or network calls in regression tests."""

import asyncio
import copy
import json

import httpx
import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr

from app.agents.gemini import GeminiNativeChat, native_payload, native_usage
from app.agents.llm import ChatCompletionsChat, ChatCompletionsTutor, ProviderError, is_vertex_native, openai_messages
from app.chat.usage import normalize_usage
from app.main import create_app
from tests.test_acceptance_support import isolated_settings
from tests.test_chat import send

BASE = "https://aiplatform.googleapis.com/v1/publishers/google/models"
KEY = "synthetic-native-key"
MESSAGES = [{"role": "system", "content": "用中文回答"}, {"role": "user", "content": "你好"}]
TOOL = {"type": "function", "function": {"name": "agenda_list", "description": "列出任务",
        "parameters": {"type": "object", "properties": {}}}}
USAGE = {"promptTokenCount": 100, "candidatesTokenCount": 12, "thoughtsTokenCount": 8,
         "cachedContentTokenCount": 40}


def config(tmp_path, **updates):
    return isolated_settings(tmp_path).model_copy(update={
        "llm_api_key": SecretStr(KEY), "llm_base_url": BASE, "llm_model": "gemini-4-argon", **updates,
    })


def packet(parts=(), *, reason="STOP", usage=None):
    candidate = {"content": {"role": "model", "parts": list(parts)}}
    if reason:
        candidate["finishReason"] = reason
    return {"candidates": [candidate], **({"usageMetadata": usage} if usage else {})}


def sse(*packets):
    text = ': heartbeat\n\ndata:\n\n' + ''.join(f'data: {json.dumps(body)}\n\n' for body in packets)
    return httpx.Response(200, text=text, headers={"content-type": "text/event-stream"})


def collect(tmp_path, handler, messages=None, tools=None, **updates):
    async def run():
        model = ChatCompletionsChat(config(tmp_path, **updates), httpx.MockTransport(handler))
        return [item async for item in model.stream(messages or MESSAGES, tools)]
    return asyncio.run(run())


@pytest.mark.parametrize("url,expected", [
    (BASE, True), (BASE + "/", True), (BASE.replace("/v1/", "/v1beta1/"), True),
    ("https://aiplatform.googleapis.com/v1/projects/test/locations/global/endpoints/openapi", False),
    (BASE.replace("googleapis.com", "googleapis.com.evil.test"), False),
    (BASE.replace("https:", "http:"), False), (BASE.replace(".com/", ".com:444/"), False),
])
def test_native_routing_is_specific(url, expected):
    assert is_vertex_native(url) is expected


def test_stream_uses_native_auth_system_contents_thoughts_and_usage(tmp_path):
    def handler(request):
        assert request.url.path.endswith("/gemini-4-argon:streamGenerateContent")
        assert dict(request.url.params) == {"alt": "sse"}
        assert request.headers["x-goog-api-key"] == KEY
        assert "authorization" not in request.headers and KEY not in str(request.url)
        body = json.loads(request.content)
        assert body["systemInstruction"] == {"parts": [{"text": "用中文回答"}]}
        assert body["contents"] == [{"role": "user", "parts": [{"text": "你好"}]}]
        assert body["generationConfig"]["thinkingConfig"]["includeThoughts"] is True
        assert "messages" not in body and "stream_options" not in body
        return sse(packet([{"text": "先思考", "thought": True}], reason=None),
                   packet([{"text": "你好"}], usage=USAGE))
    items = collect(tmp_path, handler)
    assert items[0] == ("reasoning", "先思考")
    assert ("text", "你好") in items and items[-1] == ("finish", "stop")
    raw = next(value for kind, value in items if kind == "usage")
    assert normalize_usage(raw) == {"input_tokens": 100, "output_tokens": 20, "cached_tokens": 40}


def test_parallel_tools_and_signatures_roundtrip_without_mutating_history(tmp_path):
    parts = [{"functionCall": {"name": "agenda_list", "args": {}, "id": "native-1"},
              "thoughtSignature": "opaque-signature"},
             {"functionCall": {"name": "agenda_list", "args": {"status": "done"}, "id": "native-2"}}]
    def handler(request):
        body = json.loads(request.content)
        declaration = body["tools"][0]["functionDeclarations"][0]
        assert declaration == {"name": "agenda_list", "description": "列出任务",
                               "parametersJsonSchema": TOOL["function"]["parameters"]}
        return sse(packet(parts))
    calls = next(value for kind, value in collect(tmp_path, handler, tools=[TOOL]) if kind == "tool_calls")
    assistant_calls = [{"id": call["id"], "type": "function", "function": {
        "name": call["name"], "arguments": call["arguments"]}, "gemini_part": call["gemini_part"]} for call in calls]
    history = [*MESSAGES, {"role": "assistant", "content": "", "tool_calls": assistant_calls},
               *[{"role": "tool", "tool_call_id": call["id"], "content": '{"tasks":[]}'} for call in calls]]
    original = copy.deepcopy(history)
    replay = native_payload(history)
    assert replay["contents"][-2] == {"role": "model", "parts": parts}
    assert replay["contents"][-1] == {"role": "user", "parts": [
        {"functionResponse": {"name": "agenda_list", "response": {"tasks": []}, "id": call["id"]}} for call in calls]}
    assert history == original
    assert "gemini_part" not in json.dumps(openai_messages(history))
    assert history == original


def test_generated_call_ids_are_not_sent_as_native_ids_and_old_tools_get_documented_fallback(tmp_path):
    part = {"functionCall": {"name": "agenda_list", "args": {}}, "thoughtSignature": "real"}
    calls = next(value for kind, value in collect(tmp_path, lambda _: sse(packet([part]))) if kind == "tool_calls")
    assert calls[0]["id"].startswith("gemini_")
    history = [*MESSAGES, {"role": "assistant", "content": "", "tool_calls": [{
        "id": "local", "function": {"name": "agenda_list", "arguments": "{}"}}]},
        {"role": "tool", "tool_call_id": "local", "content": "没有任务"}]
    replay = native_payload(history)["contents"]
    assert replay[-2]["parts"][0]["thoughtSignature"] == "skip_thought_signature_validator"
    assert replay[-1]["parts"][0]["functionResponse"] == {"name": "agenda_list", "response": {"result": "没有任务"}}


def test_native_image_parts_and_system_messages_are_converted():
    payload = native_payload([
        {"role": "system", "content": "规则"}, {"role": "system", "content": "上下文"},
        {"role": "user", "content": [{"type": "image_url", "image_url": {"url": "data:image/png;base64,aGVsbG8="}},
                                     {"type": "text", "text": "解释图片"}]},
    ], structured=True)
    assert payload["systemInstruction"]["parts"] == [{"text": "规则"}, {"text": "上下文"}]
    assert payload["contents"][0]["parts"] == [
        {"inlineData": {"mimeType": "image/png", "data": "aGVsbG8="}}, {"text": "解释图片"}]
    assert payload["generationConfig"] == {"responseMimeType": "application/json"}


def test_structured_json_and_tutor_use_native_protocol(tmp_path):
    result = {"assessment": "correct", "issue": None, "confidence": 0.9, "evidence": "后进先出", "reply": "正确。"}
    def handler(request):
        assert request.url.path.endswith("/gemini-4-argon:generateContent")
        assert request.headers["x-goog-api-key"] == KEY
        body = json.loads(request.content)
        assert body["generationConfig"] == {"responseMimeType": "application/json"}
        return httpx.Response(200, json=packet([{"text": "内部摘要", "thought": True},
                                               {"text": json.dumps(result)}], usage=USAGE))
    model = ChatCompletionsChat(config(tmp_path, llm_model="google/gemini-4-argon"), httpx.MockTransport(handler))
    assert asyncio.run(model.complete_json_with_usage(MESSAGES)) == (result, native_usage({"usageMetadata": USAGE}))
    tutor = ChatCompletionsTutor(config(tmp_path), httpx.MockTransport(handler))
    assert asyncio.run(tutor.generate({"current_answer": "栈是后进先出"})).reply == "正确。"
    with pytest.raises(ProviderError, match="证据未对应"):
        asyncio.run(tutor.generate({"current_answer": "不知道"}))


@pytest.mark.parametrize("body", [
    packet([{"text": "not JSON"}], usage=USAGE), packet([{"text": "[]"}], usage=USAGE),
    packet([{"text": '{"ok": true}'}], reason="MAX_TOKENS", usage=USAGE),
])
def test_invalid_or_truncated_json_is_not_success_and_preserves_reported_usage(tmp_path, body):
    model = ChatCompletionsChat(config(tmp_path), httpx.MockTransport(lambda _: httpx.Response(200, json=body)))
    with pytest.raises(ProviderError) as error:
        asyncio.run(model.complete_json(MESSAGES))
    assert error.value.status_code == 502
    assert normalize_usage(error.value.usage)["output_tokens"] == 20


@pytest.mark.parametrize("body", [packet(reason="SAFETY"), {"promptFeedback": {"blockReason": "SAFETY"}},
                                       {"error": {"message": KEY}}, {"candidates": []}])
def test_blocked_empty_and_error_responses_are_not_success(tmp_path, body):
    with pytest.raises(ProviderError) as error:
        collect(tmp_path, lambda _: sse(body))
    assert KEY not in error.value.detail


@pytest.mark.parametrize("status", [400, 401, 403, 429, 500])
def test_http_errors_are_redacted_and_do_not_retry(tmp_path, status):
    requests = []
    def handler(request):
        requests.append(request)
        return httpx.Response(status, json={"error": {"message": KEY}})
    with pytest.raises(ProviderError) as error:
        collect(tmp_path, handler)
    assert KEY not in error.value.detail and len(requests) == 1


def test_native_connect_failure_retries_only_before_output(tmp_path):
    attempts = []
    def handler(request):
        attempts.append(request)
        if len(attempts) == 1:
            raise httpx.ConnectError(KEY)
        return sse(packet([{"text": "OK"}]))
    assert collect(tmp_path, handler) == [("text", "OK"), ("finish", "stop")]
    assert len(attempts) == 2


def test_interrupted_stream_keeps_error_instead_of_silent_success(tmp_path):
    with pytest.raises(ProviderError, match="提前结束"):
        collect(tmp_path, lambda _: sse(packet([{"text": "部分答案"}], reason=None)))
    assert collect(tmp_path, lambda _: sse(packet([{"text": "部分答案"}], reason="MAX_TOKENS")))[-1] == ("finish", "length")


def test_usage_is_not_estimated_when_not_reported():
    assert native_usage({}) is None
    assert normalize_usage(native_usage({"usageMetadata": {"promptTokenCount": 10}})) is None
    assert normalize_usage(native_usage({"usageMetadata": {"promptTokenCount": 10, "candidatesTokenCount": 2}})) == {
        "input_tokens": 10, "output_tokens": 2, "cached_tokens": None}


def test_live_settings_selection_probe_and_persisted_tool_history_use_native_adapter(monkeypatch, tmp_path):
    requests = []
    signature = "opaque-private-reasoning-signature"
    def handler(request):
        body = json.loads(request.content)
        requests.append(body)
        assert request.headers["x-goog-api-key"] == KEY
        if request.url.path.endswith(":generateContent"):
            system = json.dumps(body.get("systemInstruction"), ensure_ascii=False)
            result = {"assessment": "correct", "issue": None, "confidence": 0.9,
                      "evidence": "栈遵循后进先出。", "reply": "正确。"} if "assessment, issue" in system else {}
            return httpx.Response(200, json=packet([{"text": json.dumps(result)}]))
        responses = [part for turn in body["contents"] for part in turn["parts"] if "functionResponse" in part]
        if not responses:
            return sse(packet([{"functionCall": {"name": "agenda_list", "args": {}}, "thoughtSignature": signature}]))
        assert any(part.get("thoughtSignature") == signature for turn in body["contents"] for part in turn["parts"])
        return sse(packet([{"text": "已查看任务。"}], usage=USAGE))
    original = GeminiNativeChat.__init__
    def init(self, settings, transport=None):
        original(self, settings, transport or httpx.MockTransport(handler))
    monkeypatch.setattr(GeminiNativeChat, "__init__", init)
    settings = isolated_settings(tmp_path)
    with TestClient(create_app(settings)) as client:
        body = {"base_url": BASE, "model": "gemini-4-argon", "api_key": KEY}
        probe = client.post("/api/ai/test", json=body)
        assert probe.status_code == 200, probe.text
        assert client.get("/api/ai/config").json()["configured"] is False
        saved = client.put("/api/ai/config", json=body)
        assert saved.status_code == 200 and KEY not in saved.text
        cid = client.post("/api/conversations", json={}).json()["id"]
        events = send(client, cid, "查看日程", "native-tool-history-001")
        assert not any(kind == "error" for kind, _ in events), events
        assert signature not in json.dumps(events)
    # Restart: signatures must survive in tool_messages, not just a Python in-memory cache.
    with TestClient(create_app(settings)) as client:
        assert client.get("/api/ai/config").json()["model"] == "gemini-4-argon"
        events = send(client, cid, "继续", "native-tool-history-002")
        assert not any(kind == "error" for kind, _ in events), events
        assert signature not in json.dumps(events)

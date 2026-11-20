"""OpenCode Go 需要每次请求都带稳定的 x-opencode-session，并用自己的 User-Agent。"""

import asyncio
import json

import httpx
from pydantic import SecretStr

from app.agents.llm import ChatCompletionsChat, opencode_session, provider_headers
from app.services.model_library import infer_preset
from tests.test_acceptance_support import isolated_settings

OPENCODE = "https://opencode.ai/inference/go/openai/v1"


def run(tmp_path, base_url, conversations):
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((request.url.path, dict(request.headers)))
        if json.loads(request.content).get("stream"):
            body = 'data: {"choices":[{"delta":{"content":"好"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
            return httpx.Response(200, text=body, headers={"content-type": "text/event-stream"})
        return httpx.Response(200, json={"choices": [{"message": {"content": "{}"}}]})

    settings = isolated_settings(tmp_path).model_copy(update={
        "llm_api_key": SecretStr("oc_sk_test"), "llm_base_url": base_url, "llm_model": "kimi-k3",
    })
    model = ChatCompletionsChat(settings, httpx.MockTransport(handler))

    async def go():
        for messages in conversations:
            [item async for item in model.stream(messages)]
            await model.complete_json(messages)
    asyncio.run(go())
    return seen


def test_opencode_requests_carry_a_stable_session_per_conversation(tmp_path):
    first = [{"role": "system", "content": "你是 KnowGap"}, {"role": "user", "content": "栈是什么"}]
    later = [*first, {"role": "assistant", "content": "后进先出"}, {"role": "user", "content": "那队列呢"}]
    other = [{"role": "system", "content": "你是 KnowGap"}, {"role": "user", "content": "讲讲哈希"}]
    seen = run(tmp_path, OPENCODE, [first, later, other])

    assert {path for path, _ in seen} == {"/inference/go/openai/v1/chat/completions"}
    sessions = [headers["x-opencode-session"] for _, headers in seen]
    assert all(s.startswith("ses_") for s in sessions)
    assert len(set(sessions[:4])) == 1, "the same conversation keeps one session id across turns and calls"
    assert sessions[4] != sessions[0], "a different conversation gets its own session id"
    assert all(headers["user-agent"].startswith("KnowGap/") for _, headers in seen)
    assert all(headers["authorization"] == "Bearer oc_sk_test" for _, headers in seen)


def test_other_providers_get_no_opencode_headers(tmp_path):
    seen = run(tmp_path, "https://api.deepseek.com/v1", [[{"role": "user", "content": "hi"}]])
    assert seen and all("x-opencode-session" not in headers for _, headers in seen)
    assert provider_headers("https://api.deepseek.com/v1", "k") == {"Authorization": "Bearer k"}
    assert "x-opencode-session" in provider_headers("https://api.opencode.ai/v1", "k")
    assert opencode_session(None) != opencode_session(None)


def test_opencode_go_url_is_recognised_as_a_preset():
    assert infer_preset(OPENCODE, "api_key") == ("opencode", "OpenCode Go")

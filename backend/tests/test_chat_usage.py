import asyncio
import json

import httpx
import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr

from app.agents.llm import ChatCompletionsChat
from app.chat.usage import normalize_usage
from app.main import create_app
from tests.test_acceptance_support import isolated_settings
from tests.test_chat import FakeChat, send


@pytest.mark.parametrize("raw,expected", [
    (None, None), ({"prompt_tokens": -1, "completion_tokens": 2}, None),
    ({"prompt_tokens": True, "completion_tokens": 2}, None),
    ({"prompt_tokens": 100, "completion_tokens": 10, "prompt_cache_hit_tokens": 40},
     {"input_tokens": 100, "output_tokens": 10, "cached_tokens": 40}),
    ({"prompt_tokens": 100, "completion_tokens": 10},
     {"input_tokens": 100, "output_tokens": 10, "cached_tokens": None}),
    ({"prompt_tokens": 100, "completion_tokens": 10, "prompt_cache_hit_tokens": 200},
     {"input_tokens": 100, "output_tokens": 10, "cached_tokens": None}),
])
def test_normalize_usage(raw, expected):
    assert normalize_usage(raw) == expected


@pytest.mark.parametrize("streaming", [True, False])
def test_provider_usage_including_empty_choices(tmp_path, streaming):
    raw_usage = {"prompt_tokens": 100, "completion_tokens": 12, "prompt_tokens_details": {"cached_tokens": 64}}
    def handler(request):
        assert json.loads(request.content)["stream_options"] == {"include_usage": True}
        if streaming:
            body = 'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n'
            body += f'data: {json.dumps({"choices": [], "usage": raw_usage})}\n\n'
            body += 'data: [DONE]\n\n'
            return httpx.Response(200, text=body, headers={"content-type": "text/event-stream"})
        return httpx.Response(200, json={"choices": [{"message": {"content": "hello"}}], "usage": raw_usage})
    settings = isolated_settings(tmp_path).model_copy(update={
        "llm_api_key": SecretStr("fake"), "llm_base_url": "https://example.test/v1", "llm_model": "test",
    })
    async def collect():
        return [item async for item in ChatCompletionsChat(settings, httpx.MockTransport(handler)).stream([])]
    items = asyncio.run(collect())
    assert ("usage", raw_usage) in items and ("text", "hello") in items


class UsageModel(FakeChat):
    async def stream(self, messages, tools=None):
        after_tool = messages[-1]["role"] == "tool"
        raw = {"prompt_tokens": 200 if after_tool else 100, "completion_tokens": 20 if after_tool else 10,
               "prompt_cache_hit_tokens": 80 if after_tool else 40}
        # A provider may repeat its final usage; one request must not be charged twice.
        yield "usage", raw
        yield "usage", raw
        if after_tool:
            yield "text", "回答。"
        else:
            yield "tool_calls", [{"id": "search", "name": "session_search", "arguments": '{"query":"术语"}'}]
        yield "finish", "stop"

    async def complete_json_with_usage(self, messages):
        return {}, {"prompt_tokens": 30, "completion_tokens": 3, "prompt_cache_hit_tokens": 0}


def test_usage_accumulates_and_survives_regeneration(tmp_path):
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=UsageModel())) as client:
        space = client.post("/api/subjects", json={"name": "学习"}).json()
        cid = space["main_conversation_id"]
        send(client, cid, "解释术语", "usage-request-001")
        url = f"/api/subjects/{space['id']}/usage"
        total = client.get(url).json()["total"]
        assert total == {"requests": 3, "reported_requests": 3, "input_tokens": 330,
                         "output_tokens": 33, "cached_tokens": 120}
        assert client.get(f"/api/conversations/{cid}/usage").json() == total
        client.post(f"/api/conversations/{cid}/regenerate")
        total = client.get(url).json()["total"]
        # Learning analysis already ran for this user input; regeneration adds two real model calls.
        assert total["requests"] == 5 and total["input_tokens"] == 630
        assert total["cached_tokens"] == 240
        assert client.get("/api/subjects/missing/usage").status_code == 404


def test_missing_usage_is_not_fabricated(tmp_path):
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=FakeChat(["你好"]))) as client:
        cid = client.post("/api/conversations", json={}).json()["id"]
        send(client, cid, "你好", "usage-missing-001")
        total = client.get(f"/api/conversations/{cid}/usage").json()
        assert total["requests"] == 2 and total["reported_requests"] == 0
        assert total["cached_tokens"] is None


@pytest.mark.parametrize("message,status", [
    ({"content": "not JSON"}, 502),
    ({"content": "[]"}, 502),
    ({}, 502),
    ({"content": json.dumps({"title": "总结", "summary": "问题是区分栈和队列。结论是栈后进先出。", "takeaways": []})}, 200),
], ids=["invalid-json", "non-object-json", "missing-content", "valid-json"])
@pytest.mark.parametrize("raw_usage,reported", [
    ({"prompt_tokens": 100, "completion_tokens": 20, "prompt_cache_hit_tokens": 40}, True),
    (None, False),
    ({"prompt_tokens": -1, "completion_tokens": 20}, False),
], ids=["reported", "missing-usage", "invalid-usage"])
def test_structured_reply_usage_is_independent_of_content_validation(tmp_path, message, status, raw_usage, reported):
    requests = []
    def handler(request):
        requests.append(request)
        body = {"choices": [{"message": message}]}
        if raw_usage is not None:
            body["usage"] = raw_usage
        return httpx.Response(200, json=body)

    settings = isolated_settings(tmp_path).model_copy(update={
        "llm_api_key": SecretStr("fake"), "llm_base_url": "https://example.test/v1", "llm_model": "test",
    })
    model = ChatCompletionsChat(settings, httpx.MockTransport(handler))
    with TestClient(create_app(settings, chat_model=model)) as client:
        space = client.post("/api/subjects", json={"name": "失败请求的用量"}).json()
        thread = client.post(f"/api/subjects/{space['id']}/threads", json={
            "client_request_id": "structured-usage-thread",
        }).json()
        response = client.post(f"/api/conversations/{thread['id']}/resolve/draft")
        assert response.status_code == status, response.text
        if status == 502:
            assert response.json() == {"detail": "模型输出不是有效的 JSON。"}
        else:
            assert response.json()["title"] == "总结"
        expected = {
            "requests": 1, "reported_requests": int(reported),
            "input_tokens": 100 if reported else 0, "output_tokens": 20 if reported else 0,
            "cached_tokens": 40 if reported else None,
        }
        assert client.get(f"/api/conversations/{thread['id']}/usage").json() == expected
        assert client.get(f"/api/subjects/{space['id']}/usage").json()["total"] == expected
        assert len(requests) == 1  # Accounting must neither retry nor duplicate a provider request.

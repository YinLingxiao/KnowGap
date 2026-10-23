import asyncio
import json

import httpx
from fastapi.testclient import TestClient
from pydantic import SecretStr

from app.agents.llm import ChatCompletionsChat
from app.main import create_app
from tests.test_acceptance_support import isolated_settings
from tests.test_chat import FakeChat, parse, send


def _settings(tmp_path):
    return isolated_settings(tmp_path).model_copy(update={
        "llm_api_key": SecretStr("fake"), "llm_base_url": "https://example.test/v1", "llm_model": "test",
    })


def _collect(tmp_path, handler):
    async def run():
        return [item async for item in ChatCompletionsChat(_settings(tmp_path), httpx.MockTransport(handler)).stream([])]
    return asyncio.run(run())


def test_streamed_reasoning_is_forwarded_for_both_provider_spellings(tmp_path):
    def handler(request):
        body = 'data: {"choices":[{"delta":{"reasoning_content":"先看题"}}]}\n\n'
        body += 'data: {"choices":[{"delta":{"reasoning":"再算"}}]}\n\n'
        body += 'data: {"choices":[{"delta":{"content":"答案"}}]}\n\n'
        body += 'data: [DONE]\n\n'
        return httpx.Response(200, text=body, headers={"content-type": "text/event-stream"})
    items = _collect(tmp_path, handler)
    assert [item for item in items if item[0] != "finish"] == [
        ("reasoning", "先看题"), ("reasoning", "再算"), ("text", "答案")]


def test_non_streamed_reasoning_is_forwarded(tmp_path):
    def handler(request):
        message = {"content": "答案", "reasoning_content": "想了想"}
        return httpx.Response(200, json={"choices": [{"message": message}]})
    items = _collect(tmp_path, handler)
    assert items[0] == ("reasoning", "想了想") and ("text", "答案") in items


def test_replies_without_reasoning_are_unchanged(tmp_path):
    def handler(request):
        body = 'data: {"choices":[{"delta":{"reasoning_content":null,"content":"好"}}]}\n\ndata: [DONE]\n\n'
        return httpx.Response(200, text=body, headers={"content-type": "text/event-stream"})
    assert [kind for kind, _ in _collect(tmp_path, handler)] == ["text", "finish"]


class ThinkingChat(FakeChat):
    async def stream(self, messages, tools=None):
        self.calls.append(messages)
        yield "reasoning", "先回忆定义，"
        yield "reasoning", "再举例。"
        yield "text", "栈是后进先出。"
        yield "finish", "stop"


def test_reasoning_is_streamed_stored_and_not_replayed_to_the_model(tmp_path):
    model = ThinkingChat()
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=model)) as client:
        cid = client.post("/api/conversations", json={}).json()["id"]
        events = send(client, cid, "什么是栈", "reasoning-request-001")
        names = [name for name, _ in events]
        assert names.index("reasoning") < names.index("delta")
        assert "".join(data["text"] for name, data in events if name == "reasoning") == "先回忆定义，再举例。"
        reply = [m for m in client.get(f"/api/conversations/{cid}").json()["messages"] if m["role"] == "assistant"][-1]
        assert reply["content"] == "栈是后进先出。" and reply["reasoning"] == "先回忆定义，再举例。"
        send(client, cid, "再讲一遍", "reasoning-request-002")
        assert len(model.calls) == 2
        assert "先回忆定义" not in json.dumps(model.calls[-1], ensure_ascii=False)


class FlakyChat(FakeChat):
    """第一次只返回思考、没有正文（个别模型偶发），第二次正常。"""

    def __init__(self, empties):
        super().__init__()
        self.empties = empties

    async def stream(self, messages, tools=None):
        self.calls.append(list(messages))  # 请求之后 messages 还会被服务端改动，留一份当时的快照
        if self.empties > 0:
            self.empties -= 1
            yield "reasoning", "想了很久"
            yield "finish", "stop"
            return
        yield "text", "这是正式回答。"
        yield "finish", "stop"


def test_an_empty_model_reply_is_retried_once_automatically(tmp_path):
    model = FlakyChat(empties=1)
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=model)) as client:
        cid = client.post("/api/conversations", json={}).json()["id"]
        events = send(client, cid, "讲一下栈", "empty-retry-001")
        assert not [name for name, _ in events if name == "error"]
        assert "".join(data["text"] for name, data in events if name == "delta") == "这是正式回答。"


def test_three_empty_replies_in_a_row_still_fail_clearly(tmp_path):
    model = FlakyChat(empties=3)
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=model)) as client:
        cid = client.post("/api/conversations", json={}).json()["id"]
        response = client.post(f"/api/conversations/{cid}/messages", json={"content": "讲一下栈", "client_request_id": "empty-retry-002"})
        errors = [data for name, data in parse(response.text) if name == "error"]
        assert errors and "空回复" in errors[0]["detail"]


def test_the_retry_after_an_empty_reply_carries_a_nudge_that_is_not_kept(tmp_path):
    model = FlakyChat(empties=1)
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=model)) as client:
        cid = client.post("/api/conversations", json={}).json()["id"]
        send(client, cid, "讲一下栈", "empty-retry-003")
        assert len(model.calls) >= 2
        retry_roles = [m["role"] for m in model.calls[1]]
        assert "上一次没有给出任何文字" in model.calls[1][-1]["content"] and retry_roles[-1] == "user"
        assert not any("上一次没有给出任何文字" in str(m.get("content")) for m in model.calls[0])
        stored = client.get(f"/api/conversations/{cid}").json()["messages"]
        assert not any("上一次没有给出任何文字" in m["content"] for m in stored)


def test_flatten_tool_history_turns_tool_turns_into_plain_text_without_mutating():
    from app.chat.service import flatten_tool_history
    original = [
        {"role": "user", "content": "做份 Word"},
        {"role": "assistant", "content": "", "tool_calls": [{"id": "c1", "type": "function", "function": {"name": "create_document", "arguments": "{}"}}]},
        {"role": "tool", "tool_call_id": "c1", "content": "已生成「a.docx」"},
    ]
    flat = flatten_tool_history(original)
    assert [m["role"] for m in flat] == ["user", "assistant", "user"]
    assert "create_document" in flat[1]["content"] and "已生成" in flat[2]["content"]
    assert all("tool_calls" not in m for m in flat) and "tool_calls" in original[1]

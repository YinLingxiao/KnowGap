"""Exercise context must support the current request without becoming that request."""

import asyncio
import json

import pytest
from fastapi.testclient import TestClient

from app.agent_tools import run as run_tool
from app.agent_tools.guard import ToolError
from app.chat.service import ToolContext
from app.chat.store import ChatStore
from app.main import create_app
from app.services.problems import PROBLEMS, reference_for
from tests.test_acceptance_support import isolated_settings
from tests.test_chat import FakeChat, context_of, send


def test_greeting_keeps_exercise_as_background_and_does_not_force_its_memories(tmp_path):
    model = FakeChat(["Hello! What would you like to talk about?"])
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=model)) as client:
        store = ChatStore(client.app.state.store)
        origin = store.create_conversation("demo-student-001", title=None, problem=None, client_request_id=None)
        evidence = store.add_user_message(origin, "栈是先进先出", "intent-evidence-001")
        store.record_observation(
            "demo-student-001", kind="misconception", topic="栈", topic_key="stack.lifo",
            summary="把出栈顺序当成先进先出", quote="栈是先进先出", reason="明确的错误陈述", signal="supports",
            related_id=None, conversation_id=origin, message_id=evidence,
        )
        conversation = client.post("/api/conversations", json={"problem_id": "stack-sequence-003"}).json()
        send(client, conversation["id"], "hi", "intent-greeting-001")
        messages = model.calls[0]
        context = context_of(messages)
        assert messages[-1] == {"role": "user", "content": "hi"}
        assert context["latest_user_message"] == "hi"
        assert context["active_exercise"]["id"] == "stack-sequence-003"
        assert "reference" not in context["active_exercise"]
        assert context["learner_memories"] == []
        assert all(set(item) == {"id", "title"} for item in context["available_exercises"])
        assert "仅为背景，不是本轮用户请求" in messages[-2]["content"]
        assert client.get(f"/api/conversations/{conversation['id']}").json()["active_problem_id"] == "stack-sequence-003"


@pytest.mark.parametrize("problem_id", ["stack-sequence-001", "stack-sequence-003"])
def test_explicit_exercise_request_can_fetch_checked_reference(tmp_path, problem_id):
    class ReferenceChat(FakeChat):
        async def stream(self, messages, tools=None):
            self.calls.append(messages)
            assert "exercise_reference" in {tool["function"]["name"] for tool in tools}
            if messages[-1]["role"] == "user":
                yield "tool_calls", [{"id": "checked-reference", "name": "exercise_reference", "arguments": "{}"}]
            else:
                reference = json.loads(messages[-1]["content"])
                assert reference == {"problem_id": problem_id, **reference_for(PROBLEMS[problem_id])}
                yield "text", "可以。" if reference["possible"] else "不可以。"
            yield "finish", "stop"

    with TestClient(create_app(isolated_settings(tmp_path), chat_model=ReferenceChat())) as client:
        conversation = client.post("/api/conversations", json={"problem_id": problem_id}).json()
        events = send(client, conversation["id"], "直接给我答案和操作过程", "intent-answer-001")
        result = next(data for name, data in events if name == "tool_end")
        assert result["name"] == "exercise_reference" and result["ok"] is True
        assert json.loads(result["output"])["possible"] == reference_for(PROBLEMS[problem_id])["possible"]
        assert not any(name == "error" for name, _ in events)


def test_reference_is_not_exposed_without_an_exercise(tmp_path):
    class NoExercise(FakeChat):
        async def stream(self, messages, tools=None):
            assert "exercise_reference" not in {tool["function"]["name"] for tool in tools}
            yield "text", "你好！"
            yield "finish", "stop"

    with TestClient(create_app(isolated_settings(tmp_path), chat_model=NoExercise())) as client:
        conversation = client.post("/api/conversations", json={}).json()
        send(client, conversation["id"], "你好", "intent-plain-001")


def test_reference_cannot_select_an_unrelated_exercise():
    async def scenario():
        ctx = ToolContext(None, None, "demo-student-001", "conversation")
        with pytest.raises(ToolError):
            await run_tool("exercise_reference", {}, ctx)
        ctx.exercise = PROBLEMS["stack-sequence-001"]
        with pytest.raises(ToolError):
            await run_tool("exercise_reference", {"problem_id": "stack-sequence-003"}, ctx)

    asyncio.run(scenario())

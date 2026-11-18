"""Approval timeouts must fail closed and clean up persisted state on Python 3.10."""

import asyncio

from app.chat import service as chat_service
from app.chat.service import ChatService, Generation
from app.chat.store import ChatStore
from app.memory.store import Store
from tests.test_chat import FakeChat

STUDENT = "demo-student-001"


def chat_store(tmp_path):
    base = Store(tmp_path / "chat.sqlite3")
    base.initialize()
    store = ChatStore(base)
    store.initialize()
    return store


def test_approval_times_out_and_cleans_up(tmp_path, monkeypatch):
    monkeypatch.setattr(chat_service, "APPROVAL_TIMEOUT_SECONDS", 0.05)

    class Settings:
        def agent_config(self):
            return {"auto_approve": False}

    async def scenario():
        store = chat_store(tmp_path)
        conversation = store.create_conversation(STUDENT, title=None, problem=None, client_request_id=None)
        user_id = store.add_user_message(conversation, "执行命令", "req-approval-timeout")
        assistant_id = store.start_reply(conversation, user_id, discard=[])
        service = ChatService(store, FakeChat, settings=Settings())
        generation = Generation(conversation, user_id, assistant_id)
        task = asyncio.create_task(service._await_approval(generation, "bash", '{"command":"echo timeout"}'))
        event, payload = await asyncio.wait_for(generation.queue.get(), 2)
        assert event == "tool_approval"
        # A placeholder id would make merge_meta a no-op and the cleanup assertions vacuous.
        pending = store.message_meta(assistant_id).get("pending_approval")
        assert pending and pending["id"] == payload["id"]
        assert await asyncio.wait_for(task, 2) is False
        assert service.approvals == {}
        assert store.message_meta(assistant_id).get("pending_approval") is None

    asyncio.run(scenario())
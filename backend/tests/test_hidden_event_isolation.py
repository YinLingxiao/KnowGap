"""Hidden system events stay in the coordinator transcript, and out of learner-facing reads."""

import asyncio
import json

from app.chat.cheatsheet import model_input
from app.chat.insights import subject_insights
from app.chat.store import is_system_event_row
from tests.test_chat import FakeChat
from tests.test_coordinator_wakeup import STUDENT, SYSTEM_PREFIX, WakeModel, settle, setup

EVENT = f"{SYSTEM_PREFIX}\n- 支线「链表」：已解决。隐藏事件不应进入学情。"
EVENT_META = {"system_event": {"type": "thread_report", "report_ids": ["report-1"], "thread_ids": ["thread-1"]}}


def add_text(store, conversation_id, role, content, *, meta=None, reply_to=None):
    with store.connection() as db:
        return store._insert(
            db, conversation_id, role=role, kind="text", content=content, status="complete",
            meta=meta, reply_to=reply_to,
        )


def test_cheatsheet_dialogue_excludes_system_events(tmp_path):
    store, _service, sid, main = setup(tmp_path, FakeChat())
    add_text(store, main, "user", "我分不清栈和队列")
    add_text(store, main, "assistant", "栈是后进先出，队列是先进先出。")
    add_text(store, main, "user", EVENT, meta=EVENT_META)
    add_text(store, main, "user", "再举一个队列的例子")
    assert any(is_system_event_row(row) for row in store.history(main))

    messages = model_input(store, None, STUDENT, subject_insights(store, STUDENT, sid), "")
    assert all("【系统事件" not in (item.get("content") or "") for item in messages)
    assert "我分不清栈和队列" in messages[-1]["content"]
    assert "再举一个队列的例子" in messages[-1]["content"]


class RecordingChat(FakeChat):
    def __init__(self):
        super().__init__(analyses=[{"summary": "早期学习者发言。"}])
        self.inputs = []

    async def complete_json(self, messages):
        self.inputs.append(messages)
        return await super().complete_json(messages)


def test_compression_excludes_events_from_the_latest_two_turns(tmp_path):
    async def scenario():
        model = RecordingChat()
        store, service, _sid, main = setup(tmp_path, model)
        add_text(store, main, "user", "早期问题")
        add_text(store, main, "assistant", "早期回复")
        add_text(store, main, "user", "第二问")
        add_text(store, main, "assistant", "第二答")
        add_text(store, main, "user", EVENT, meta=EVENT_META)
        add_text(store, main, "assistant", "可见回复")

        held = await service.compress_conversation(STUDENT, main, model=model)
        assert held["compressed_turns"] == 0 and held["up_to_seq"] == 0 and model.inputs == []

        add_text(store, main, "user", "第三问")
        add_text(store, main, "assistant", "第三答")
        add_text(store, main, "user", "第四问")
        add_text(store, main, "assistant", "第四答")
        folded = await service.compress_conversation(STUDENT, main, model=model)
        blob = json.dumps(model.inputs[-1], ensure_ascii=False)
        assert folded["compressed_turns"] == 5 and folded["up_to_seq"] == 6
        assert "【系统事件" not in blob
        assert "早期问题" in blob and "第二问" in blob
        assert "第三问" not in blob and "第四问" not in blob
    asyncio.run(scenario())


def test_analysis_recent_dialogue_excludes_system_events(tmp_path):
    async def scenario():
        model = WakeModel()
        store, service, _sid, main = setup(tmp_path, model)
        first = store.add_user_message(main, "栈和队列怎么区分", "ana-user-1")
        _ = [event async for event in service.events(service.begin(STUDENT, main, first, []))]
        await settle(service)
        add_text(store, main, "user", EVENT, meta=EVENT_META)
        add_text(store, main, "assistant", "这条回复学生看得到。")
        follow = store.add_user_message(main, "再讲讲递归", "ana-user-2")
        _ = [event async for event in service.events(service.begin(STUDENT, main, follow, []))]
        await settle(service)

        payload = next(item for item in model.analysis_calls if item.get("latest_user_message") == "再讲讲递归")
        recent = json.dumps(payload["recent_dialogue"], ensure_ascii=False)
        assert "【系统事件" not in recent
        assert "【系统事件" not in json.dumps(payload, ensure_ascii=False)
        assert "栈和队列怎么区分" in recent
        transcript = [item for item in model.calls[-1] if item.get("role") == "user"]
        assert any((item.get("content") or "").startswith(SYSTEM_PREFIX) for item in transcript)
        await service.close()
    asyncio.run(scenario())

"""Hidden system events stay in the coordinator transcript, and out of learner-facing reads."""

import asyncio
import json

import app.chat.service as service_module
from app.chat.cheatsheet import model_input
from app.chat.insights import subject_insights
from app.chat.store import is_system_event_row
from app.memory.store import new_id, now
from tests.test_chat import FakeChat
from tests.test_coordinator_wakeup import STUDENT, SYSTEM_PREFIX, WakeModel, reports, settle, setup

EVENT = f"{SYSTEM_PREFIX}\n- 支线「链表」：已解决。隐藏事件不应进入学情。"
EVENT_META = {"system_event": {"type": "thread_report", "report_ids": ["report-1"], "thread_ids": ["thread-1"]}}


def add_text(store, conversation_id, role, content, *, meta=None, reply_to=None, status="complete"):
    with store.connection() as db:
        return store._insert(
            db, conversation_id, role=role, kind="text", content=content, status=status,
            meta=meta, reply_to=reply_to,
        )


def add_report(store, main_id, thread_id, source_id, event_id):
    with store.connection() as db:
        report_id = new_id("report")
        db.execute(
            "INSERT INTO thread_reports(id, main_id, thread_id, source_message_id, outcome, summary, state, "
            "delivered_event_id, delivered_at, attempts, not_before, created_at) "
            "VALUES (?, ?, ?, ?, 'resolved', '已讲完', 'delivered', ?, ?, 0, NULL, ?)",
            (report_id, main_id, thread_id, source_id, event_id, now(), now()),
        )
        return report_id


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


def test_message_count_excludes_kept_events_and_ignores_deleted_ones(tmp_path):
    store, _service, sid, main = setup(tmp_path, FakeChat())
    with store.connection() as db:
        index = db.execute(
            "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_thread_reports_main'",
        ).fetchone()
    assert index is not None and "main_id" in index["sql"] and "state" in index["sql"]

    thread_id = store.create_thread(
        STUDENT, sid, title="链表", anchor_message_id=None, client_request_id="count-thread",
    )
    user = add_text(store, main, "user", "栈和队列怎么区分")
    assistant = add_text(store, main, "assistant", "栈是后进先出。", reply_to=user)
    assert _count_and_preview(store, main) == (2, "栈是后进先出。")

    kept = add_text(store, main, "user", EVENT, meta=EVENT_META)
    add_report(store, main, thread_id, user, kept)
    assert _count_and_preview(store, main) == (2, "栈是后进先出。")

    add_text(store, main, "assistant", "要不要再练一次？", reply_to=kept)
    assert _count_and_preview(store, main) == (3, "要不要再练一次？")

    ghost = add_text(store, main, "user", EVENT, meta=EVENT_META)
    add_report(store, main, thread_id, assistant, ghost)
    assert _count_and_preview(store, main) == (3, "要不要再练一次？")
    with store.connection() as db:
        db.execute("DELETE FROM conversation_messages WHERE id = ?", (ghost,))
    conversation = store.conversation(main, STUDENT)
    assert conversation.message_count == 3 and len(conversation.messages) == 4
    assert conversation.preview == "要不要再练一次？" and "【系统事件" not in conversation.preview


def _count_and_preview(store, main):
    conversation = store.conversation(main, STUDENT)
    return conversation.message_count, conversation.preview


def test_recover_skips_finished_replies_and_deleted_events(tmp_path, monkeypatch):
    monkeypatch.setattr(service_module, "WAKE_QUIET_SECONDS", 1000)

    async def scenario():
        store, service, sid, main = setup(tmp_path, WakeModel(), name="delivered.sqlite3")
        thread_id = store.create_thread(
            STUDENT, sid, title="链表", anchor_message_id=None, client_request_id="delivered-thread",
        )
        source_a = add_text(store, main, "user", "第一个来源")
        source_b = add_text(store, main, "user", "第二个来源")
        event = add_text(store, main, "user", EVENT, meta=EVENT_META)
        reply = add_text(store, main, "assistant", "完整回复", reply_to=event)
        add_report(store, main, thread_id, source_a, event)
        add_report(store, main, thread_id, source_b, event)

        found = store.delivered_events()
        assert found == [{"event_id": event, "reply_id": reply, "reply_status": "complete"}]
        assert set(found[0]) == {"event_id", "reply_id", "reply_status"}
        service.recover()
        assert [row["state"] for row in reports(store)] == ["delivered", "delivered"]
        assert any(message.id == event for message in store.conversation(main, STUDENT).messages)

        source_c = add_text(store, thread_id, "assistant", "支线上的失败回复")
        interrupted = add_text(store, main, "user", EVENT, meta=EVENT_META)
        streaming = add_text(store, main, "assistant", "", reply_to=interrupted, status="streaming")
        add_report(store, main, thread_id, source_c, interrupted)
        assert {item["event_id"] for item in store.delivered_events()} == {event, interrupted}
        service.recover()
        restored = next(row for row in reports(store) if row["source_message_id"] == source_c)
        assert restored["state"] == "pending" and restored["attempts"] == 1
        assert all(row["state"] == "delivered" for row in reports(store) if row["id"] != restored["id"])
        left = store.conversation(main, STUDENT).messages
        assert all(message.id not in {interrupted, streaming} for message in left)

        source_d = add_text(store, thread_id, "user", "已删除事件的来源")
        gone = add_text(store, main, "user", EVENT, meta=EVENT_META)
        add_report(store, main, thread_id, source_d, gone)
        with store.connection() as db:
            db.execute("DELETE FROM conversation_messages WHERE id = ?", (gone,))
        assert all(item["event_id"] != gone for item in store.delivered_events())
        service.recover()
        dangling = next(row for row in reports(store) if row["source_message_id"] == source_d)
        assert dangling["state"] == "delivered" and dangling["delivered_event_id"] == gone
        assert any(message.id == event for message in store.conversation(main, STUDENT).messages)
        await service.close()
    asyncio.run(scenario())

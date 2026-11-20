"""B5: memory_write events and single-note revocation, fully offline."""

import asyncio
import json
from types import SimpleNamespace

from fastapi.testclient import TestClient

from app.chat.service import ChatService
from app.chat.store import ChatStore
from app.chat.streaming import EventJournal
from app.main import create_app
from app.memory.curated import SEP, MemoryWriteItem
from app.memory.store import Store
from tests.test_acceptance_support import isolated_settings
from tests.test_chat import FakeChat


STUDENT = "demo-student-001"


def make_store(tmp_path, name="notes"):
    base = Store(tmp_path / f"{name}.sqlite3")
    base.initialize()
    store = ChatStore(base)
    store.initialize()
    return store


def write_logs(store, student_id=STUDENT):
    with store.connection() as db:
        rows = db.execute(
            "SELECT id, student_id, layer, content, conversation_id, message_id, created_at "
            "FROM memory_write_log WHERE student_id = ? ORDER BY created_at, id",
            (student_id,),
        ).fetchall()
        return [dict(row) for row in rows]


def test_initialize_is_idempotent_and_preserves_existing_notes(tmp_path):
    store = make_store(tmp_path)
    store.apply_agent_memory(STUDENT, "add", "user", "喜欢先看例题", None)
    before = store.agent_notes(STUDENT)
    store.initialize()
    store.initialize()
    assert store.agent_notes(STUDENT) == before
    with store.connection() as db:
        columns = [row[1] for row in db.execute("PRAGMA table_info(memory_write_log)").fetchall()]
    assert columns == ["id", "student_id", "layer", "content", "conversation_id", "message_id", "created_at"]
    assert len(write_logs(store)) == 1


def test_apply_appends_event_item_and_keeps_model_wording(tmp_path):
    store = make_store(tmp_path)
    events: list[MemoryWriteItem] = []
    result = store.apply_agent_memory(
        STUDENT, "add", "user", "偏好先看例题再看定义", None,
        conversation_id="conv-b5", message_id="msg-b5", events=events,
    )
    assert result.startswith("已更新用户（")
    assert result.endswith("写入在下一轮对话里生效。")
    assert len(events) == 1
    item = events[0]
    assert set(item) == {"id", "layer", "content"}
    assert item["layer"] == "USER"
    assert item["content"] == "偏好先看例题再看定义"

    logs = write_logs(store)
    assert len(logs) == 1
    log = logs[0]
    assert log["id"] == item["id"]
    assert log["student_id"] == STUDENT
    assert log["layer"] == "user"
    assert log["content"] == item["content"]
    assert (log["conversation_id"], log["message_id"]) == ("conv-b5", "msg-b5")
    assert log["created_at"]

    # patch 记录新内容并映射 MEMORY；重复与 remove 不产生新日志或事件。
    patched = store.apply_agent_memory(
        STUDENT, "add", "memory", "旧结论", None, events=events,
    )
    assert patched.startswith("已更新笔记（")
    result = store.apply_agent_memory(
        STUDENT, "patch", "memory", "新结论", "旧结论", events=events,
    )
    assert result.startswith("已更新笔记（")
    assert events[-1]["layer"] == "MEMORY" and events[-1]["content"] == "新结论"
    assert store.agent_notes(STUDENT)["memory"] == "新结论"

    before = len(write_logs(store))
    assert store.apply_agent_memory(STUDENT, "add", "user", "偏好先看例题再看定义", None, events=events) == "已存在。"
    assert "没有找到" in store.apply_agent_memory(STUDENT, "patch", "user", "任意", "不存在", events=events)
    assert store.apply_agent_memory(STUDENT, "remove", "memory", "", "新结论", events=events).startswith("已更新笔记（")
    assert store.agent_notes(STUDENT)["memory"] == ""
    assert len(write_logs(store)) == before  # 重复、未命中、remove 均不新增日志。
    assert len(events) == 3  # add user + add memory + patch memory 共三条，之后无新增。


class ReviewChat(FakeChat):
    def __init__(self, ops):
        super().__init__(["好。"])
        self.ops = ops

    async def complete_json(self, messages):
        if "复盘" in messages[0]["content"]:
            return {"ops": self.ops}
        return {}


def run_review(store, model, conversation_id, generation):
    service = ChatService(store, lambda: model)

    async def scenario():
        await service._review(STUDENT, model, [], conversation_id, "msg-review", generation=generation)
        await service.close()

    asyncio.run(scenario())


def test_review_queues_memory_write_with_written_items_only(tmp_path):
    store = make_store(tmp_path)
    conversation = store.create_conversation(STUDENT, title=None, problem=None, client_request_id="conv-b5-event")
    journal = EventJournal(conversation, "run-b5")
    generation = SimpleNamespace(queue=journal)
    model = ReviewChat([
        {"action": "add", "target": "memory", "content": "资料在 notes 目录", "old_text": ""},
        {"action": "add", "target": "memory", "content": "资料在 notes 目录", "old_text": ""},
    ])
    run_review(store, model, conversation, generation)

    writes = [(kind, json.loads(data)) for kind, data in journal.events if kind == "memory_write"]
    assert len(writes) == 1
    payload = writes[0][1]
    assert set(payload) == {"items"}
    assert len(payload["items"]) == 1  # 重复操作被过滤，不进入事件。
    item = payload["items"][0]
    assert set(item) == {"id", "layer", "content"}
    assert item["layer"] == "MEMORY" and item["content"] == "资料在 notes 目录"
    logs = write_logs(store)
    assert [log["id"] for log in logs] == [item["id"]]
    assert {(log["conversation_id"], log["message_id"]) for log in logs} == {(conversation, "msg-review")}
    assert store.agent_notes(STUDENT)["memory"] == "资料在 notes 目录"


def test_review_without_writes_or_online_generation_stays_silent(tmp_path):
    store = make_store(tmp_path)
    conversation = store.create_conversation(STUDENT, title=None, problem=None, client_request_id="conv-b5-empty")
    journal = EventJournal(conversation, "run-b5-empty")
    generation = SimpleNamespace(queue=journal)
    model = ReviewChat([{"action": "remove", "target": "memory", "content": "", "old_text": "不存在"}])
    run_review(store, model, conversation, generation)
    assert journal.events == []
    assert write_logs(store) == []

    online = EventJournal(conversation, "run-b5-offline")
    model = ReviewChat([{"action": "add", "target": "user", "content": "离线也记日志", "old_text": ""}])
    run_review(store, model, conversation, None)
    assert online.events == []
    logs = write_logs(store)
    assert len(logs) == 1 and logs[0]["content"] == "离线也记日志"
    assert store.revoke_agent_memory(STUDENT, logs[0]["id"]) is True


def app_store(settings):
    """Open a ChatStore after create_app has initialized the full schema."""
    store = ChatStore(Store(settings.resolved_database_path()))
    store.initialize()
    return store


def test_delete_revokes_exact_entry_and_log_then_repeat_is_404(tmp_path):
    settings = isolated_settings(tmp_path)
    with TestClient(create_app(settings, chat_model=FakeChat())) as client:
        store = app_store(settings)
        events: list[MemoryWriteItem] = []
        store.apply_agent_memory(STUDENT, "add", "user", "项目代号是蓝鲸", None, events=events)
        store.apply_agent_memory(STUDENT, "add", "user", "项目代号", None, events=events)
        store.apply_agent_memory(STUDENT, "add", "user", "旧项目代号", None, events=events)
        target = events[1]["id"]

        response = client.delete(f"/api/agent-memory/{target}")
        assert response.status_code == 204
        assert response.content == b""
        assert store.agent_notes(STUDENT)["user"] == SEP.join(["项目代号是蓝鲸", "旧项目代号"])
        assert [log["id"] for log in write_logs(store)] == [events[0]["id"], events[2]["id"]]

        repeat = client.delete(f"/api/agent-memory/{target}")
        assert repeat.status_code == 404
        assert repeat.json() == {"detail": "记忆条目不存在"}
        assert store.agent_notes(STUDENT)["user"] == SEP.join(["项目代号是蓝鲸", "旧项目代号"])
        assert len(write_logs(store)) == 2


def test_delete_fabricated_and_other_students_ids_are_the_same_404(tmp_path):
    settings = isolated_settings(tmp_path)
    with TestClient(create_app(settings, chat_model=FakeChat())) as client:
        store = app_store(settings)
        events: list[MemoryWriteItem] = []
        store.apply_agent_memory(STUDENT, "add", "user", "只属于演示学生", None, events=events)
        note_id = events[0]["id"]
        before_notes = store.agent_notes(STUDENT)

        missing = client.delete("/api/agent-memory/note-does-not-exist")
        assert missing.status_code == 404
        assert missing.json() == {"detail": "记忆条目不存在"}

        other_events: list[MemoryWriteItem] = []
        store.apply_agent_memory("other-student", "add", "user", "只属于他人", None, events=other_events)
        other = client.delete(f"/api/agent-memory/{other_events[0]['id']}")
        assert other.status_code == 404
        assert other.json() == missing.json()

        # 越权与编造均未产生副作用；本人仍可正常撤销。
        assert store.agent_notes("other-student")["user"] == "只属于他人"
        assert store.agent_notes(STUDENT) == before_notes
        assert client.delete(f"/api/agent-memory/{note_id}").status_code == 204
        assert store.agent_notes(STUDENT)["user"] == ""

def test_profile_record_queues_memory_write_for_direct_user_notes(tmp_path):
    store = make_store(tmp_path)
    conversation = store.create_conversation(STUDENT, title=None, problem=None, client_request_id="conv-b5-profile")
    journal = EventJournal(conversation, "run-b5-profile")
    generation = SimpleNamespace(queue=journal, conversation_id=conversation)
    service = ChatService(store, lambda: FakeChat(["好。"]))
    ops = [
        {"layer": "Context", "content": "下周三考数据结构"},
        {"layer": "Preference", "content": "先举例再讲定义"},
    ]
    service._record_profile(STUDENT, ops, "msg-profile", generation=generation)
    asyncio.run(service.close())

    writes = [json.loads(data) for kind, data in journal.events if kind == "memory_write"]
    assert len(writes) == 1
    items = writes[0]["items"]
    assert [item["layer"] for item in items] == ["USER"]  # 偏好走确认弹窗，不直接写入。
    assert "下周三考数据结构" in items[0]["content"]
    logs = write_logs(store)
    assert [(log["id"], log["conversation_id"], log["message_id"]) for log in logs] == [
        (items[0]["id"], conversation, "msg-profile"),
    ]


def test_memory_tool_reports_written_items_through_context(tmp_path):
    from app.agent_tools import run as run_tool

    store = make_store(tmp_path)
    seen = []
    ctx = SimpleNamespace(
        store=store, student_id=STUDENT, conversation_id="conv-tool", assistant_message_id="msg-tool",
        approve_memory=False, on_memory_write=seen.append,
    )
    asyncio.run(run_tool("memory", {"action": "add", "target": "memory", "content": "实验报告周五交"}, ctx))
    assert len(seen) == 1 and seen[0][0]["content"] == "实验报告周五交" and seen[0][0]["layer"] == "MEMORY"
    asyncio.run(run_tool("memory", {"action": "remove", "target": "memory", "old_text": "实验报告周五交"}, ctx))
    assert len(seen) == 1  # 删除不推送写入事件。

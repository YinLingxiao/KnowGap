"""The tutor can read, add and reschedule agenda items through tools, scoped to the learner."""

import asyncio
import json

import pytest
from fastapi.testclient import TestClient

from app.agent_tools import DEFINITIONS, run as run_tool
from app.agent_tools.guard import ToolError
from app.chat.service import ToolContext
from app.chat.store import ChatStore
from app.main import create_app
from app.memory.store import Store
from app.services.materials import MaterialStore
from tests.test_acceptance_support import isolated_settings
from tests.test_chat import FakeChat, send

STUDENT = "demo-student-001"


def ctx_for(tmp_path, student=STUDENT, subject=True):
    base = Store(tmp_path / "chat.sqlite3")
    base.initialize()
    MaterialStore(base).initialize()
    store = ChatStore(base)
    store.initialize()
    if subject:
        space = store.create_subject(student, "数据结构", "", "")
        conversation = space.main_conversation_id
    else:
        conversation = store.create_conversation(student, title=None, problem=None, client_request_id=None)
    return ToolContext(None, store, student, conversation), store


def call(name, arguments, ctx):
    return json.loads(asyncio.run(run_tool(name, arguments, ctx)))


def test_add_plan_with_parent_lands_in_current_space_and_lists(tmp_path):
    ctx, store = ctx_for(tmp_path)
    result = call("agenda_add", {
        "parent_title": "一周搞定二叉树", "parent_deadline_date": "2026-10-30",
        "tasks": [
            {"title": "中序遍历手推 3 道", "scheduled_start_at": "2026-10-22T15:00", "duration_minutes": 45, "priority": 1},
            {"title": "整理遍历笔记", "scheduled_date": "2026-10-23"},
        ],
    }, ctx)
    assert result["added"] == 3 and result["parent"]["deadline_date"] == "2026-10-30"
    first = result["tasks"][0]
    assert first["scheduled_date"] == "2026-10-22" and first["parent_id"] == result["parent"]["id"]
    subject = store.conversation_subject(ctx.conversation_id)
    assert all(task["subject_id"] == subject.id for task in result["tasks"])

    listed = call("agenda_list", {"days": 60}, ctx)
    assert {task["title"] for task in listed["tasks"]} >= {"一周搞定二叉树", "中序遍历手推 3 道", "整理遍历笔记"}


def test_update_reschedules_and_completes_but_not_other_students_tasks(tmp_path):
    ctx, store = ctx_for(tmp_path)
    added = call("agenda_add", {"tasks": [{"title": "复习哈希冲突", "scheduled_date": "2026-10-22"}]}, ctx)
    task_id = added["tasks"][0]["id"]
    moved = call("agenda_update", {"task_id": task_id, "scheduled_start_at": "2026-10-24T10:00"}, ctx)
    assert moved["updated"]["scheduled_date"] == "2026-10-24"
    done = call("agenda_update", {"task_id": task_id, "status": "done"}, ctx)
    assert done["updated"]["status"] == "done"

    other = ToolContext(None, store, "someone-else", ctx.conversation_id)
    with pytest.raises(ToolError):
        asyncio.run(run_tool("agenda_update", {"task_id": task_id, "status": "open"}, other))


def test_invalid_input_is_reported_to_the_model(tmp_path):
    ctx, _ = ctx_for(tmp_path, subject=False)
    with pytest.raises(ToolError, match="无效"):
        asyncio.run(run_tool("agenda_add", {"tasks": [{"title": "x", "scheduled_date": "下周三"}]}, ctx))
    with pytest.raises(ToolError):
        asyncio.run(run_tool("agenda_add", {"tasks": []}, ctx))
    plain = call("agenda_add", {"tasks": [{"title": "不在空间里的任务"}]}, ctx)
    assert "subject_id" not in plain["tasks"][0]


def test_tools_are_registered():
    names = {tool["function"]["name"] for tool in DEFINITIONS}
    assert {"agenda_list", "agenda_add", "agenda_update"} <= names


def test_tools_write_update_clear_and_validate_reminders(tmp_path):
    ctx, store = ctx_for(tmp_path)
    result = call("agenda_add", {"tasks": [{"title": "提醒", "scheduled_start_at": "2026-10-22T10:00",
                                         "reminder_minutes": 0}]}, ctx)
    task = result["tasks"][0]
    assert task["reminder_minutes"] == 0
    updated = call("agenda_update", {"task_id": task["id"], "reminder_minutes": 15}, ctx)
    assert updated["updated"]["reminder_minutes"] == 15
    with store.connection() as db:
        assert db.execute("SELECT reminder_minutes FROM agenda_tasks WHERE id=?", (task["id"],)).fetchone()[0] == 15
    cleared = call("agenda_update", {"task_id": task["id"], "reminder_minutes": None}, ctx)
    assert cleared["updated"]["reminder_minutes"] is None
    for value in (1, True, "5"):
        with pytest.raises(ToolError):
            call("agenda_add", {"tasks": [{"title": "坏提醒", "reminder_minutes": value}]}, ctx)
        with pytest.raises(ToolError):
            call("agenda_update", {"task_id": task["id"], "reminder_minutes": value}, ctx)


class PlanningChat(FakeChat):
    async def stream(self, messages, tools=None):
        self.calls.append(messages)
        self.tool_names = [tool["function"]["name"] for tool in tools or []]
        if len(self.calls) == 1:
            yield "tool_calls", [{"id": "plan-1", "name": "agenda_add", "arguments": json.dumps(
                {"tasks": [{"title": "明天下午复习栈", "scheduled_start_at": "2026-10-22T15:00"}]}, ensure_ascii=False)}]
            yield "finish", "tool_calls"
        else:
            yield "text", "已经排进明天下午。"
            yield "finish", "stop"


def test_chat_turn_creates_agenda_task_visible_in_agenda_api(tmp_path):
    model = PlanningChat()
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=model)) as client:
        conversation = client.post("/api/conversations", json={}).json()
        events = send(client, conversation["id"], "明天下午提醒我复习栈", "req-00000001")
        done = next(data for name, data in events if name == "done")
        call_view = done["message"]["tool_calls"][0]
        assert call_view["name"] == "agenda_add" and call_view["ok"]
        tasks = client.get("/api/agenda/tasks").json()["tasks"]
        assert [task["title"] for task in tasks] == ["明天下午复习栈"]
    assert "agenda_add" in model.tool_names

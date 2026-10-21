"""Agenda tools: let the tutor read, add and reschedule the learner's own agenda items.

Writes go through the same validation and ownership checks as /api/agenda, so the model can
never touch another learner's tasks or invent ids that escape to the client.
"""

import json
from datetime import date, timedelta

from fastapi import HTTPException
from pydantic import ValidationError

from app.agenda import store as agenda
from app.agenda.schemas import TaskCreate, TaskPatch
from app.agent_tools.guard import ToolError

LIST_TOOL = "agenda_list"
ADD_TOOL = "agenda_add"
UPDATE_TOOL = "agenda_update"
NAMES = {LIST_TOOL, ADD_TOOL, UPDATE_TOOL}

_TASK_FIELDS = {
    "title": {"type": "string", "description": "具体可执行的任务，如「手推二叉树中序遍历 3 道」"},
    "scheduled_date": {"type": "string", "description": "计划哪天做，YYYY-MM-DD；按 turn_context.today 推算相对日期"},
    "scheduled_start_at": {"type": "string", "description": "计划几点开始，本地时间 YYYY-MM-DDTHH:MM；不需要具体时刻就省略"},
    "duration_minutes": {"type": "integer", "description": "预计时长，5~720 分钟"},
    "deadline_date": {"type": "string", "description": "硬截止日（考试/交作业），YYYY-MM-DD，与计划日期独立"},
    "priority": {"type": "integer", "description": "1 最高 ~ 4 普通，默认 4"},
    "notes": {"type": "string", "description": "可选的备注，例如要复习的误区或题号"},
}

DEFINITIONS = [
    {
        "type": "function",
        "function": {
            "name": LIST_TOOL,
            "description": "查看学习者日程里未完成的任务（含逾期和未安排日期的），排期前先看一眼避免撞车，或回答「我明天要做什么」。",
            "parameters": {"type": "object", "properties": {
                "days": {"type": "integer", "description": "从今天起看几天，默认 7，最多 60"},
            }, "additionalProperties": False},
        },
    },
    {
        "type": "function",
        "function": {
            "name": ADD_TOOL,
            "description": (
                "把任务写进学习者的日程。用户要求安排/规划/提醒/排进日程，或同意你给出的复习计划时调用；"
                "只是讨论、没让你排期时不要调用。多步计划用 parent_title 作为总目标、tasks 作为子步骤。"
                "任务默认归入当前学习空间。调用后在回复里简短说明排了什么。"
            ),
            "parameters": {"type": "object", "properties": {
                "parent_title": {"type": "string", "description": "多步计划的总目标标题；单个任务时省略"},
                "parent_deadline_date": {"type": "string", "description": "总目标的截止日 YYYY-MM-DD，可省略"},
                "tasks": {"type": "array", "minItems": 1, "maxItems": 12, "items": {
                    "type": "object", "properties": _TASK_FIELDS, "required": ["title"], "additionalProperties": False,
                }},
            }, "required": ["tasks"], "additionalProperties": False},
        },
    },
    {
        "type": "function",
        "function": {
            "name": UPDATE_TOOL,
            "description": "修改日程里已有的一个任务：改期、改时间、标记完成或取消。task_id 必须来自 agenda_list 或 agenda_add 的结果。",
            "parameters": {"type": "object", "properties": {
                "task_id": {"type": "string"},
                **{key: value for key, value in _TASK_FIELDS.items() if key != "notes"},
                "status": {"type": "string", "enum": ["open", "done", "cancelled"]},
            }, "required": ["task_id"], "additionalProperties": False},
        },
    },
]


def _brief(task: dict) -> dict:
    keys = ("id", "title", "scheduled_date", "scheduled_start_at", "duration_minutes", "deadline_date",
            "priority", "status", "source", "parent_id", "subject_id")
    return {key: task[key] for key in keys if task.get(key) not in (None, "", [])}


def _validated(model, data: dict):
    try:
        return model.model_validate(data)
    except ValidationError as exc:
        problem = exc.errors()[0]
        field = ".".join(str(part) for part in problem.get("loc", ())) or "参数"
        raise ToolError(f"{field} 无效：{problem.get('msg', '格式不对')}") from None


def _task_input(raw: dict, subject_id: str | None) -> dict:
    data = {key: raw[key] for key in _TASK_FIELDS if raw.get(key) not in (None, "")}
    start = data.get("scheduled_start_at")
    if isinstance(start, str) and len(start) >= 10 and not data.get("scheduled_date"):
        data["scheduled_date"] = start[:10]
    data.update(subject_id=subject_id, source="ai_breakdown")
    return _validated(TaskCreate, data).model_dump()


def run(name: str, arguments: dict, ctx) -> str:
    store, student = ctx.store, ctx.student_id
    subject = store.conversation_subject(ctx.conversation_id)
    subject_id = subject.id if subject else None
    agenda.ensure(store)
    try:
        with store.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            if name == LIST_TOOL:
                days = arguments.get("days", 7)
                days = days if isinstance(days, int) and 1 <= days <= 60 else 7
                horizon = (date.today() + timedelta(days=days)).isoformat()
                agenda.sync(db, student)
                items = [_brief(task) for task in agenda.tasks(db, student, "open")
                         if not task["scheduled_date"] or task["scheduled_date"] <= horizon]
                return json.dumps({"today": date.today().isoformat(), "tasks": items[:60]}, ensure_ascii=False)

            if name == ADD_TOOL:
                raw_tasks = arguments.get("tasks")
                if not isinstance(raw_tasks, list) or not raw_tasks:
                    raise ToolError("tasks 必须是非空数组。")
                children = [_task_input(item if isinstance(item, dict) else {}, subject_id) for item in raw_tasks[:12]]
                parent = None
                title = str(arguments.get("parent_title") or "").strip()
                if title:
                    parent = agenda.insert(db, student, _task_input(
                        {"title": title, "deadline_date": arguments.get("parent_deadline_date"), "priority": 2},
                        subject_id,
                    ))
                created = [agenda.insert(db, student, {**child, "parent_id": parent["id"] if parent else None})
                           for child in children]
                return json.dumps({
                    "added": len(created) + (1 if parent else 0),
                    "parent": _brief(parent) if parent else None,
                    "tasks": [_brief(task) for task in created],
                }, ensure_ascii=False)

            if name == UPDATE_TOOL:
                task_id = str(arguments.get("task_id") or "")
                changes = {key: value for key, value in arguments.items() if key != "task_id"}
                start = changes.get("scheduled_start_at")
                if isinstance(start, str) and len(start) >= 10 and "scheduled_date" not in changes:
                    changes["scheduled_date"] = start[:10]
                patch = _validated(TaskPatch, changes).model_dump(exclude_unset=True)
                if not patch:
                    raise ToolError("没有要修改的字段。")
                return json.dumps({"updated": _brief(agenda.update(db, student, task_id, patch))}, ensure_ascii=False)
    except HTTPException as exc:
        # Ownership, missing-task and reference errors come back as plain text for the model.
        raise ToolError(str(exc.detail)) from None
    raise ToolError(f"未知日程工具：{name}")

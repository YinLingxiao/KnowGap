"""Agenda-owned migrations, transactional writes and idempotent review chains."""

import json
from datetime import date, datetime, timedelta

from fastapi import HTTPException
from pydantic import ValidationError

from app.agenda.schemas import TaskDraft
from app.memory.store import new_id, now


def ensure(store):
    # Kept outside ChatStore initialization; safe for existing databases and repeated calls.
    with store.connection() as db:
        db.executescript("""
            CREATE TABLE IF NOT EXISTS agenda_tasks (
                id TEXT PRIMARY KEY, student_id TEXT NOT NULL,
                title TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '',
                parent_id TEXT REFERENCES agenda_tasks(id) ON DELETE CASCADE,
                priority INTEGER NOT NULL DEFAULT 4, labels TEXT NOT NULL DEFAULT '[]',
                subject_id TEXT, thread_id TEXT, scheduled_date TEXT, scheduled_start_at TEXT,
                duration_minutes INTEGER, deadline_date TEXT,
                status TEXT NOT NULL DEFAULT 'open', completed_at TEXT,
                source TEXT NOT NULL DEFAULT 'manual', memory_id TEXT, review_step INTEGER,
                sort_order REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                UNIQUE(student_id, memory_id, review_step)
            );
            CREATE INDEX IF NOT EXISTS agenda_student_status ON agenda_tasks(student_id, status);
            CREATE TABLE IF NOT EXISTS agenda_review_abandoned (
                student_id TEXT NOT NULL, memory_id TEXT NOT NULL,
                PRIMARY KEY(student_id, memory_id)
            );
        """)
        # Serialize the check/add pair across concurrent first requests.
        db.execute("BEGIN IMMEDIATE")
        if "reminder_minutes" not in {row["name"] for row in db.execute("PRAGMA table_info(agenda_tasks)")}:
            db.execute("ALTER TABLE agenda_tasks ADD COLUMN reminder_minutes INTEGER")


def task(row):
    result = dict(row)
    result.pop("student_id", None)
    result["labels"] = json.loads(result["labels"])
    return result


def owned(db, student, task_id):
    row = db.execute("SELECT * FROM agenda_tasks WHERE id = ? AND student_id = ?", (task_id, student)).fetchone()
    if row is None:
        raise HTTPException(404, "任务不存在")
    return task(row)


def references(db, student, data, task_id=None):
    subject = data.get("subject_id")
    if subject is not None and not db.execute("SELECT 1 FROM subjects WHERE id = ? AND student_id = ?", (subject, student)).fetchone():
        raise HTTPException(422, "subject_id 不属于当前学生")
    thread = data.get("thread_id")
    if thread is not None and not db.execute(
        "SELECT 1 FROM conversations WHERE id = ? AND student_id = ? AND kind = 'thread'", (thread, student)
    ).fetchone():
        raise HTTPException(422, "thread_id 不属于当前学生的 Thread")
    parent = data.get("parent_id")
    if parent is not None:
        row = db.execute("SELECT parent_id FROM agenda_tasks WHERE id = ? AND student_id = ?", (parent, student)).fetchone()
        if row is None:
            raise HTTPException(404, "父任务不存在")
        if row["parent_id"] or parent == task_id or (task_id and db.execute(
            "SELECT 1 FROM agenda_tasks WHERE parent_id = ?", (task_id,)
        ).fetchone()):
            raise HTTPException(422, "只支持两层任务")


def insert(db, student, data):
    data = {"notes": "", "parent_id": None, "priority": 4, "labels": [], "subject_id": None,
            "thread_id": None, "scheduled_date": None, "scheduled_start_at": None,
            "duration_minutes": None, "deadline_date": None, "reminder_minutes": None, "status": "open", "completed_at": None,
            "source": "manual", "memory_id": None, "review_step": None, "sort_order": 0, **data}
    data.update(id=new_id("task"), student_id=student, created_at=now(), updated_at=now())
    data["labels"] = json.dumps(data["labels"], ensure_ascii=False)
    keys = list(data)
    db.execute(f"INSERT INTO agenda_tasks ({','.join(keys)}) VALUES ({','.join('?' for _ in keys)})",
               [data[k] for k in keys])
    return owned(db, student, data["id"])


def sync(db, student):
    """Only reads chat tables. Writer lock + unique key serialize concurrent sync/completion."""
    memories = db.execute(
        "SELECT m.*, (SELECT quote FROM learner_memory_evidence e WHERE e.memory_id=m.id "
        "ORDER BY e.created_at DESC, e.id DESC LIMIT 1) AS quote FROM learner_memories m "
        "WHERE m.student_id=? AND m.kind='misconception' AND m.status!='resolved'", (student,)
    ).fetchall()
    db.execute(
        "UPDATE agenda_tasks SET status='cancelled', updated_at=? WHERE student_id=? AND source='review' "
        "AND status='open' AND NOT EXISTS (SELECT 1 FROM learner_memories m WHERE m.id=agenda_tasks.memory_id "
        "AND m.student_id=? AND m.kind='misconception' AND m.status!='resolved')", (now(), student, student)
    )
    for memory in memories:
        if db.execute("SELECT 1 FROM agenda_review_abandoned WHERE student_id=? AND memory_id=?",
                      (student, memory["id"])).fetchone():
            continue
        rounds = db.execute(
            "SELECT * FROM agenda_tasks WHERE student_id=? AND memory_id=? ORDER BY review_step",
            (student, memory["id"])
        ).fetchall()
        if not rounds:
            step, anchor, days = 1, memory["created_at"][:10], 1
        else:
            last = rounds[-1]
            if last["status"] != "done" or last["review_step"] >= 3:
                continue
            step = last["review_step"] + 1
            anchor = datetime.fromisoformat(last["completed_at"]).astimezone().date().isoformat()
            days = 3 if step == 2 else 7
        insert(db, student, {
            "title": ("闪回：" + memory["topic"])[:200],
            "notes": memory["summary"] + ("\n\n原话证据：" + memory["quote"] if memory["quote"] else ""),
            "priority": 2, "subject_id": memory["subject_id"], "source": "review",
            "memory_id": memory["id"], "review_step": step,
            "scheduled_date": (date.fromisoformat(anchor) + timedelta(days=days)).isoformat(),
        })


def update(db, student, task_id, changes):
    previous = owned(db, student, task_id)
    # Null clears collections/text to their empty representations, not SQL NULL.
    for key, empty in (("notes", ""), ("labels", [])):
        if key in changes and changes[key] is None:
            changes[key] = empty
    merged = {**previous, **changes}
    try:
        TaskDraft.model_validate({k: merged[k] for k in TaskDraft.model_fields})
    except ValidationError as exc:
        raise HTTPException(422, "计划日期或任务字段无效") from exc
    if previous["source"] == "review" and "source" in changes:
        raise HTTPException(422, "闪回任务不能修改来源")
    references(db, student, merged, task_id)
    if "status" in changes:
        changes["completed_at"] = (previous["completed_at"] or now()) if changes["status"] == "done" else None
    changes["updated_at"] = now()
    if "labels" in changes:
        changes["labels"] = json.dumps(changes["labels"], ensure_ascii=False)
    db.execute(f"UPDATE agenda_tasks SET {','.join(k + '=?' for k in changes)} WHERE id=? AND student_id=?",
               [*changes.values(), task_id, student])
    if previous["source"] == "review":
        sync(db, student)
    return owned(db, student, task_id)


def tasks(db, student, status="open", subject=None):
    return [task(r) for r in db.execute(
        "SELECT * FROM agenda_tasks WHERE student_id=? AND status!='cancelled' "
        "AND (?='all' OR status=?) AND (? IS NULL OR subject_id=?) ORDER BY sort_order, created_at, id",
        (student, status, status, subject, subject)
    ).fetchall()]


def threads(db, student):
    return [dict(r) for r in db.execute(
        "SELECT c.id AS thread_id, c.title, s.id AS subject_id, s.name AS subject_name, "
        "s.color AS subject_color, s.deadline AS deadline_date, c.updated_at "
        "FROM conversations c JOIN subjects s ON s.id=c.subject_id AND s.student_id=c.student_id "
        "WHERE c.student_id=? AND c.kind='thread' AND COALESCE(c.thread_status,'open')='open' "
        "ORDER BY c.updated_at DESC, c.id", (student,)
    ).fetchall()]

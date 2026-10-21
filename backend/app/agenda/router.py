"""Authenticated agenda endpoints; every write is scoped and transactional."""

from contextlib import contextmanager
from datetime import date, datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Query, Response
from fastapi import HTTPException

from app.auth.deps import current_student
from app.agenda import store as persistence
from app.agenda.breakdown import build
from app.agenda.ical import calendar
from app.agenda.schemas import Batch, BreakdownRequest, Day, TaskCreate, TaskPatch


def agenda_router(chat_store, model):
    router = APIRouter(prefix="/api/agenda", tags=["agenda"])

    @contextmanager
    def transaction():
        persistence.ensure(chat_store)
        with chat_store.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            yield db, current_student()

    @router.get("/tasks")
    def list_tasks(status: Literal["open", "done", "all"] = "open", subject_id: str | None = None):
        with transaction() as (db, student):
            persistence.references(db, student, {"subject_id": subject_id})
            persistence.sync(db, student)
            return {"tasks": persistence.tasks(db, student, status, subject_id)}

    @router.get("/feed")
    def feed(from_date: Annotated[Day | None, Query(alias="from")] = None,
             to_date: Annotated[Day | None, Query(alias="to")] = None):
        if from_date and to_date and from_date > to_date:
            raise HTTPException(422, "from 不得晚于 to")
        with transaction() as (db, student):
            persistence.sync(db, student)
            tasks = persistence.tasks(db, student, "all")
            def included(t):
                if t["status"] == "open":
                    return True
                completed = datetime.fromisoformat(t["completed_at"]).astimezone().date().isoformat()
                return (not from_date or completed >= from_date) and (not to_date or completed <= to_date)
            return {"today": date.today().isoformat(), "tasks": [t for t in tasks if included(t)],
                    "threads": persistence.threads(db, student)}

    @router.post("/tasks", status_code=201)
    def create(body: TaskCreate):
        with transaction() as (db, student):
            data = body.model_dump()
            persistence.references(db, student, data)
            return persistence.insert(db, student, data)

    @router.post("/tasks/batch", status_code=201)
    def batch(body: Batch):
        with transaction() as (db, student):
            parent = None
            if body.parent:
                data = body.parent.model_dump()
                if data["parent_id"]:
                    raise HTTPException(422, "批量创建的父任务必须为顶层任务")
                persistence.references(db, student, data)
                parent = persistence.insert(db, student, data)
            children = []
            for child in body.children:
                data = {**child.model_dump(), "parent_id": parent["id"] if parent else None}
                persistence.references(db, student, data)
                children.append(persistence.insert(db, student, data))
            return {"parent": parent, "children": children}

    @router.patch("/tasks/{task_id}")
    def patch(task_id: str, body: TaskPatch):
        with transaction() as (db, student):
            return persistence.update(db, student, task_id, body.model_dump(exclude_unset=True))

    @router.delete("/tasks/{task_id}", status_code=204)
    def delete(task_id: str):
        with transaction() as (db, student):
            task = persistence.owned(db, student, task_id)
            # Preserve abandonment even after physical deletion, including review children.
            for row in db.execute("SELECT memory_id FROM agenda_tasks WHERE student_id=? AND source='review' "
                                  "AND (id=? OR parent_id=?)", (student, task_id, task_id)).fetchall():
                db.execute("INSERT OR IGNORE INTO agenda_review_abandoned VALUES (?, ?)", (student, row["memory_id"]))
            db.execute("DELETE FROM agenda_tasks WHERE id=? AND student_id=?", (task["id"], student))
        return Response(status_code=204)

    @router.post("/breakdown")
    async def breakdown(body: BreakdownRequest):
        context = None
        with transaction() as (db, student):
            persistence.references(db, student, {"subject_id": body.subject_id})
            if body.subject_id:
                space = db.execute("SELECT name, goal, deadline FROM subjects WHERE id=? AND student_id=?",
                                   (body.subject_id, student)).fetchone()
                weak = db.execute(
                    "SELECT topic FROM learner_memories WHERE student_id=? AND subject_id=? AND kind='misconception' "
                    "AND status!='resolved' ORDER BY updated_at DESC LIMIT 8", (student, body.subject_id)).fetchall()
                context = {"name": space["name"], "goal": space["goal"], "deadline": space["deadline"],
                           "weak_points": [row["topic"] for row in weak]}
        return await build(model, body, context)

    @router.get("/export.ics")
    def export(status: Literal["open", "all"] = "open", subject_id: str | None = None):
        with transaction() as (db, student):
            persistence.references(db, student, {"subject_id": subject_id})
            persistence.sync(db, student)
            content = calendar(persistence.tasks(db, student, status, subject_id))
        return Response(content, media_type="text/calendar; charset=utf-8",
                        headers={"Content-Disposition": 'attachment; filename="knowgap-agenda.ics"'})

    return router

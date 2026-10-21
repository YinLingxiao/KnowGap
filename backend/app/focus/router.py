from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.auth.deps import current_student
from app.focus.store import FocusStore
from app.memory.store import Store


class StartBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    task_id: str | None = None
    subject_id: str | None = None
    title: str = Field(min_length=1, max_length=200)
    planned_minutes: int = Field(ge=0, le=720)

    @field_validator("title")
    @classmethod
    def strip_title(cls, value: str) -> str:
        text = value.strip()
        if not text:
            raise ValueError("标题不能为空")
        return text

    @field_validator("task_id", "subject_id")
    @classmethod
    def blank_to_none(cls, value: str | None) -> str | None:
        if value is None:
            return None
        text = value.strip()
        return text or None


class EndBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: str = Field(pattern="^(completed|abandoned)$")
    note: str = Field(default="", max_length=280)
    actual_seconds: int | None = Field(default=None, ge=0, le=86400)

    @field_validator("note")
    @classmethod
    def strip_note(cls, value: str) -> str:
        return value.strip()


def focus_router(store: Store) -> APIRouter:
    focus = FocusStore(store)
    router = APIRouter(prefix="/api/focus", tags=["focus"])

    @router.post("/sessions", status_code=201)
    def start(body: StartBody) -> dict:
        return focus.start(
            current_student(), title=body.title, planned_minutes=body.planned_minutes,
            task_id=body.task_id, subject_id=body.subject_id,
        )

    @router.patch("/sessions/{session_id}")
    def finish(session_id: str, body: EndBody) -> dict:
        try:
            return focus.finish(
                current_student(), session_id, status=body.status, note=body.note,
                actual_seconds=body.actual_seconds,
            )
        except LookupError:
            raise HTTPException(404, "专注记录不存在") from None
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from None

    @router.get("/heatmap")
    def heatmap(weeks: int = Query(default=12, ge=1, le=52)) -> dict:
        return focus.heatmap(current_student(), weeks)

    return router

"""Wire models for docs/contracts/agenda.md."""

import re
from datetime import date, datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, AfterValidator, model_validator


def valid_date(value: str) -> str:
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        raise ValueError("日期必须为 YYYY-MM-DD")
    date.fromisoformat(value)
    return value


def valid_start(value: str) -> str:
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}", value):
        raise ValueError("开始时间必须为 YYYY-MM-DDTHH:MM")
    datetime.fromisoformat(value)
    return value


Day = Annotated[str, AfterValidator(valid_date)]
Start = Annotated[str, AfterValidator(valid_start)]
Title = Annotated[str, Field(min_length=1, max_length=200)]
Labels = Annotated[list[Annotated[str, Field(max_length=20)]], Field(max_length=10)]
Priority = Annotated[int, Field(strict=True, ge=1, le=4)]
Duration = Annotated[int, Field(strict=True, ge=5, le=720)]


class TaskDraft(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: Title
    notes: str = ""
    priority: Priority = 4
    labels: Labels = Field(default_factory=list)
    scheduled_date: Day | None = None
    scheduled_start_at: Start | None = None
    duration_minutes: Duration | None = None
    deadline_date: Day | None = None

    @model_validator(mode="after")
    def consistent_start(self):
        if self.scheduled_start_at and self.scheduled_date != self.scheduled_start_at[:10]:
            raise ValueError("scheduled_date 必须等于开始时间的日期")
        return self


class TaskCreate(TaskDraft):
    parent_id: str | None = None
    subject_id: str | None = None
    thread_id: str | None = None
    source: Literal["manual", "ai_breakdown"] = "manual"


class TaskPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: Title | None = None
    notes: str | None = None
    parent_id: str | None = None
    priority: Priority | None = None
    labels: Labels | None = None
    subject_id: str | None = None
    thread_id: str | None = None
    scheduled_date: Day | None = None
    scheduled_start_at: Start | None = None
    duration_minutes: Duration | None = None
    deadline_date: Day | None = None
    source: Literal["manual", "ai_breakdown"] | None = None
    status: Literal["open", "done", "cancelled"] | None = None
    sort_order: Annotated[float, Field(allow_inf_nan=False)] | None = None

    @model_validator(mode="after")
    def required_not_null(self):
        for key in self.model_fields_set & {"title", "priority", "source", "status", "sort_order"}:
            if getattr(self, key) is None:
                raise ValueError(f"{key} 不可为空")
        return self


class Batch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    parent: TaskCreate | None = None
    children: list[TaskCreate] = Field(max_length=30)


class BreakdownRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    goal: Annotated[str, Field(min_length=1, max_length=2000)]
    subject_id: str | None = None
    deadline_date: Day | None = None
    today: Day

    @model_validator(mode="after")
    def range_valid(self):
        if self.deadline_date and self.deadline_date < self.today:
            raise ValueError("截止日不得早于 today")
        return self

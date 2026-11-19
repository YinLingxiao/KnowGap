from datetime import date, datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

from app.agenda.schemas import Day

NonEmptyText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]
TitleText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
StrictPriority = Annotated[int, Field(strict=True, ge=1, le=4)]
StrictDuration = Annotated[int, Field(strict=True, ge=5, le=120)]
StrictOrder = Annotated[int, Field(strict=True, ge=1)]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class LearningPlanDraftRequest(StrictModel):
    subject_id: NonEmptyText
    budget_minutes: Annotated[int, Field(strict=True, ge=1, le=120)]
    deadline: Day

    @model_validator(mode="after")
    def deadline_not_in_past(self):
        if self.deadline < date.today().isoformat():
            raise ValueError("deadline 不得早于今天")
        return self


class LearningPlanConfirmRequest(StrictModel):
    task_ids: list[str]


class MemoryEvidenceSnapshot(StrictModel):
    quote: str
    reason: str
    signal: str
    source: str
    created_at: str


class MemorySnapshot(StrictModel):
    memory_id: str
    topic: str
    summary: str
    status: str
    evidence: list[MemoryEvidenceSnapshot] = Field(default_factory=list)


class LearningContextSnapshot(StrictModel):
    student_id: str
    subject_id: str
    subject_name: str
    today: Day
    deadline: Day
    budget_minutes: int
    memories: list[MemorySnapshot]


class WeakPoint(StrictModel):
    memory_id: NonEmptyText
    topic: NonEmptyText
    summary: NonEmptyText
    due: Day | None = None
    priority: StrictPriority = 4


class DiagnoseOutput(StrictModel):
    weak_points: list[WeakPoint]


class PlannedTaskCandidate(StrictModel):
    draft_task_id: str
    title: Any = None
    memory_id: Any = None
    evidence: Any = None
    duration_minutes: Any = None
    scheduled_date: Any = None
    order: StrictOrder


class PlanOutput(StrictModel):
    tasks: list[PlannedTaskCandidate]


class LearningDraftTask(StrictModel):
    draft_task_id: NonEmptyText
    title: TitleText
    memory_id: NonEmptyText
    evidence: NonEmptyText
    duration_minutes: StrictDuration
    scheduled_date: Day
    order: StrictOrder


class RejectedTask(StrictModel):
    draft_task_id: NonEmptyText
    code: NonEmptyText
    message: NonEmptyText


class ReviewResult(StrictModel):
    approved: list[str]
    rejected: list[RejectedTask]
    total_minutes: Annotated[int, Field(strict=True, ge=0)]


class AgentRun(StrictModel):
    started_at: datetime
    finished_at: datetime

    @model_validator(mode="after")
    def timestamps_valid(self):
        if self.started_at.tzinfo is None or self.finished_at.tzinfo is None:
            raise ValueError("阶段时间必须包含时区")
        if self.finished_at < self.started_at:
            raise ValueError("finished_at 不得早于 started_at")
        return self


class DiagnoseAgentRun(AgentRun):
    agent: Literal["diagnose"] = "diagnose"
    output: DiagnoseOutput


class PlanAgentRun(AgentRun):
    agent: Literal["plan"] = "plan"
    output: PlanOutput


class ReviewAgentRun(AgentRun):
    agent: Literal["review"] = "review"
    output: ReviewResult


class LearningPlanDraftResponse(StrictModel):
    draft_id: NonEmptyText
    tasks: list[LearningDraftTask]
    agents: list[DiagnoseAgentRun | PlanAgentRun | ReviewAgentRun]

    @model_validator(mode="after")
    def agent_order_valid(self):
        if [run.agent for run in self.agents] != ["diagnose", "plan", "review"]:
            raise ValueError("agents 必须按 diagnose/plan/review 返回")
        return self


class LearningAgendaTask(StrictModel):
    id: str
    title: str
    notes: str
    subject_id: NonEmptyText
    scheduled_date: Day
    duration_minutes: StrictDuration
    source: Literal["learning_agent"]
    memory_id: NonEmptyText


class LearningSkippedTask(StrictModel):
    draft_task_id: str
    code: Literal["not_approved", "already_confirmed"]
    message: str


class LearningPlanConfirmResponse(StrictModel):
    created: list[LearningAgendaTask]
    skipped: list[LearningSkippedTask]
"""Free-chat HTTP contract. Independent from the legacy problem-bound /api/sessions contract."""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator

from app.models.schemas import Assessment, SourceReference

MessageText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=12000)]
Title = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=60)]
RequestId = Annotated[str, StringConstraints(strip_whitespace=True, min_length=8, max_length=80, pattern=r"^[A-Za-z0-9_-]+$")]
ProblemId = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]
SubjectId = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]
SubjectName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=40)]
Description = Annotated[str, StringConstraints(strip_whitespace=True, max_length=300)]
Instructions = Annotated[str, StringConstraints(strip_whitespace=True, max_length=4000)]
Goal = Annotated[str, StringConstraints(strip_whitespace=True, max_length=400)]
Level = Literal["beginner", "some", "fluent", "exam"]
Deadline = Annotated[str, StringConstraints(strip_whitespace=True, pattern=r"^\d{4}-\d{2}-\d{2}$")]
Color = Annotated[str, StringConstraints(strip_whitespace=True, pattern=r"^#[0-9A-Fa-f]{6}$")]
ConversationKind = Literal["chat", "main", "thread"]
ThreadStatus = Literal["open", "resolved"]
ExecutionStatus = Literal["queued", "working", "waiting", "idle", "failed", "cancelled"]
MemoryKind = Literal["misconception", "mastery", "preference"]
MemoryStatus = Literal["suspected", "needs_review", "improving", "resolved", "observed", "uncertain"]
MessageStatus = Literal["complete", "streaming", "failed", "cancelled"]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class CreateSubject(StrictModel):
    name: SubjectName
    description: Description = ""
    instructions: Instructions = ""
    goal: Goal = ""
    level: Level | None = None
    deadline: Deadline | None = None
    color: Color | None = None


class UpdateSubject(StrictModel):
    name: SubjectName | None = None
    description: Description | None = None
    instructions: Instructions | None = None
    goal: Goal | None = None
    level: Level | None = None
    deadline: Deadline | None = None
    color: Color | None = None


class SpaceProgress(BaseModel):
    to_review: int = 0
    improving: int = 0
    mastered: int = 0
    open_threads: int = 0
    resolved_threads: int = 0
    last_studied_at: str | None = None


class Subject(BaseModel):
    id: str
    name: str
    description: str
    instructions: str
    goal: str = ""
    level: Level | None = None
    deadline: str | None = None
    color: str = "#3d6fdb"
    main_conversation_id: str | None = None
    progress: SpaceProgress = Field(default_factory=SpaceProgress)
    conversation_count: int
    memory_count: int
    material_count: int
    created_at: str
    updated_at: str


class CreateThread(StrictModel):
    title: Title | None = None
    anchor_message_id: str | None = None
    client_request_id: RequestId


class DispatchThread(StrictModel):
    title: Title
    task: MessageText
    thread_id: str | None = None
    skill: Literal["deep_explain", "socratic_practice", "study_note_builder", "feynman_challenge", "general"] | None = None

    @field_validator("thread_id", "skill", mode="before")
    @classmethod
    def blank_means_omitted(cls, value):
        # 有的模型（如 GPT）对可选字段传 ""，而不是省略；空串当作没有，否则会往 id 为空的支线里写消息
        return None if isinstance(value, str) and not value.strip() else value


class ProposalInput(StrictModel):
    title: Title
    task: MessageText
    reason: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=400)]


class ProposeThreads(StrictModel):
    proposals: list[ProposalInput] = Field(min_length=1, max_length=4)


class ThreadProposal(ProposalInput):
    id: str
    thread_id: str | None = None


class ConfirmProposal(StrictModel):
    message_id: str
    proposal_id: str


class ReportProgress(StrictModel):
    summary: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=600)]
    needs_user: bool = False


class ResolveThread(StrictModel):
    title: Title
    summary: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=800)]
    takeaways: list[Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]] = Field(
        default_factory=list, max_length=4,
    )


class Resolution(BaseModel):
    title: str
    summary: str
    takeaways: list[str]
    message_id: str | None = None


class ThreadSummary(BaseModel):
    thread_id: str
    title: str
    summary: str
    takeaways: list[str] = Field(default_factory=list)
    memory_ids: list[str] = Field(default_factory=list)


class DispatchedThread(BaseModel):
    """A Thread dispatched from this user message; title and live state come from the Thread itself."""

    thread_id: str


class SystemEvent(BaseModel):
    """Hidden user message that carries a coordinator-only event, such as a batch of Thread reports."""

    type: str
    report_ids: list[str] = Field(default_factory=list)
    thread_ids: list[str] = Field(default_factory=list)


class MessageAnchor(BaseModel):
    message_id: str
    role: Literal["user", "assistant"]
    excerpt: str


class CreateConversation(StrictModel):
    title: Title | None = None
    problem_id: ProblemId | None = None
    subject_id: SubjectId | None = None
    # Makes "create, then send" safe to retry: the same id returns the same conversation.
    client_request_id: RequestId | None = None


class UpdateConversation(StrictModel):
    title: Title | None = None
    # Sent explicitly as null to move the conversation out of its Subject.
    subject_id: SubjectId | None = None


class SendMessage(StrictModel):
    content: MessageText
    client_request_id: RequestId


class StartExercise(StrictModel):
    problem_id: ProblemId


class UpdateMemory(StrictModel):
    summary: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=300)] | None = None
    status: MemoryStatus | None = None
    # Explicit null files the memory as general (applies across Subjects).
    subject_id: SubjectId | None = None


class ExerciseAttempt(BaseModel):
    problem_id: str
    assessment: Assessment
    issue: str | None = None
    evidence: str
    confidence: float | None = None


class MemoryEvidence(BaseModel):
    conversation_id: str | None
    message_id: str | None
    quote: str
    reason: str
    signal: Literal["supports", "contradicts"]
    created_at: str
    # False when the source conversation was deleted later; the quote snapshot is kept.
    source_available: bool = True


class LearnerMemory(BaseModel):
    id: str
    kind: MemoryKind
    topic: str
    topic_key: str | None
    summary: str
    status: MemoryStatus
    confidence: float
    user_corrected: bool
    origin: Literal["chat", "diagnosis"]
    subject_id: str | None = None
    tags: list[str] = Field(default_factory=list)
    evidence: list[MemoryEvidence]
    created_at: str
    updated_at: str


class MemoryChange(BaseModel):
    action: Literal["created", "updated"]
    memory: LearnerMemory


class ToolCallRecord(BaseModel):
    id: str
    name: str
    arguments: str = ""
    output: str = ""
    ok: bool = True


class PreferencePrompt(BaseModel):
    id: str
    text: str
    content: str


class ChatMessage(BaseModel):
    id: str
    conversation_id: str
    seq: int
    role: Literal["user", "assistant"]
    kind: Literal["text", "exercise"]
    content: str
    status: MessageStatus
    error: str | None = None
    reply_to: str | None = None
    client_request_id: str | None = None
    problem_id: str | None = None
    attempt: ExerciseAttempt | None = None
    memory_changes: list[MemoryChange] = Field(default_factory=list)
    used_memory_ids: list[str] = Field(default_factory=list)
    plan_changes: list[dict] = Field(default_factory=list)
    suggested_problem_id: str | None = None
    sources: list[SourceReference] = Field(default_factory=list)
    truncated: bool = False
    reasoning: str = ""
    files: list[dict] = Field(default_factory=list)
    tool_calls: list[ToolCallRecord] = Field(default_factory=list)
    thread_summary: ThreadSummary | None = None
    # Only main-line user messages carry these: each dispatch renders one card under that message.
    dispatched_threads: list[DispatchedThread] = Field(default_factory=list)
    # Set on the hidden user message that wakes the coordinator; the learner never sees it.
    system_event: SystemEvent | None = None
    thread_proposals: list[ThreadProposal] = Field(default_factory=list)
    pending_approval: dict | None = None
    preference_prompt: PreferencePrompt | None = None
    next_actions: list[Literal["quiz", "schedule", "save_note", "weak_points"]] = Field(default_factory=list)
    checkpoint_available: bool = False
    checkpoint_blocked_reason: str | None = None
    created_at: str
    updated_at: str


class ConversationSummary(BaseModel):
    id: str
    title: str
    title_source: Literal["pending", "auto", "user"]
    subject_id: str | None = None
    kind: ConversationKind = "chat"
    parent_id: str | None = None
    model_key: str | None = None
    thread_status: ThreadStatus | None = None
    execution_status: ExecutionStatus | None = None
    anchor: MessageAnchor | None = None
    active_problem_id: str | None
    legacy_session_id: str | None
    message_count: int
    preview: str
    generating: bool = False
    created_at: str
    updated_at: str


class Conversation(ConversationSummary):
    messages: list[ChatMessage]

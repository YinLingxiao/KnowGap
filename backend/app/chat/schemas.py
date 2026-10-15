"""Free-chat HTTP contract. Independent from the legacy problem-bound /api/sessions contract."""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

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
    suggested_problem_id: str | None = None
    sources: list[SourceReference] = Field(default_factory=list)
    truncated: bool = False
    tool_calls: list[ToolCallRecord] = Field(default_factory=list)
    thread_summary: ThreadSummary | None = None
    created_at: str
    updated_at: str


class ConversationSummary(BaseModel):
    id: str
    title: str
    title_source: Literal["pending", "auto", "user"]
    subject_id: str | None = None
    kind: ConversationKind = "chat"
    parent_id: str | None = None
    thread_status: ThreadStatus | None = None
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

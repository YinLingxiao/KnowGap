"""Public HTTP contract and validated model output."""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

TextInput = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=6000)]
ShortText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=1500)]
Assessment = Literal["correct", "incorrect", "uncertain"]
DEMO_STUDENT = "demo-student-001"


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class DiagnosisRequest(StrictModel):
    student_id: Literal["demo-student-001"] = DEMO_STUDENT
    problem_id: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]
    answer: TextInput
    web_search: bool = False


class MessageRequest(StrictModel):
    content: TextInput
    web_search: bool = False


class WebSource(BaseModel):
    id: str
    label: str
    title: str
    url: str
    snippet: str


class WebSearchResponse(BaseModel):
    provider: Literal['anysearch'] = 'anysearch'
    query: str
    results: list[WebSource]
    request_id: str | None = None


class Material(BaseModel):
    id: str
    title: str
    kind: Literal['pdf', 'txt', 'md']
    page_count: int
    chunk_count: int
    created_at: str
    subject_id: str | None = None


class SourceReference(BaseModel):
    id: str
    document_id: str
    title: str
    label: str
    page: int | None = None
    start_line: int | None = None
    end_line: int | None = None
    excerpt: str


class Problem(BaseModel):
    id: str
    title: str
    topic_key: str
    prompt: str
    input_sequence: list[int]
    output_sequence: list[int]


class TutorOutput(StrictModel):
    assessment: Assessment
    issue: ShortText | None
    confidence: float = Field(ge=0, le=1, allow_inf_nan=False)
    evidence: ShortText
    reply: ShortText
    web_source_ids: list[str] = Field(default_factory=list, max_length=5)
    citation_ids: list[str] = Field(default_factory=list, max_length=3)

    @model_validator(mode="after")
    def consistent_issue(self):
        if self.assessment == "incorrect" and self.issue is None:
            raise ValueError("Incorrect assessment requires a specific issue")
        if self.assessment != "incorrect" and self.issue is not None:
            raise ValueError("Correct/uncertain assessment cannot assign an issue")
        return self


class Diagnosis(BaseModel):
    topic_key: str
    assessment: Assessment
    issue: str | None
    confidence: float
    evidence: str


class Evidence(BaseModel):
    message_id: str
    session_id: str
    problem_id: str
    quote: str
    assessment: Assessment
    phase: Literal["initial", "tutoring"]
    created_at: str


class Memory(BaseModel):
    id: str
    student_id: str
    topic_key: str
    issue_key: str
    summary: str
    status: Literal["suspected", "needs_review", "improving", "resolved"]
    confidence: float
    evidence_count: int
    evidence_refs: list[Evidence]
    updated_at: str


class MemoryChange(BaseModel):
    action: Literal["created", "updated"]
    memory: Memory


class TeachingResponse(BaseModel):
    session_id: str
    turn: int
    diagnosis: Diagnosis
    reply: str
    used_memory_ids: list[str]
    memory_changes: list[MemoryChange]
    web_sources: list[WebSource] = Field(default_factory=list)
    sources: list[SourceReference] = Field(default_factory=list)


class SessionMessage(BaseModel):
    id: str
    role: Literal["user", "assistant"]
    content: str
    created_at: str
    diagnosis: Diagnosis | None = None
    used_memory_ids: list[str] = []
    web_sources: list[WebSource] = Field(default_factory=list)
    sources: list[SourceReference] = Field(default_factory=list)


class Session(BaseModel):
    id: str
    student_id: str
    problem_id: str
    turn: int
    created_at: str
    messages: list[SessionMessage]

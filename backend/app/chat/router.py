"""Free-chat endpoints. Conversations do not require a problem; exercises are optional context."""

from fastapi import APIRouter, HTTPException, Response
from fastapi.responses import StreamingResponse

from app.agents.llm import ProviderError
from app.chat.schemas import (
    Conversation, ConversationSummary, CreateConversation, LearnerMemory, Resolution, ResolveThread, SendMessage,
    StartExercise, UpdateConversation, UpdateMemory,
)
from app.chat.service import ChatService
from app.chat.store import UNSET, ChatStore
from app.models.schemas import DEMO_STUDENT
from app.services.problems import PROBLEMS

STREAM_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}


def chat_router(store: ChatStore, service: ChatService) -> APIRouter:
    router = APIRouter(prefix="/api", tags=["自由对话"])
    student = DEMO_STUDENT

    def require(conversation_id: str) -> Conversation:
        conversation = store.conversation(conversation_id, student)
        if conversation is None:
            raise HTTPException(404, "会话不存在或已删除。")
        conversation.generating = service.is_generating(conversation_id)
        return conversation

    def require_idle(conversation_id: str) -> None:
        if service.is_generating(conversation_id):
            raise HTTPException(409, "上一条回复仍在生成，请先停止或稍候。")

    def require_subject(subject_id: str | None) -> None:
        if subject_id is not None and store.subject(subject_id, student) is None:
            raise HTTPException(404, "Subject 不存在或已删除。")

    def stream(body) -> StreamingResponse:
        return StreamingResponse(body, media_type="text/event-stream", headers=STREAM_HEADERS)

    @router.get("/conversations", response_model=list[ConversationSummary])
    def list_conversations(subject_id: str | None = None):
        items = store.list_conversations(student, subject_id)
        for item in items:
            item.generating = service.is_generating(item.id)
        return items

    @router.post("/conversations", response_model=Conversation, status_code=201)
    def create_conversation(body: CreateConversation):
        problem = None
        if body.problem_id:
            problem = PROBLEMS.get(body.problem_id)
            if problem is None:
                raise HTTPException(404, "练习题不存在。")
        require_subject(body.subject_id)
        conversation_id = store.create_conversation(
            student, title=body.title, problem=problem, client_request_id=body.client_request_id,
            subject_id=body.subject_id,
        )
        return require(conversation_id)

    @router.get("/conversations/{conversation_id}", response_model=Conversation)
    def get_conversation(conversation_id: str):
        return require(conversation_id)

    @router.patch("/conversations/{conversation_id}", response_model=Conversation)
    def update_conversation(conversation_id: str, body: UpdateConversation):
        fields = body.model_fields_set
        if "title" in fields and body.title is None:
            raise HTTPException(422, "标题不能为空。")
        if "subject_id" in fields:
            require_subject(body.subject_id)
        if not store.update_conversation(
            conversation_id, student,
            title=body.title if "title" in fields else UNSET,
            subject_id=body.subject_id if "subject_id" in fields else UNSET,
        ):
            raise HTTPException(404, "会话不存在或已删除。")
        return require(conversation_id)

    @router.delete("/conversations/{conversation_id}", status_code=204)
    def delete_conversation(conversation_id: str):
        service.stop(conversation_id)
        if not store.delete_conversation(conversation_id, student):
            raise HTTPException(404, "会话不存在或已删除。")
        return Response(status_code=204)

    @router.post("/conversations/{conversation_id}/messages")
    async def send_message(conversation_id: str, body: SendMessage):
        require(conversation_id)
        existing = store.find_request(conversation_id, body.client_request_id)
        if existing and service.is_generating(conversation_id):
            raise HTTPException(409, "这条消息正在生成回复，请稍候；刷新会话可查看最新状态。")
        require_idle(conversation_id)
        if existing:
            # Same request id again (timeout, double click, reconnect): never store the message twice.
            replies = store.replies(existing)
            complete = [row for row in replies if row["status"] == "complete"]
            if complete:
                return stream(service.replay(student, conversation_id, existing, complete[-1]["id"]))
            generation = service.begin(student, conversation_id, existing, [row["id"] for row in replies])
        else:
            user_id = store.add_user_message(conversation_id, body.content, body.client_request_id)
            generation = service.begin(student, conversation_id, user_id, [])
        return stream(service.events(generation))

    @router.post("/conversations/{conversation_id}/regenerate")
    async def regenerate(conversation_id: str):
        require(conversation_id)
        require_idle(conversation_id)
        user_id, blocked = store.last_user_message(conversation_id)
        if user_id is None:
            raise HTTPException(409, "还没有可以重新生成回复的消息。")
        if blocked:
            raise HTTPException(409, "最后一条消息之后已有新内容，无法重新生成。")
        replies = [row["id"] for row in store.replies(user_id)]
        return stream(service.events(service.begin(student, conversation_id, user_id, replies)))

    @router.post("/conversations/{conversation_id}/stop")
    def stop(conversation_id: str):
        require(conversation_id)
        return {"stopped": service.stop(conversation_id)}

    @router.post("/conversations/{conversation_id}/resolve/draft", response_model=Resolution)
    async def draft_resolution(conversation_id: str):
        try:
            return await service.draft_resolution(student, conversation_id)
        except LookupError as exc:
            raise HTTPException(404, str(exc)) from None
        except ProviderError as exc:
            raise HTTPException(exc.status_code, exc.detail) from None
        except ValueError as exc:
            detail = str(exc)
            raise HTTPException(409 if detail.startswith("只有") else 502, detail) from None

    @router.post("/conversations/{conversation_id}/resolve", response_model=Resolution)
    def resolve_thread(conversation_id: str, body: ResolveThread):
        try:
            return store.resolve_thread(conversation_id, student, body.title, body.summary, body.takeaways)
        except LookupError as exc:
            raise HTTPException(404, str(exc)) from None
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from None

    @router.post("/conversations/{conversation_id}/reopen", response_model=Conversation)
    def reopen_thread(conversation_id: str):
        try:
            found = store.reopen_thread(conversation_id, student)
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from None
        if not found:
            raise HTTPException(404, "会话不存在或已删除。")
        return require(conversation_id)

    @router.post("/conversations/{conversation_id}/exercises", response_model=Conversation, status_code=201)
    def start_exercise(conversation_id: str, body: StartExercise):
        require(conversation_id)
        require_idle(conversation_id)
        problem = PROBLEMS.get(body.problem_id)
        if problem is None:
            raise HTTPException(404, "练习题不存在。")
        store.add_exercise(conversation_id, problem)
        return require(conversation_id)

    @router.get("/learner-memories", response_model=list[LearnerMemory])
    def list_memories(subject_id: str | None = None):
        memories = store.memories(student)
        return memories if subject_id is None else [m for m in memories if m.subject_id == subject_id]

    @router.patch("/learner-memories/{memory_id}", response_model=LearnerMemory)
    def correct_memory(memory_id: str, body: UpdateMemory):
        if not body.model_fields_set:
            raise HTTPException(422, "请提供要修改的内容。")
        try:
            memory = store.update_memory(
                memory_id, student, body.summary, body.status,
                body.subject_id if "subject_id" in body.model_fields_set else UNSET,
            )
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from None
        except LookupError as exc:
            raise HTTPException(404, str(exc)) from None
        if memory is None:
            raise HTTPException(404, "记忆不存在或已删除。")
        return memory

    @router.delete("/learner-memories/{memory_id}", status_code=204)
    def delete_memory(memory_id: str):
        if not store.delete_memory(memory_id, student):
            raise HTTPException(404, "记忆不存在或已删除。")
        return Response(status_code=204)

    return router

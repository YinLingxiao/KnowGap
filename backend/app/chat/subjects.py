"""Subjects: Project-like folders that own conversations, instructions, course files and memories."""

from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel, Field

from app.chat.cheatsheet import build_cheatsheet
from app.chat.insights import subject_insights

from app.chat.schemas import Conversation, ConversationSummary, CreateSubject, CreateThread, Subject, UpdateSubject
from app.chat.store import ChatStore
from app.auth.deps import current_student


class CheatSheetRequest(BaseModel):
    force: bool = False
    # The space's Pages notes live in the browser; the client may send them as extra source material.
    notes: str = Field(default="", max_length=20000)


def subject_router(store: ChatStore, service=None) -> APIRouter:
    router = APIRouter(prefix="/api/subjects", tags=["Subject"])
    @router.get("", response_model=list[Subject])
    def list_subjects():
        return store.subjects(current_student())

    @router.post("", response_model=Subject, status_code=201)
    def create_subject(body: CreateSubject):
        return store.create_subject(
            current_student(), body.name, body.description, body.instructions,
            goal=body.goal, level=body.level, deadline=body.deadline, color=body.color,
        )

    @router.get("/{subject_id}", response_model=Subject)
    def get_subject(subject_id: str):
        subject = store.subject(subject_id, current_student())
        if subject is None:
            raise HTTPException(404, "Subject 不存在或已删除。")
        return subject

    @router.patch("/{subject_id}", response_model=Subject)
    def update_subject(subject_id: str, body: UpdateSubject):
        subject = store.update_subject(subject_id, current_student(), body.model_dump(exclude_unset=True))
        if subject is None:
            raise HTTPException(404, "Subject 不存在或已删除。")
        return subject

    @router.get("/{subject_id}/usage")
    def subject_usage(subject_id: str):
        if store.subject(subject_id, current_student()) is None:
            raise HTTPException(404, "学习空间不存在。")
        return store.usage(current_student(), subject_id=subject_id)

    @router.get("/{subject_id}/insights")
    def get_insights(subject_id: str):
        insights = subject_insights(store, current_student(), subject_id)
        if insights is None:
            raise HTTPException(404, "学习空间不存在或已删除。")
        return insights

    @router.post("/{subject_id}/cheatsheet")
    async def cheatsheet(subject_id: str, body: CheatSheetRequest | None = None):
        body = body or CheatSheetRequest()
        sheet = await build_cheatsheet(store, service, current_student(), subject_id, notes=body.notes, force=body.force)
        if sheet is None:
            raise HTTPException(404, "学习空间不存在或已删除。")
        return sheet

    @router.get("/{subject_id}/threads", response_model=list[ConversationSummary])
    def list_threads(subject_id: str):
        threads = store.threads(subject_id, current_student())
        if threads is None:
            raise HTTPException(404, "学习空间不存在或已删除。")
        if service is not None:
            for item in threads:
                item.generating = service.is_generating(item.id)
        return threads

    @router.post("/{subject_id}/threads", response_model=Conversation, status_code=201)
    def create_thread(subject_id: str, body: CreateThread):
        try:
            thread_id = store.create_thread(
                current_student(), subject_id, title=body.title, anchor_message_id=body.anchor_message_id,
                client_request_id=body.client_request_id,
            )
        except LookupError as exc:
            raise HTTPException(404, str(exc)) from None
        conversation = store.conversation(thread_id, current_student())
        if conversation is None:
            raise HTTPException(404, "Thread 不存在或已删除。")
        return conversation

    @router.delete("/{subject_id}", status_code=204)
    def delete_subject(subject_id: str):
        if not store.delete_subject(subject_id, current_student()):
            raise HTTPException(404, "Subject 不存在或已删除。")
        return Response(status_code=204)

    return router

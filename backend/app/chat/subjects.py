"""Subjects: Project-like folders that own conversations, instructions, course files and memories."""

from fastapi import APIRouter, HTTPException, Response

from app.chat.schemas import Conversation, ConversationSummary, CreateSubject, CreateThread, Subject, UpdateSubject
from app.chat.store import ChatStore
from app.models.schemas import DEMO_STUDENT


def subject_router(store: ChatStore, service=None) -> APIRouter:
    router = APIRouter(prefix="/api/subjects", tags=["Subject"])
    student = DEMO_STUDENT

    @router.get("", response_model=list[Subject])
    def list_subjects():
        return store.subjects(student)

    @router.post("", response_model=Subject, status_code=201)
    def create_subject(body: CreateSubject):
        return store.create_subject(
            student, body.name, body.description, body.instructions,
            goal=body.goal, level=body.level, deadline=body.deadline, color=body.color,
        )

    @router.get("/{subject_id}", response_model=Subject)
    def get_subject(subject_id: str):
        subject = store.subject(subject_id, student)
        if subject is None:
            raise HTTPException(404, "Subject 不存在或已删除。")
        return subject

    @router.patch("/{subject_id}", response_model=Subject)
    def update_subject(subject_id: str, body: UpdateSubject):
        subject = store.update_subject(subject_id, student, body.model_dump(exclude_unset=True))
        if subject is None:
            raise HTTPException(404, "Subject 不存在或已删除。")
        return subject

    @router.get("/{subject_id}/threads", response_model=list[ConversationSummary])
    def list_threads(subject_id: str):
        threads = store.threads(subject_id, student)
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
                student, subject_id, title=body.title, anchor_message_id=body.anchor_message_id,
                client_request_id=body.client_request_id,
            )
        except LookupError as exc:
            raise HTTPException(404, str(exc)) from None
        conversation = store.conversation(thread_id, student)
        if conversation is None:
            raise HTTPException(404, "Thread 不存在或已删除。")
        return conversation

    @router.delete("/{subject_id}", status_code=204)
    def delete_subject(subject_id: str):
        if not store.delete_subject(subject_id, student):
            raise HTTPException(404, "Subject 不存在或已删除。")
        return Response(status_code=204)

    return router

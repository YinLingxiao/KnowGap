"""Subjects: Project-like folders that own conversations, instructions, course files and memories."""

from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel, Field

from app.chat.cheatsheet import build_cheatsheet
from app.chat.concept_graph import build_concept_graph
from app.chat.insights import subject_insights

from app.chat.schemas import Conversation, ConversationSummary, CreateSubject, CreateThread, Subject, UpdateSubject
from app.chat.store import ChatStore
from app.memory import space_notes
from app.auth.deps import current_student


class CheatSheetRequest(BaseModel):
    force: bool = False
    # The space's Pages notes live in the browser; the client may send them as extra source material.
    notes: str = Field(default="", max_length=20000)


class ConceptGraphRequest(BaseModel):
    force: bool = False


class MemoryNotesBody(BaseModel):
    content: str = Field(default="", max_length=8000)


def subject_router(store: ChatStore, service=None) -> APIRouter:
    router = APIRouter(prefix="/api/subjects", tags=["Subject"])
    @router.get("", response_model=list[Subject])
    def list_subjects():
        return store.subjects(current_student())

    @router.post("", response_model=Subject, status_code=201)
    def create_subject(body: CreateSubject):
        return store.create_subject(
            current_student(), body.name, body.description, body.instructions,
            goal=body.goal, level=body.level, deadline=body.deadline, color=body.color, icon=body.icon,
        )

    @router.get("/{subject_id}", response_model=Subject)
    def get_subject(subject_id: str):
        subject = store.subject(subject_id, current_student())
        if subject is None:
            raise HTTPException(404, "Subject 不存在或已删除。")
        return subject

    @router.patch("/{subject_id}", response_model=Subject)
    def update_subject(subject_id: str, body: UpdateSubject):
        changes = body.model_dump(exclude_unset=True)
        if "thread_model_key" in changes:
            # 空白等于「跟随主线」
            changes["thread_model_key"] = (changes["thread_model_key"] or "").strip() or None
        library = getattr(service, "model_library", None)
        key = changes.get("thread_model_key")
        if key and library is not None and library.effective_key(key) != key:
            raise HTTPException(404, "这个模型不存在或未启用。")
        subject = store.update_subject(subject_id, current_student(), changes)
        if subject is None:
            raise HTTPException(404, "Subject 不存在或已删除。")
        return subject

    @router.get("/{subject_id}/usage")
    def subject_usage(subject_id: str):
        if store.subject(subject_id, current_student()) is None:
            raise HTTPException(404, "学习空间不存在。")
        return store.usage(current_student(), subject_id=subject_id)

    def _view_or_404(subject_id: str) -> dict:
        view = store.space_memory_view(current_student(), subject_id)
        if view is None:  # 例如刚好被并发删掉
            raise HTTPException(404, "学习空间不存在。")
        return view

    @router.get("/{subject_id}/memory-notes")
    def memory_notes(subject_id: str):
        """本空间的 Memory.md：条目、最近写入记录（来源：支线合并 / 主线整理 / 手动编辑）。"""
        return _view_or_404(subject_id)

    @router.put("/{subject_id}/memory-notes")
    def replace_memory_notes(subject_id: str, body: MemoryNotesBody):
        result = store.replace_space_memory(current_student(), subject_id, body.content)
        if result is None:
            raise HTTPException(404, "学习空间不存在。")
        if not result.startswith(space_notes.OK_PREFIX):
            raise HTTPException(400, result)
        return {"result": result, **_view_or_404(subject_id)}

    @router.post("/{subject_id}/memory-notes/{log_id}/revoke")
    def revoke_memory_note(subject_id: str, log_id: str):
        result = store.revoke_space_memory(current_student(), subject_id, log_id)
        if result is None:
            raise HTTPException(404, "学习空间或这次写入不存在。")
        if not result.startswith(space_notes.OK_PREFIX):
            raise HTTPException(409, result)
        return {"result": result, **_view_or_404(subject_id)}

    @router.get("/{subject_id}/thread-notes")
    def thread_notes(subject_id: str):
        """已合并支线的小结卡：每条支线的记忆。"""
        notes = store.space_thread_notes(current_student(), subject_id)
        if notes is None:
            raise HTTPException(404, "学习空间不存在。")
        return notes

    @router.get("/{subject_id}/memory-sync")
    def memory_sync_state(subject_id: str):
        state = store.space_memory_sync_state(current_student(), subject_id)
        if state is None:
            raise HTTPException(404, "学习空间不存在。")
        return state

    @router.post("/{subject_id}/memory-sync")
    def sync_memory_now(subject_id: str):
        """立即把这个空间的记忆摘要写进总记忆（USER 笔记），不等间隔。"""
        # 手动点「立即同步」本身就是确认：即使开了「写入前确认」也直接写，不排队。
        result = store.sync_space_memory(current_student(), subject_id, force=True)
        if result is None:
            raise HTTPException(404, "学习空间不存在。")
        return result

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

    @router.post("/{subject_id}/concept-graph")
    async def concept_graph(subject_id: str, body: ConceptGraphRequest | None = None):
        body = body or ConceptGraphRequest()
        graph = await build_concept_graph(store, service, current_student(), subject_id, force=body.force)
        if graph is None:
            raise HTTPException(404, "学习空间不存在或已删除。")
        return graph

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
            raise HTTPException(404, "支线不存在或已删除。")
        return conversation

    @router.delete("/{subject_id}", status_code=204)
    def delete_subject(subject_id: str):
        if not store.delete_subject(subject_id, current_student()):
            raise HTTPException(404, "Subject 不存在或已删除。")
        return Response(status_code=204)

    return router

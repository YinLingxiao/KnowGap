"""Course material endpoints for the existing fixed local-demo identity."""
import asyncio
from collections.abc import Awaitable, Callable
from contextlib import suppress
from typing import Annotated

from fastapi import APIRouter, File, HTTPException, Query, Request, Response, UploadFile
from starlette.concurrency import run_in_threadpool

from app.auth.deps import current_student
from app.models.schemas import DEMO_STUDENT, SourceReference
from app.services.materials import MAX_UPLOAD_BYTES, Material, MaterialStore, UploadCancelled, UploadGuard


DISCONNECT_POLL_SECONDS = 0.5


async def unless_disconnected(library: MaterialStore, guard: UploadGuard, job: Awaitable[Material],
                              disconnected: Callable[[], Awaitable[bool]],
                              poll: float = DISCONNECT_POLL_SECONDS) -> Material:
    """解析可能要几分钟（识图）。前端取消上传就是断开连接：停掉解析，已经写进去的删掉，不留半截资料。"""
    task = asyncio.ensure_future(job)
    while True:
        done, _ = await asyncio.wait({task}, timeout=poll)
        if done:
            return task.result()
        if await disconnected():
            break
    guard.cancelled.set()
    task.cancel()
    with suppress(asyncio.CancelledError, UploadCancelled, HTTPException):
        await task
    if guard.inserted:
        library.delete(guard.inserted, guard.student_id)
    raise HTTPException(499, '上传已取消。')


def material_router(library: MaterialStore, subject_exists: Callable[[str], bool] = lambda _: False) -> APIRouter:
    router = APIRouter(prefix='/api/materials', tags=['课程资料'])

    def owner(request: Request, student_id: str | None) -> str:
        if request.headers.get("authorization"):
            return current_student()
        if student_id not in (None, DEMO_STUDENT):
            raise HTTPException(422, 'student_id 无效。')
        return DEMO_STUDENT

    def check_subject(subject_id: str | None) -> None:
        if subject_id is not None and not subject_exists(subject_id):
            raise HTTPException(404, 'Subject 不存在或已删除。')

    @router.get('', response_model=list[Material])
    def list_materials(request: Request, student_id: str | None = None, subject_id: str | None = None, unassigned: bool = False):
        return library.list_materials(owner(request, student_id), subject_id, unassigned)

    @router.post('', response_model=Material, status_code=201)
    async def upload_material(request: Request, file: Annotated[UploadFile, File()], student_id: str | None = None,
                              subject_id: str | None = None):
        check_subject(subject_id)
        try:
            data = await file.read(MAX_UPLOAD_BYTES + 1)
            if len(data) > MAX_UPLOAD_BYTES:
                raise HTTPException(413, '单份资料不能超过 100 MB。')
            student = owner(request, student_id)
            guard = UploadGuard(student_id=student)
            return await unless_disconnected(
                library, guard, library.add_with_ocr(student, file.filename or '', data, subject_id, guard),
                request.is_disconnected)
        finally:
            await file.close()

    @router.get('/{document_id}/outline')
    def material_outline(document_id: str, request: Request, student_id: str | None = None):
        result = library.attachment(document_id, owner(request, student_id))
        if result is None:
            raise HTTPException(404, '资料不存在或已删除。')
        return {'outline': result['outline']}

    @router.get('/{document_id}/text')
    def material_text(document_id: str, request: Request, student_id: str | None = None):
        result = library.extracted_text(document_id, owner(request, student_id))
        if result is None:
            raise HTTPException(404, '资料不存在或已删除。')
        return result

    @router.get('/search', response_model=list[SourceReference])
    def search_materials(request: Request, q: Annotated[str, Query(min_length=1, max_length=600)],
                         limit: Annotated[int, Query(ge=1, le=10)] = 5,
                         student_id: str | None = None):
        query = q.strip()
        if not query:
            raise HTTPException(422, '搜索内容不能为空。')
        return library.search(owner(request, student_id), query, limit)

    @router.delete('/{document_id}', status_code=204)
    def delete_material(document_id: str, request: Request, student_id: str | None = None):
        if not library.delete(document_id, owner(request, student_id)):
            raise HTTPException(404, '资料不存在或已删除。')
        return Response(status_code=204)

    return router

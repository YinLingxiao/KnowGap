"""Course material endpoints for the existing fixed local-demo identity."""
from collections.abc import Callable
from typing import Annotated

from fastapi import APIRouter, File, HTTPException, Query, Request, Response, UploadFile
from starlette.concurrency import run_in_threadpool

from app.auth.deps import current_student
from app.models.schemas import DEMO_STUDENT, Material, SourceReference
from app.services.materials import MAX_UPLOAD_BYTES, MaterialStore


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
                raise HTTPException(413, '单份资料不能超过 5 MB。')
            return await run_in_threadpool(library.add, owner(request, student_id), file.filename or '', data, subject_id)
        finally:
            await file.close()

    @router.get('/search', response_model=list[SourceReference])
    def search_materials(request: Request, q: Annotated[str, Query(min_length=1, max_length=600)],
                         limit: Annotated[int, Query(ge=1, le=10)] = 5,
                         student_id: str | None = None):
        return library.search(owner(request, student_id), q.strip(), limit)

    @router.delete('/{document_id}', status_code=204)
    def delete_material(document_id: str, request: Request, student_id: str | None = None):
        if not library.delete(document_id, owner(request, student_id)):
            raise HTTPException(404, '资料不存在或已删除。')
        return Response(status_code=204)

    return router

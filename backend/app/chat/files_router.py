"""下载 AI 生成的文件和学生自己上传的原件。"""

from urllib.parse import quote

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from starlette.concurrency import run_in_threadpool

from app.auth.deps import current_student
from app.services.file_store import FileStore, public
from app.services.office_writers import MIME


def files_router(files: FileStore) -> APIRouter:
    router = APIRouter(prefix="/api/files", tags=["文件"])

    @router.get("/{file_id}")
    async def file_info(file_id: str):
        found = await run_in_threadpool(files.get, file_id, current_student())
        if found is None:
            raise HTTPException(404, "文件不存在或已被删除。")
        return public(found[0])

    @router.get("/{file_id}/download")
    async def download(file_id: str):
        found = await run_in_threadpool(files.get, file_id, current_student())
        if found is None:
            raise HTTPException(404, "文件不存在或已被删除。")
        record, data = found
        disposition = f"attachment; filename*=UTF-8''{quote(record['name'])}"
        return Response(data, media_type=MIME.get(record["kind"], "application/octet-stream"),
                        headers={"Content-Disposition": disposition, "Cache-Control": "private, no-store"})

    return router

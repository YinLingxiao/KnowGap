"""Local settings endpoints for the web-search (AnySearch) key; the key is never returned."""

from fastapi import APIRouter, Request, Response
from pydantic import SecretStr
from starlette.concurrency import run_in_threadpool

from app.services.anysearch import AnySearchClient
from app.services.search_settings import clean_key


def search_settings_router(store, settings, guard, transport=None):
    router = APIRouter(prefix="/api/search", tags=["联网搜索"])

    @router.get("/config")
    async def get_config(request: Request, response: Response):
        guard(request)
        response.headers["Cache-Control"] = "no-store"
        return await run_in_threadpool(store.status)

    @router.put("/config")
    async def save_config(request: Request, body: dict):
        guard(request)
        # 空串或 null 表示清除设置页保存的密钥，回到环境变量 / 匿名额度。
        return await run_in_threadpool(store.save, body.get("anysearch_api_key"))

    @router.post("/test")
    async def test_config(request: Request, body: dict | None = None):
        guard(request)
        # 不保存：填了就测填的，没填就测当前生效的密钥。
        candidate = clean_key((body or {}).get("anysearch_api_key")) or store.key()
        probe = settings.model_copy(update={"anysearch_api_key": SecretStr(candidate)})
        result = await AnySearchClient(probe, transport).search("Cache 直接映射", 1)
        return {"status": "ok", "results": len(result.results)}

    return router

"""Local settings endpoints for ChatGPT plan OAuth; the callback uses its own loopback listener."""

from fastapi import APIRouter, Request
from starlette.concurrency import run_in_threadpool

from app.services.chatgpt_oauth_listener import start_listener


def chatgpt_router(auth, ai_settings, guard):
    router = APIRouter(prefix="/api/chatgpt", tags=["ChatGPT 套餐"])

    @router.post("/start")
    async def start(request: Request):
        guard(request)
        # Replace a stale listener/attempt; starting a new login invalidates the old one.
        await run_in_threadpool(auth.close)
        redirect = await run_in_threadpool(start_listener, auth)
        try:
            result = await run_in_threadpool(auth.begin, redirect)
        except Exception:
            await run_in_threadpool(auth.close)
            raise
        return {**result, "auth_mode": "chatgpt",
                "base_url": "https://api.openai.com/v1"}

    @router.get("/status")
    async def status(request: Request):
        guard(request)
        return await run_in_threadpool(auth.status)

    @router.post("/logout")
    async def logout(request: Request):
        guard(request)
        return await run_in_threadpool(auth.logout)

    @router.get("/models")
    async def models(request: Request):
        guard(request)
        return {"models": await run_in_threadpool(auth.models)}

    return router

"""POST /api/sandbox/run。由负责人统一挂载：

    from app.code_sandbox.router import sandbox_router
    app.include_router(sandbox_router(allowed_origins=settings.cors_origins))

这个接口会执行任意代码，而项目本身没有真实鉴权（没有 Authorization 时回落到演示身份），
所以接口自带访问限制：只接受本机回环访问，并校验 Host / Origin 防 DNS 重绑定与跨站请求；
同时最多并发 2 个运行，超出直接 429。
"""

from __future__ import annotations

import logging
import os
import threading
from collections.abc import Awaitable, Callable, Iterable
from urllib.parse import urlsplit

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.routing import APIRoute
from starlette.concurrency import run_in_threadpool

from app.code_sandbox.runner import ToolchainMissing, run_sandbox
from app.code_sandbox.schemas import RunRequest, RunResponse

logger = logging.getLogger(__name__)

MAX_CONCURRENT_RUNS = 2
MAX_BODY_BYTES = 256 * 1024
ALLOW_REMOTE_ENV = "KNOWGAP_SANDBOX_ALLOW_REMOTE"

_LOOPBACK_CLIENTS = {"127.0.0.1", "::1"}
_LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}
# 全局槽位：多个 router 实例、多个请求共用，保护本机 CPU 与内存。
_slots = threading.BoundedSemaphore(MAX_CONCURRENT_RUNS)


def _hostname(value: str) -> str | None:
    try:
        return urlsplit(value if "//" in value else f"//{value}").hostname
    except ValueError:
        return None


def _require_local(request: Request, allowed_origins: frozenset[str]) -> None:
    if os.environ.get(ALLOW_REMOTE_ENV) == "1":
        return
    client = request.client.host if request.client else None
    is_test_client = client == "testclient"  # 只有 Starlette 的 TestClient 会产生这个值
    if client not in _LOOPBACK_CLIENTS and not is_test_client:
        raise HTTPException(403, "代码沙盒仅允许从本机访问。")
    host = _hostname(request.headers.get("host", ""))
    if host not in _LOOPBACK_HOSTS and not (is_test_client and host == "testserver"):
        raise HTTPException(403, "代码沙盒仅允许通过 localhost 访问。")
    origin = request.headers.get("origin")
    if origin and origin != "null":
        if _hostname(origin) not in _LOOPBACK_HOSTS and origin.rstrip("/") not in allowed_origins:
            raise HTTPException(403, "此页面无权使用代码沙盒。")
    elif origin == "null":
        raise HTTPException(403, "此页面无权使用代码沙盒。")


def sandbox_router(allowed_origins: Iterable[str] = ()) -> APIRouter:
    origins = frozenset(item.rstrip("/") for item in allowed_origins)

    class GuardedRoute(APIRoute):
        """FastAPI 会先解析并校验请求体，再进入处理函数；访问限制必须赶在这之前，
        否则非本机客户端发来坏请求体会得到 422 而不是 403，超大请求体也已经被读完了。"""

        def get_route_handler(self) -> Callable[[Request], Awaitable[Response]]:
            original = super().get_route_handler()

            async def handler(request: Request) -> Response:
                _require_local(request, origins)
                declared = request.headers.get("content-length")
                if declared and declared.isdigit() and int(declared) > MAX_BODY_BYTES:
                    raise HTTPException(413, "请求内容过大。")
                return await original(request)

            return handler

    router = APIRouter(prefix="/api/sandbox", tags=["代码沙盒"], route_class=GuardedRoute)

    @router.post("/run", response_model=RunResponse)
    async def run(body: RunRequest) -> RunResponse:
        if not _slots.acquire(blocking=False):
            raise HTTPException(429, "沙盒正忙，请稍后重试。")
        try:
            return await run_in_threadpool(run_sandbox, body)
        except ToolchainMissing as exc:
            raise HTTPException(503, str(exc)) from None
        finally:
            _slots.release()

    return router

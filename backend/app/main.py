"""KnowGap local-demo API. Run with uvicorn app.main:app --reload."""

import logging
import sqlite3
from contextlib import asynccontextmanager
from typing import Literal

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.exception_handlers import request_validation_exception_handler
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.agents.llm import ChatCompletionsTutor, ProviderError, Tutor
from app.config import Settings
from app.memory.store import StateConflict, Store
from app.models.schemas import (
    DEMO_STUDENT, DiagnosisRequest, Memory, MessageRequest, Problem, Session, TeachingResponse,
)
from app.services.problems import PROBLEMS
from app.services.teaching import teach
from app.services.ai_settings import AISettings

logger = logging.getLogger(__name__)
DemoStudent = Literal["demo-student-001"]


def create_app(settings: Settings | None = None, tutor: Tutor | None = None) -> FastAPI:
    settings = settings or Settings()
    store = Store(settings.resolved_database_path())
    ai_settings = AISettings(settings)
    model = tutor if tutor is not None else ChatCompletionsTutor(ai_settings.current)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        store.initialize()
        yield

    app = FastAPI(title="KnowGap API", version="0.2.0", lifespan=lifespan)
    app.state.store = store
    app.state.tutor = model
    app.add_middleware(
        CORSMiddleware, allow_origins=settings.cors_origins,
        allow_credentials=False, allow_methods=["GET", "POST", "PUT", "DELETE"], allow_headers=["Content-Type"],
    )

    @app.exception_handler(ProviderError)
    async def provider_error(request: Request, exc: ProviderError):
        return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, exc: RequestValidationError):
        if request.url.path in {"/api/ai/config", "/api/ai/test"}:
            # FastAPI's default validation details include the rejected input, possibly a key.
            return JSONResponse(status_code=422, content={"detail": "AI 配置请求格式无效，请提交 JSON 对象。"})
        return await request_validation_exception_handler(request, exc)

    @app.exception_handler(StateConflict)
    async def conflict_error(request: Request, exc: StateConflict):
        return JSONResponse(status_code=409, content={"detail": str(exc)})

    @app.exception_handler(sqlite3.Error)
    async def storage_error(request: Request, exc: sqlite3.Error):
        logger.error("SQLite request failed (%s)", type(exc).__name__)
        return JSONResponse(status_code=503, content={"detail": "学习记录暂时无法保存或读取，请稍后重试。"})

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    def require_local_configuration(request: Request):
        # Configuration is a local-demo facility, not an unauthenticated deployment API.
        if not request.client or request.client.host not in {"127.0.0.1", "::1", "testclient"}:
            raise HTTPException(403, "AI 配置仅允许从本机访问。")
        origin = request.headers.get("origin")
        if origin and origin not in settings.cors_origins:
            raise HTTPException(403, "此页面无权访问 AI 配置。")

    @app.get("/api/ai/config")
    def get_ai_config(request: Request, response: Response):
        require_local_configuration(request)
        response.headers["Cache-Control"] = "no-store"
        return ai_settings.status()

    @app.put("/api/ai/config")
    def save_ai_config(request: Request, body: dict):
        require_local_configuration(request)
        status = ai_settings.save(body)
        if tutor is None:
            model.settings = ai_settings.current
        return status

    @app.post("/api/ai/test")
    async def test_ai_config(request: Request, body: dict | None = None):
        require_local_configuration(request)
        candidate = ai_settings.candidate(body) if body is not None else ai_settings.current
        # Exercise the actual structured tutor output, without saving a session or memory.
        await ChatCompletionsTutor(candidate).generate({
            "phase": "initial", "current_answer": "栈遵循后进先出。",
            "problem": {"prompt": "说明栈的出入顺序。"},
            "reference": {"explanation": "栈遵循后进先出。"},
            "history": [], "memories": [],
        })
        return {"status": "ok", "model": candidate.llm_model, "structured_output": True}

    @app.get("/api/problems", response_model=list[Problem])
    def problems():
        return list(PROBLEMS.values())

    @app.post("/api/diagnosis", response_model=TeachingResponse)
    async def diagnosis(body: DiagnosisRequest):
        return await teach(store, model, body)

    @app.get("/api/sessions/{session_id}", response_model=Session)
    def get_session(session_id: str, student_id: DemoStudent = DEMO_STUDENT):
        session = store.session(session_id, student_id)
        if session is None:
            raise HTTPException(404, "会话不存在，请开启新会话。")
        return session

    @app.post("/api/sessions/{session_id}/messages", response_model=TeachingResponse)
    async def message(session_id: str, body: MessageRequest):
        session = get_session(session_id)
        return await teach(store, model, DiagnosisRequest(
            student_id=session.student_id, problem_id=session.problem_id, answer=body.content,
        ), session)

    @app.get("/api/memories", response_model=list[Memory])
    def memories(student_id: DemoStudent = DEMO_STUDENT):
        return store.memories(student_id)

    @app.delete("/api/memories/{memory_id}", status_code=204)
    def delete_memory(memory_id: str, student_id: DemoStudent = DEMO_STUDENT):
        if not store.delete_memory(memory_id, student_id):
            raise HTTPException(404, "记忆不存在或已删除。")
        return Response(status_code=204)

    return app


app = create_app()


"""KnowGap local-demo API. Run with uvicorn app.main:app --reload."""

import logging
import sqlite3
from contextlib import asynccontextmanager
from typing import Literal
from urllib.parse import urlsplit

from fastapi import FastAPI, HTTPException, Request, Response, Query
from fastapi.exceptions import RequestValidationError
from fastapi.exception_handlers import request_validation_exception_handler
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from app.agents.llm import shared_ssl_context, ChatCompletionsChat, ChatCompletionsTutor, ChatModel, ProviderError, Tutor
from app.config import Settings
from app.memory.store import StateConflict, Store
from app.models.schemas import (
    DEMO_STUDENT, DiagnosisRequest, Memory, MessageRequest, Problem, Session, TeachingResponse,
)
from app.services.problems import PROBLEMS
from app.services.teaching import teach
from app.services.ai_settings import AISettings
from app.services.anysearch import AnySearchClient, SearchService
from app.models.schemas import WebSearchResponse
from app.services.materials import MaterialStore
from app.api.materials import material_router
from app.auth.deps import current_student, reset_student, set_student
from app.auth.router import auth_router
from app.auth.store import AuthStore
from app.chat.router import chat_router
from app.chat.subjects import subject_router
from app.chat.service import ChatService
from app.chat.store import ChatStore
from app.code_sandbox.router import sandbox_router
from app.focus.router import focus_router
from app.vision.router import vision_router
from app.vision.settings import ServiceModels
from app.vision.store import VisionStore

logger = logging.getLogger(__name__)
DemoStudent = Literal["demo-student-001"]


def _local_page(origin: str) -> bool:
    host = urlsplit(origin).hostname
    return host in {"127.0.0.1", "localhost", "::1"}


def create_app(
    settings: Settings | None = None, tutor: Tutor | None = None, search_service: SearchService | None = None,
    chat_model: ChatModel | None = None,
) -> FastAPI:
    settings = settings or Settings()
    store = Store(settings.resolved_database_path())
    library = MaterialStore(store)
    ai_settings = AISettings(settings)
    model = tutor if tutor is not None else ChatCompletionsTutor(ai_settings.current)
    search = search_service if search_service is not None else AnySearchClient(settings)
    chat = chat_model if chat_model is not None else ChatCompletionsChat(ai_settings.current)
    chat_store = ChatStore(store)
    chat_service = ChatService(chat_store, lambda: chat, library, ai_settings)
    auth_store = AuthStore(store)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        store.initialize()
        auth_store.ensure()
        library.initialize()
        chat_store.initialize()
        await run_in_threadpool(shared_ssl_context)
        chat_service.recover()
        try:
            yield
        finally:
            await chat_service.close()

    app = FastAPI(title="KnowGap API", version="0.2.0", lifespan=lifespan)
    app.state.store = store
    app.state.tutor = model
    app.state.search = search
    app.state.materials = library
    app.state.chat_service = chat_service
    app.state.auth = auth_store
    vision_store = VisionStore.for_app(settings)
    service_models = ServiceModels(ai_settings)
    app.state.vision_store = vision_store
    app.state.service_models = service_models
    app.include_router(material_router(library, lambda subject_id: chat_store.subject(subject_id, current_student()) is not None))
    app.include_router(chat_router(chat_store, chat_service))
    app.include_router(subject_router(chat_store, chat_service))
    app.include_router(auth_router(auth_store, chat_store, settings))
    app.include_router(sandbox_router(allowed_origins=settings.cors_origins))
    app.include_router(vision_router(vision_store, service_models, cors_origins=settings.cors_origins))
    app.include_router(focus_router(store))

    @app.middleware("http")
    async def bind_student(request: Request, call_next):
        try:
            student_id = auth_store.student_from_request(request)
        except HTTPException as exc:
            return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})
        token = set_student(student_id)
        try:
            return await call_next(request)
        finally:
            reset_student(token)

    app.add_middleware(
        CORSMiddleware, allow_origins=settings.cors_origins,
        allow_credentials=False, allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
        allow_headers=["Content-Type", "Authorization"],
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
        if origin and not _local_page(origin) and origin not in settings.cors_origins:
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
        if chat_model is None:
            chat.settings = ai_settings.current
        return status

    @app.get("/api/agent/settings")
    def get_agent_settings(request: Request):
        require_local_configuration(request)
        return ai_settings.agent_config()

    @app.put("/api/agent/settings")
    def save_agent_settings(request: Request, body: dict):
        require_local_configuration(request)
        return ai_settings.save_agent(body)

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

    @app.get('/api/search', response_model=WebSearchResponse)
    async def web_search(q: str = Query(min_length=1, max_length=600), limit: int = Query(default=5, ge=1, le=10)):
        query = q.strip()
        if not query:
            raise HTTPException(422, '请输入搜索关键词。')
        return await search.search(query, limit)

    @app.post("/api/diagnosis", response_model=TeachingResponse)
    async def diagnosis(body: DiagnosisRequest):
        return await teach(store, model, body, search_service=search, library=library)

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
            student_id=session.student_id, problem_id=session.problem_id, answer=body.content, web_search=body.web_search,
        ), session, search_service=search, library=library)

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

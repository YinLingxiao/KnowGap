"""Free-chat endpoints. Conversations do not require a problem; exercises are optional context."""

from collections import OrderedDict

from fastapi import APIRouter, HTTPException, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.agents.llm import ProviderError
from app.chat.schemas import (
    ConfirmProposal, Conversation, ConversationSummary, CreateConversation, LearnerMemory, Resolution, ResolveThread, SendMessage,
    StartExercise, UpdateConversation, UpdateMemory,
)
from app.models.model_library_schemas import ConversationModelUpdate
from app.chat.service import ChatService
from app.chat.store import UNSET, ChatStore
from app.auth.deps import current_student
from app.services.problems import PROBLEMS

SUGGEST_MIN_CHARS, SUGGEST_MAX_CHARS, SUGGEST_CACHE_LIMIT = 12, 80, 256
STREAM_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}


class ToolApprovalBody(BaseModel):
    allow: bool


class WelcomeBody(BaseModel):
    text: str = Field(min_length=1, max_length=200)


class LearningPreferencesBody(BaseModel):
    background: str = ""
    explanation: str = ""
    interaction: str = ""


class PreferenceDecision(BaseModel):
    allow: bool


class AgentNoteBody(BaseModel):
    target: str = Field(pattern="^(user|memory)$")
    content: str = ""


class PendingDecision(BaseModel):
    allow: bool


class ConfirmProfile(BaseModel):
    version: int
    entries: dict[str, str]


class CreateCustomSkillBody(BaseModel):
    name: str
    role: str = "thread"
    trigger_keywords: str = ""
    content: str


class PatchCustomSkillBody(BaseModel):
    enabled: bool | None = None
    name: str | None = None
    role: str | None = None
    trigger_keywords: str | None = None
    content: str | None = None


def chat_router(store: ChatStore, service: ChatService) -> APIRouter:
    router = APIRouter(prefix="/api", tags=["自由对话"])
    def require(conversation_id: str) -> Conversation:
        conversation = store.conversation(conversation_id, current_student())
        if conversation is None:
            raise HTTPException(404, "会话不存在或已删除。")
        conversation.generating = service.is_generating(conversation_id)
        return conversation

    def require_idle(conversation_id: str) -> None:
        if service.is_generating(conversation_id):
            raise HTTPException(409, "上一条回复仍在生成，请先停止或稍候。")
        if not service.has_thread_slot(current_student(), conversation_id):
            raise HTTPException(409, "本空间已有 2 个支线正在执行，请稍候再发送。")

    def require_subject(subject_id: str | None) -> None:
        if subject_id is not None and store.subject(subject_id, current_student()) is None:
            raise HTTPException(404, "Subject 不存在或已删除。")

    def stream(body) -> StreamingResponse:
        return StreamingResponse(body, media_type="text/event-stream", headers=STREAM_HEADERS)

    @router.get("/conversations", response_model=list[ConversationSummary])
    def list_conversations(subject_id: str | None = None):
        items = store.list_conversations(current_student(), subject_id)
        for item in items:
            item.generating = service.is_generating(item.id)
        return items

    @router.post("/conversations", response_model=Conversation, status_code=201)
    def create_conversation(body: CreateConversation):
        problem = None
        if body.problem_id:
            problem = PROBLEMS.get(body.problem_id)
            if problem is None:
                raise HTTPException(404, "练习题不存在。")
        require_subject(body.subject_id)
        conversation_id = store.create_conversation(
            current_student(), title=body.title, problem=problem, client_request_id=body.client_request_id,
            subject_id=body.subject_id,
        )
        return require(conversation_id)

    _suggest_cache: OrderedDict[tuple[str, str], str] = OrderedDict()

    @router.get("/conversations/{conversation_id}", response_model=Conversation)
    def get_conversation(conversation_id: str):
        return require(conversation_id)

    @router.get("/conversations/{conversation_id}/suggest-reply")
    async def suggest_reply(conversation_id: str):
        conv = require(conversation_id)
        if conv.generating:
            return {"suggestion": "", "message_id": None}
        if hasattr(service.settings, "_raw"):
            sm = service.settings._raw().get("service_models")
            if isinstance(sm, dict) and sm.get("suggest_reply_enabled") is False:
                return {"suggestion": "", "message_id": None}
        history = [
            row for row in store.history(conversation_id)
            if row["status"] == "complete" and (row["content"] or "").strip()
        ]
        if not history or history[-1]["role"] != "assistant":
            return {"suggestion": "", "message_id": None}
        last_msg = history[-1]
        cache_key = (conversation_id, last_msg["id"])
        if cache_key in _suggest_cache:
            _suggest_cache.move_to_end(cache_key)
            return {"suggestion": _suggest_cache[cache_key], "message_id": last_msg["id"]}
        snippet_turns = []
        for row in history[-4:]:
            role = "user" if row["role"] == "user" else "assistant"
            snippet_turns.append(f"[{role}]: {row['content'][:800]}")
        prompt = (
            "你是智能输入框的『下一步追问补全器』。请根据下方对话的最后一轮 assistant 回复，"
            "站在【用户（学习者）】第一人称视角，预测用户最可能顺着 AI 的话往下接的一句自然、具体、可直接发送的回复或推进指令（20~65个字）。\n"
            "要求：\n"
            "1. 必须用第一人称口吻（如『那就按你说的…』『好，我们先从…开始，结合具体例子讲讲…』『我理解核心是…，那如果遇到…情况呢？』）。\n"
            "2. 紧扣 assistant 最后一段提出的问题、分支建议或下一步行动，不要空泛客套。\n"
            "3. 只输出这一句预测文本本身，不要加引号、不要加任何前缀或解释。\n\n"
            + "\n\n".join(snippet_turns)
        )
        try:
            text = ""
            if service.model_library is not None:
                chat = service._build_chat(service.model_library.service_settings("memory"))
                async for kind, value in chat.stream([{"role": "user", "content": prompt}]):
                    if kind == "text" and isinstance(value, str):
                        text += value
            else:
                import httpx
                from app.agents.llm import provider_endpoint, shared_ssl_context
                # service.settings is the AISettings holder; the real Settings lives on .current.
                cfg = service.settings.current if hasattr(service.settings, "current") else service.settings
                base_url, api_key = provider_endpoint(cfg)
                payload = {
                    "model": cfg.llm_model.strip(),
                    "messages": [{"role": "user", "content": prompt}],
                    "max_tokens": 512,
                    "temperature": 0.3,
                }
                async with httpx.AsyncClient(timeout=12.0, verify=shared_ssl_context()) as client:
                    resp = await client.post(
                        f"{base_url}/chat/completions",
                        json=payload,
                        headers={"Authorization": f"Bearer {api_key}"},
                    )
                if not resp.is_success:
                    return {"suggestion": "", "message_id": last_msg["id"]}
                text = (resp.json().get("choices") or [{}])[0].get("message", {}).get("content") or ""
            cleaned = text.strip().strip("\"'“”‘’`").replace("\n", " ").strip()
            if len(cleaned) > SUGGEST_MAX_CHARS:
                cleaned = cleaned[:SUGGEST_MAX_CHARS].rstrip()
            if len(cleaned) >= SUGGEST_MIN_CHARS:
                _suggest_cache[cache_key] = cleaned
                while len(_suggest_cache) > SUGGEST_CACHE_LIMIT:
                    _suggest_cache.popitem(last=False)
                return {"suggestion": cleaned, "message_id": last_msg["id"]}
        except Exception:
            pass
        return {"suggestion": "", "message_id": last_msg["id"]}

    @router.get("/conversations/{conversation_id}/usage")
    def conversation_usage(conversation_id: str):
        require(conversation_id)
        return store.usage(current_student(), conversation_id=conversation_id)["total"]

    @router.patch("/conversations/{conversation_id}", response_model=Conversation)
    def update_conversation(conversation_id: str, body: UpdateConversation):
        fields = body.model_fields_set
        if "title" in fields and body.title is None:
            raise HTTPException(422, "标题不能为空。")
        if "subject_id" in fields:
            require_subject(body.subject_id)
        try:
            updated = store.update_conversation(
                conversation_id, current_student(),
                title=body.title if "title" in fields else UNSET,
                subject_id=body.subject_id if "subject_id" in fields else UNSET,
            )
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from None
        if not updated:
            raise HTTPException(404, "会话不存在或已删除。")
        return require(conversation_id)

    @router.put("/conversations/{conversation_id}/model")
    def set_conversation_model(conversation_id: str, body: ConversationModelUpdate):
        require(conversation_id)
        if service.is_generating(conversation_id):
            raise HTTPException(409, "正在生成回复，请待本条完成后再切换模型。")
        if body.model_key is not None and service.model_library is not None:
            if service.model_library.effective_key(body.model_key) != body.model_key:
                raise HTTPException(404, "这个模型不存在或未启用。")
        if not store.set_conversation_model(conversation_id, current_student(), body.model_key):
            raise HTTPException(404, "会话不存在或已删除。")
        return {"model_key": store.conversation_model_key(conversation_id)}

    @router.delete("/conversations/{conversation_id}", status_code=204)
    async def delete_conversation(conversation_id: str):
        if store.role_context(conversation_id)["role"] != "main":
            service.stop(conversation_id)
        try:
            deleted = store.delete_conversation(conversation_id, current_student())
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from None
        if not deleted:
            raise HTTPException(404, "会话不存在或已删除。")
        return Response(status_code=204)

    @router.get("/conversations/{conversation_id}/context-summary")
    async def get_context_summary(conversation_id: str):
        require(conversation_id)
        summary, up_to_seq = store.get_context_summary(conversation_id)
        return {"conversation_id": conversation_id, "summary": summary, "up_to_seq": up_to_seq}

    @router.post("/conversations/{conversation_id}/compress")
    async def compress_conversation(conversation_id: str):
        require(conversation_id)
        require_idle(conversation_id)
        return await service.compress_conversation(current_student(), conversation_id)

    @router.post("/conversations/{conversation_id}/messages")
    async def send_message(conversation_id: str, body: SendMessage):
        require(conversation_id)
        existing = store.find_request(conversation_id, body.client_request_id)
        if existing and service.is_generating(conversation_id):
            raise HTTPException(409, "这条消息正在生成回复，请稍候；刷新会话可查看最新状态。")
        # 学习者优先：后台唤醒回合可以直接被这条消息打断，而不是回 409
        await service.preempt_system_turn(conversation_id)
        require_idle(conversation_id)
        if existing:
            # Same request id again (timeout, double click, reconnect): never store the message twice.
            replies = store.replies(existing)
            complete = [row for row in replies if row["status"] == "complete"]
            if complete:
                return stream(service.replay(current_student(), conversation_id, existing, complete[-1]["id"]))
            generation = service.begin(current_student(), conversation_id, existing, [row["id"] for row in replies])
        else:
            user_id = store.add_user_message(conversation_id, body.content, body.client_request_id)
            generation = service.begin(current_student(), conversation_id, user_id, [])
        return stream(service.events(generation))

    @router.post("/conversations/{conversation_id}/messages/{message_id}/resume", response_model=Conversation)
    async def resume_thread(conversation_id: str, message_id: str):
        require(conversation_id)
        try:
            service.resume(current_student(), conversation_id, message_id)
        except LookupError as exc:
            raise HTTPException(404, str(exc)) from None
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from None
        return require(conversation_id)

    @router.post("/conversations/{conversation_id}/regenerate")
    async def regenerate(conversation_id: str):
        require(conversation_id)
        require_idle(conversation_id)
        user_id, blocked = store.last_user_message(conversation_id)
        if user_id is None:
            raise HTTPException(409, "还没有可以重新生成回复的消息。")
        if blocked:
            raise HTTPException(409, "最后一条消息之后已有新内容，无法重新生成。")
        replies = [row["id"] for row in store.replies(user_id)]
        return stream(service.events(service.begin(current_student(), conversation_id, user_id, replies)))

    @router.post("/chat/tool-approvals/{approval_id}")
    async def approve_tool(approval_id: str, body: ToolApprovalBody):
        if not service.resolve_approval(approval_id, body.allow):
            raise HTTPException(404, "这次审批已经结束。")
        return {"ok": True}

    @router.post("/conversations/{conversation_id}/confirm-proposal")
    async def confirm_thread_proposal(conversation_id: str, body: ConfirmProposal):
        require(conversation_id)
        try:
            thread_id = service.confirm_proposal(current_student(), conversation_id, body.message_id, body.proposal_id)
        except LookupError as exc:
            raise HTTPException(404, str(exc)) from None
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from None
        thread = require(thread_id)
        return {"thread_id": thread_id, "status": thread.execution_status}

    @router.get("/agent-memory")
    def agent_memory():
        return store.agent_notes_view(current_student())

    @router.get("/onboarding")
    def get_onboarding():
        return store.onboarding_status(current_student())

    @router.post("/onboarding/start", response_model=Conversation)
    def start_onboarding():
        conv = store.start_onboarding(current_student())
        conv.generating = service.is_generating(conv.id)
        return conv

    @router.post("/onboarding/complete")
    def complete_onboarding(body: ConfirmProfile):
        try:
            state = store.onboarding_status(current_student())
            if state["conversation_id"] and service.is_generating(state["conversation_id"]):
                raise ValueError("请等待本轮访谈完成后再确认。")
            return store.complete_onboarding(current_student(), body.version, body.entries)
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from None

    @router.post("/onboarding/skip")
    def skip_onboarding():
        state = store.onboarding_status(current_student())
        if state["conversation_id"]:
            service.stop(state["conversation_id"])
        return store.skip_onboarding(current_student())

    @router.post("/onboarding/ack")
    def ack_onboarding():
        return store.mark_onboarding(current_student(), "completed")

    @router.post("/onboarding/welcome")
    async def welcome_onboarding(body: WelcomeBody):
        try:
            return await service.start_from_topic(current_student(), body.text)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from None

    @router.get("/onboarding/checklist")
    def onboarding_checklist():
        return store.learning_checklist(current_student())

    @router.get("/onboarding/preferences")
    def get_learning_preferences():
        return store.learning_preferences(current_student())

    @router.post("/preferences/{prompt_id}")
    def decide_preference(prompt_id: str, body: PreferenceDecision):
        try:
            result = store.decide_preference(current_student(), prompt_id, body.allow)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from None
        if result is None:
            raise HTTPException(404, "这条偏好已经处理过。")
        return {"status": result, **store.agent_notes_view(current_student())}

    @router.put("/onboarding/preferences")
    def put_learning_preferences(body: LearningPreferencesBody):
        try:
            return store.save_learning_preferences(current_student(), body.model_dump())
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from None

    @router.post("/onboarding/restart", response_model=Conversation)
    def restart_onboarding():
        state = store.onboarding_status(current_student())
        if state["conversation_id"]:
            service.stop(state["conversation_id"])
        conv = store.restart_onboarding(current_student())
        conv.generating = service.is_generating(conv.id)
        return conv

    @router.get("/usage")
    def account_usage():
        student_id = current_student()
        spaces = [
            {"id": subject.id, "name": subject.name, **store.usage(student_id, subject_id=subject.id)["total"]}
            for subject in store.subjects(student_id)
        ]
        return {"total": store.usage(student_id)["total"], "spaces": spaces}

    @router.get("/skills")
    def list_skills():
        return {"custom_skills": store.list_custom_skills(current_student())}

    @router.post("/skills", status_code=201)
    def create_skill(body: CreateCustomSkillBody):
        try:
            return store.create_custom_skill(
                current_student(),
                name=body.name,
                role=body.role,
                trigger_keywords=body.trigger_keywords,
                content=body.content,
            )
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from None

    @router.patch("/skills/{skill_id}")
    def patch_skill(skill_id: str, body: PatchCustomSkillBody):
        updated = store.update_custom_skill(
            current_student(),
            skill_id,
            enabled=body.enabled,
            name=body.name,
            role=body.role,
            trigger_keywords=body.trigger_keywords,
            content=body.content,
        )
        if updated is None:
            raise HTTPException(404, "自定义 Skill 不存在或已删除。")
        return updated

    @router.delete("/skills/{skill_id}", status_code=204)
    def delete_skill(skill_id: str):
        if not store.delete_custom_skill(current_student(), skill_id):
            raise HTTPException(404, "自定义 Skill 不存在或已删除。")
        return Response(status_code=204)

    @router.get("/workspace/tree")
    def workspace_tree():
        from app.agent_tools import workspace_of
        ws = workspace_of(service.settings)
        if ws is None:
            return {"workspace": "", "name": "", "entries": []}
        skip = {".git", "node_modules", "__pycache__", ".next", ".venv", "dist", "build"}
        entries = []
        try:
            items = sorted(ws.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
            for item in items[:50]:
                if item.name.startswith(".") and item.name in skip:
                    continue
                if item.name in skip:
                    continue
                if item.is_dir():
                    children = []
                    try:
                        sub_items = sorted(item.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
                        for sub in sub_items[:25]:
                            if sub.name in skip:
                                continue
                            children.append({
                                "name": sub.name,
                                "path": f"{item.name}/{sub.name}",
                                "kind": "dir" if sub.is_dir() else "file",
                            })
                    except OSError:
                        pass
                    entries.append({
                        "name": item.name,
                        "path": item.name,
                        "kind": "dir",
                        "children": children,
                    })
                else:
                    entries.append({
                        "name": item.name,
                        "path": item.name,
                        "kind": "file",
                    })
        except OSError:
            pass
        return {"workspace": str(ws), "name": ws.name or str(ws), "entries": entries}

    @router.put("/agent-memory")
    def save_agent_memory(body: AgentNoteBody):
        try:
            return store.save_agent_note(current_student(), body.target, body.content)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from None

    @router.get("/agent-memory/pending")
    def pending_memory():
        return store.pending_notes(current_student())

    @router.post("/agent-memory/pending/{pending_id}")
    def decide_memory(pending_id: str, body: PendingDecision):
        result = store.decide_pending(current_student(), pending_id, body.allow)
        if result is None:
            raise HTTPException(404, "这条待确认已经处理过。")
        return {"result": result, **store.agent_notes_view(current_student())}

    @router.post("/conversations/{conversation_id}/stop")
    async def stop(conversation_id: str):
        require(conversation_id)
        return {"stopped": service.stop(conversation_id)}

    @router.post("/conversations/{conversation_id}/resolve/draft", response_model=Resolution)
    async def draft_resolution(conversation_id: str):
        try:
            return await service.draft_resolution(current_student(), conversation_id)
        except LookupError as exc:
            raise HTTPException(404, str(exc)) from None
        except ProviderError as exc:
            raise HTTPException(exc.status_code, exc.detail) from None
        except ValueError as exc:
            detail = str(exc)
            raise HTTPException(409 if detail.startswith("只有") else 502, detail) from None

    @router.post("/conversations/{conversation_id}/resolve", response_model=Resolution)
    def resolve_thread(conversation_id: str, body: ResolveThread):
        try:
            return store.resolve_thread(conversation_id, current_student(), body.title, body.summary, body.takeaways)
        except LookupError as exc:
            raise HTTPException(404, str(exc)) from None
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from None

    @router.post("/conversations/{conversation_id}/reopen", response_model=Conversation)
    def reopen_thread(conversation_id: str):
        try:
            found = store.reopen_thread(conversation_id, current_student())
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from None
        if not found:
            raise HTTPException(404, "会话不存在或已删除。")
        return require(conversation_id)

    @router.post("/conversations/{conversation_id}/exercises", response_model=Conversation, status_code=201)
    def start_exercise(conversation_id: str, body: StartExercise):
        require(conversation_id)
        require_idle(conversation_id)
        problem = PROBLEMS.get(body.problem_id)
        if problem is None:
            raise HTTPException(404, "练习题不存在。")
        store.add_exercise(conversation_id, problem)
        return require(conversation_id)

    @router.get("/learner-memories", response_model=list[LearnerMemory])
    def list_memories(subject_id: str | None = None):
        memories = store.memories(current_student())
        return memories if subject_id is None else [m for m in memories if m.subject_id == subject_id]

    @router.patch("/learner-memories/{memory_id}", response_model=LearnerMemory)
    def correct_memory(memory_id: str, body: UpdateMemory):
        if not body.model_fields_set:
            raise HTTPException(422, "请提供要修改的内容。")
        try:
            memory = store.update_memory(
                memory_id, current_student(), body.summary, body.status,
                body.subject_id if "subject_id" in body.model_fields_set else UNSET,
            )
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from None
        except LookupError as exc:
            raise HTTPException(404, str(exc)) from None
        if memory is None:
            raise HTTPException(404, "记忆不存在或已删除。")
        return memory

    @router.delete("/learner-memories/{memory_id}", status_code=204)
    def delete_memory(memory_id: str):
        if not store.delete_memory(memory_id, current_student()):
            raise HTTPException(404, "记忆不存在或已删除。")
        return Response(status_code=204)

    return router

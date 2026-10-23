"""One in-flight generation per conversation, streamed to the client as Server-Sent Events.

Message lifecycle:
- The user message is stored before the model is called, so a failure never loses the input.
- The assistant reply starts as `streaming` and ends as exactly one of:
  `complete`  - the model finished; full text stored.
  `cancelled` - stopped by the user or the client disconnected; the partial text shown so far is stored.
  `failed`    - the provider failed; partial text (if any) and the error are stored, excluded from model history.
- Retrying (same client_request_id) or regenerating replaces the previous reply to that user message.
- Learning analysis runs after the reply completes. It cannot alter the reply, and it runs at most once per user message.
"""

import asyncio
import json
import re
import logging
import time
from collections.abc import AsyncIterator, Callable

from app.agent_tools import (
    DEFINITIONS, NEEDS_APPROVAL, parse_arguments, preflight_blacklist, run as run_tool, workspace_of,
)
from app.agent_tools.guard import ToolError
from app.agents.llm import ChatModel, ProviderError
from app.chat.agent import (
    HISTORY_CHARS, HISTORY_MESSAGES, active_exercise, analysis_messages, chat_messages,
    compress_history_messages, deterministic_compress_fallback, dialogue, resolution_messages,
    review_messages, validate_analysis, validate_resolution,
)
from app.chat.store import ChatStore, INTERRUPTED
from app.chat.attachments import attachment_query, prepare_attachment_history
from app.chat.plan import PlanStore, brief
from app.chat.checkpoints import MAX_TOOL_ROUNDS, resume_state
from app.chat.usage import normalize_usage
from app.chat.schemas import DispatchThread, ProposeThreads, ReportProgress
from app.chat.skills.problem_drill_skill import SEARCH_TOOL, drill_plan, guard_reply, lesson_first, wants_problems
from app.chat.coordination import cancel_deliveries, dispatch, next_delivery, report
from app.memory.store import new_id
from app.services.materials import MaterialStore
from app.vision.pipeline import analyze_image_for_relay
from app.vision.schemas import VisionAnalyzeRequest
from app.vision.settings import ServiceModels

IMAGE_MARKER = re.compile(r"\[\[kg-image:(img_[A-Za-z0-9_-]{16,40})\]\]")
MAX_TURN_IMAGES = 3
IMAGE_FAILED = ("【图片读取失败】学生发了一张图片，但识图没有成功：{reason}。请如实告诉学生图片没能读取，并说明可以怎么做："
                "用文字把题目描述一遍，或在「设置 → 模型接入」里开启支持图片的视觉模型。不要假装看到了图片内容。")

logger = logging.getLogger(__name__)
_PROFILE_LABEL_RE = re.compile(r"^\s*\[(?:Identity|Preference|Context|Activity|Experience)\]\s*")
ANALYSIS_TIMEOUT = 60
THREAD_CONCURRENCY = 2


MAX_REASONING_CHARS = 20_000
EMPTY_REPLY_RETRIES = 2


def flatten_tool_history(messages: list[dict]) -> list[dict]:
    """工具调用与结果改写成普通对话文字，不修改传入的列表。"""
    flat: list[dict] = []
    for message in messages:
        if message.get("role") == "tool":
            flat.append({"role": "user", "content": f"（工具返回）{str(message.get('content') or '')[:1500]}"})
        elif message.get("tool_calls"):
            names = "、".join(str((call.get("function") or {}).get("name") or "") for call in message["tool_calls"])
            flat.append({"role": message["role"], "content": f"{message.get('content') or ''}（已调用工具：{names}）".strip()})
        else:
            flat.append(message)
    return flat


def _reasoning_meta(thoughts: list[str]) -> dict:
    """The model's visible thinking is stored for display only; it is never sent back to the model."""
    text = "".join(thoughts).strip()
    return {"reasoning": text[:MAX_REASONING_CHARS]} if text else {}


def sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def close_tool_batch(messages: list[dict]) -> None:
    """Keep a cancelled batch valid without claiming unfinished operations succeeded."""
    last_call = next((i for i in range(len(messages) - 1, -1, -1) if messages[i].get("tool_calls")), None)
    if last_call is None:
        return
    finished = {m["tool_call_id"] for m in messages[last_call + 1:] if m["role"] == "tool"}
    for call in messages[last_call]["tool_calls"]:
        if call["id"] not in finished:
            messages.append({"role": "tool", "tool_call_id": call["id"],
                             "content": "本轮操作已中断，未取得此工具的结果；不能据此判断操作是否完成。"})


class Generation:
    def __init__(self, conversation_id: str, user_message_id: str, assistant_message_id: str):
        self.conversation_id = conversation_id
        self.user_message_id = user_message_id
        self.assistant_message_id = assistant_message_id
        self.queue: asyncio.Queue[tuple[str, dict] | None] = asyncio.Queue()
        self.streaming = True
        self.task: asyncio.Task | None = None
        self.detached = False
        self.student_id = ""
        self.parent_id: str | None = None
        self.checkpoint: dict | None = None


class ToolContext:
    def __init__(self, workspace, store: ChatStore, student_id: str, conversation_id: str, approve_memory: bool = False):
        self.workspace = workspace
        self.store = store
        self.student_id = student_id
        self.conversation_id = conversation_id
        self.approve_memory = approve_memory
        self.dispatch_thread = None
        self.propose_threads = None
        self.report_progress = None
        self.exercise = None


class ChatService:
    def __init__(self, store: ChatStore, model: Callable[[], ChatModel], library: MaterialStore | None = None, settings=None):
        self.store = store
        self.model = model
        self.library = library
        self.settings = settings
        # (VisionStore, ServiceModels)，由 main.py 在视觉服务创建后挂上；没有时图片按「读取失败」处理
        self.vision = None
        # FileStore，由 main.py 挂上；没有时不提供文件生成工具
        self.files = None
        self.active: dict[str, Generation] = {}
        self.approvals: dict[str, asyncio.Future] = {}
        self.reviews: set[asyncio.Task] = set()
        self.tasks: set[asyncio.Task] = set()
        self.compressing: set[str] = set()
        self.closing = False

    async def close(self) -> None:
        self.closing = True
        tasks = [*self.tasks, *self.reviews]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    def recover(self) -> None:
        with self.store.connection() as db:
            interrupted = db.execute(
                "SELECT m.id, m.reply_to, m.conversation_id, c.student_id FROM conversation_messages m "
                "JOIN conversations c ON c.id = m.conversation_id WHERE c.kind = 'thread' AND m.status = 'failed' "
                "AND m.error = ?", ("服务重启，生成被中断。可以重新生成这条回复。",),
            ).fetchall()
            queued = db.execute(
                "SELECT DISTINCT c.id, c.student_id FROM conversations c JOIN thread_dispatches d ON d.thread_id = c.id "
                "WHERE c.kind = 'thread'",
            ).fetchall()
        for row in interrupted:
            self.store.merge_meta(row["id"], {"pending_approval": None})
            checkpoint = self.store.message_meta(row["id"]).get("last_checkpoint")
            available, blocked = resume_state(checkpoint, "failed")
            detail = blocked or ("已保存断点，可在支线中点击「从断点继续」。" if available else "请检查已有进展后重试。")
            report(self.store, row["student_id"], row["conversation_id"], row["reply_to"], "failed",
                   f"服务重启中断了任务。{detail}")
        for row in queued:
            self._start_delivery(row["student_id"], row["id"])

    def is_generating(self, conversation_id: str) -> bool:
        return conversation_id in self.active

    def resolve_approval(self, approval_id: str, allow: bool) -> bool:
        future = self.approvals.get(approval_id)
        if future is None or future.done():
            return False
        future.set_result(allow)
        return True

    def _agent_flag(self, key: str) -> bool:
        if self.settings is None:
            return False
        return bool(self.settings.agent_config().get(key))

    def _background_model(self, model):
        """Analysis, review and compression use the separate memory model when one is configured."""
        if self.settings is None or not hasattr(model, "settings"):
            return model
        try:
            memory = ServiceModels(self.settings).config().memory_model
        except Exception:
            return model
        if not (memory.enabled and memory.model) or memory.model == model.settings.llm_model:
            return model
        return type(model)(model.settings.model_copy(update={"llm_model": memory.model}),
                           getattr(model, "transport", None))

    def _auto_approve(self) -> bool:
        return self._agent_flag("auto_approve")

    def _usage(self, request_id, model, conversation_id, message_id, purpose, raw=None) -> None:
        usage = normalize_usage(raw)
        if raw is not None and usage is None:
            return  # A malformed later chunk must not erase a valid earlier usage record.
        self.store.record_usage(request_id, conversation_id, message_id, purpose,
                                getattr(getattr(model, "settings", None), "llm_model", "unknown"), usage)

    async def _complete_json(self, model, messages, conversation_id, message_id, purpose):
        request_id = new_id("usage")
        self._usage(request_id, model, conversation_id, message_id, purpose)
        try:
            if hasattr(model, "complete_json_with_usage"):
                result, raw = await model.complete_json_with_usage(messages)
                self._usage(request_id, model, conversation_id, message_id, purpose, raw)
                return result
            return await model.complete_json(messages)
        except ProviderError as exc:
            if exc.usage is not None:
                self._usage(request_id, model, conversation_id, message_id, purpose, exc.usage)
            raise

    async def _await_approval(self, generation: Generation, name: str, arguments: str) -> bool:
        # A working directory is not a shell sandbox. Commands always require consent.
        if name != "bash" and self._auto_approve():
            return True
        approval_id = new_id("approval")
        future: asyncio.Future = asyncio.get_running_loop().create_future()
        self.approvals[approval_id] = future
        approval = {"id": approval_id, "name": name, "arguments": arguments}
        self.store.merge_meta(generation.assistant_message_id, {"pending_approval": approval})
        self._report(generation, "waiting", "需要你在支线中确认操作后继续。")
        generation.queue.put_nowait(("tool_approval", {"id": approval_id, "name": name, "arguments": arguments}))
        try:
            return bool(await asyncio.wait_for(future, 600))
        except TimeoutError:
            return False
        finally:
            self.approvals.pop(approval_id, None)
            self.store.merge_meta(generation.assistant_message_id, {"pending_approval": None})
            self._report(generation, "working", "已结束本次确认，正在继续处理。")

    def _report(self, generation: Generation, status: str, summary: str) -> None:
        report(self.store, generation.student_id, generation.conversation_id, generation.user_message_id, status, summary)

    def _start_delivery(self, student_id: str, thread_id: str) -> None:
        if self.closing or self.is_generating(thread_id):
            return
        # Enforce per-space concurrency limit: max 2 threads running at once
        thread = self.store.conversation(thread_id, student_id)
        if thread and thread.parent_id:
            running = self._count_running_threads(student_id, thread.parent_id)
            if running >= THREAD_CONCURRENCY:
                return  # Stay queued until a slot opens
        user_id = next_delivery(self.store, thread_id)
        if user_id:
            self.begin(student_id, thread_id, user_id, [], detached=True)

    def _thread_parent_id(self, student_id: str, conversation_id: str) -> str | None:
        # Bind the scheduler to its space before deletion can remove the worker's row.
        with self.store.connection() as db:
            row = db.execute(
                "SELECT parent_id FROM conversations WHERE id = ? AND student_id = ? AND kind = 'thread'",
                (conversation_id, student_id),
            ).fetchone()
        return row["parent_id"] if row else None

    def _count_running_threads(self, student_id: str, main_id: str) -> int:
        # The single-process runtime is authoritative. A persisted streaming row is the same
        # generation, not another slot (and may be stale after a crash).
        with self.store.connection() as db:
            ids = {row["id"] for row in db.execute(
                "SELECT id FROM conversations WHERE student_id = ? AND parent_id = ? AND kind = 'thread'",
                (student_id, main_id),
            )}
        return sum(cid in ids and gen.streaming for cid, gen in self.active.items())

    def has_thread_slot(self, student_id: str, conversation_id: str) -> bool:
        with self.store.connection() as db:
            row = db.execute("SELECT kind, parent_id FROM conversations WHERE id = ? AND student_id = ?",
                             (conversation_id, student_id)).fetchone()
        return not row or row["kind"] != "thread" or not row["parent_id"] or (
            self._count_running_threads(student_id, row["parent_id"]) < THREAD_CONCURRENCY)

    def _start_next_queued_thread(self, student_id: str, main_id: str, exclude: str | None = None) -> None:
        """Fill all free slots, oldest undelivered input first; skip already-running workers."""
        with self.store.connection() as db:
            queued = db.execute("""
                SELECT c.id, MIN(m.created_at) AS oldest FROM conversations c
                JOIN thread_dispatches d ON d.thread_id = c.id
                JOIN conversation_messages m ON m.id = d.message_id
                WHERE c.student_id = ? AND c.parent_id = ? AND c.kind = 'thread'
                  AND NOT EXISTS (SELECT 1 FROM conversation_messages r WHERE r.reply_to = m.id)
                GROUP BY c.id ORDER BY oldest, c.id
            """, (student_id, main_id)).fetchall()
        for row in queued:
            if row["id"] != exclude:
                self._start_delivery(student_id, row["id"])

    def _dispatch_thread(self, student_id: str, generation: Generation, arguments: dict) -> str:
        body = DispatchThread(**arguments)
        thread_id, message_id = dispatch(
            self.store, student_id, generation.conversation_id, generation.user_message_id,
            body.title, body.task, body.thread_id, skill=body.skill,
        )
        if not self.store.replies(message_id):
            report(self.store, student_id, thread_id, message_id, "queued", "已收到主线交办的任务，等待执行。")
        self._start_delivery(student_id, thread_id)
        generation.queue.put_nowait(("thread_dispatched", {"thread_id": thread_id}))
        return json.dumps({"thread_id": thread_id, "delivered": True,
                           "status": "queued" if not self.store.replies(message_id) else
                           self.store.conversation(thread_id, student_id).execution_status}, ensure_ascii=False)

    def _propose_threads(self, student_id: str, generation: Generation, arguments: dict) -> str:
        """Suggest threads to the user without creating them immediately."""
        body = ProposeThreads(**arguments)
        proposals = self.store.message_meta(generation.assistant_message_id).get("thread_proposals", [])
        for item in body.proposals:
            data = item.model_dump()
            if not any(p["title"] == item.title and p["task"] == item.task for p in proposals):
                if len(proposals) >= 8:
                    raise ValueError("每条回复最多建议 8 个支线。")
                proposals.append({"id": new_id("proposal"), **data, "thread_id": None})
        self.store.merge_meta(generation.assistant_message_id, {"thread_proposals": proposals})
        return "已展示建议卡片，尚未创建或执行支线；等待用户选择。"

    def confirm_proposal(self, student_id: str, conversation_id: str, message_id: str, proposal_id: str) -> str:
        # Never trust client-supplied titles/tasks or the *latest* user input. Older cards stay
        # tied to their original source. dispatch's durable task_key also makes crash retries safe.
        message = self.store.message(message_id, student_id)
        if message is None or message.conversation_id != conversation_id:
            raise LookupError("建议不存在或不属于当前对话。")
        if self.store.role_context(conversation_id)["role"] != "main":
            raise ValueError("只有学习空间主线可以确认建议。")
        if message.role != "assistant" or message.status != "complete" or not message.reply_to:
            raise ValueError("请等待建议回复完成后再确认。")
        proposals = self.store.message_meta(message_id).get("thread_proposals", [])
        proposal = next((p for p in proposals if p["id"] == proposal_id), None)
        if proposal is None:
            raise LookupError("建议不存在。")
        if proposal.get("thread_id"):
            if not self.store.conversation(proposal["thread_id"], student_id):
                raise ValueError("这个建议对应的支线已删除，请重新规划。")
            return proposal["thread_id"]
        thread_id, delivery = dispatch(
            self.store, student_id, conversation_id, message.reply_to, proposal["title"], proposal["task"], None,
            task_key=f"proposal:{proposal_id}",
        )
        proposal["thread_id"] = thread_id
        self.store.merge_meta(message_id, {"thread_proposals": proposals})
        if not self.store.replies(delivery):
            report(self.store, student_id, thread_id, delivery, "queued", "你已确认这项建议，等待执行。")
        self._start_delivery(student_id, thread_id)
        return thread_id

    def _progress(self, student_id: str, generation: Generation, ctx: ToolContext, arguments: dict) -> str:
        body = ReportProgress(**arguments)
        self.store.merge_meta(generation.assistant_message_id, {"needs_user": body.needs_user,
                                                               "progress_summary": body.summary})
        report(self.store, student_id, generation.conversation_id, generation.user_message_id,
               "working", body.summary)
        return "已将进展同步到主线。"

    def stop(self, conversation_id: str) -> bool:
        generation = self.active.get(conversation_id)
        with self.store.connection() as db:
            row = db.execute("SELECT student_id FROM conversations WHERE id = ?", (conversation_id,)).fetchone()
        pending = cancel_deliveries(self.store, conversation_id) if row else []
        for message_id in pending:
            report(self.store, row["student_id"], conversation_id, message_id, "cancelled", "这条排队的任务已停止执行。")
        if generation and generation.streaming and generation.task and not generation.task.done():
            generation.task.cancel()
            return True
        return bool(pending)

    def _message(self, student_id: str, message_id: str) -> dict | None:
        message = self.store.message(message_id, student_id)
        return message.model_dump(mode="json") if message else None

    def _conversation(self, student_id: str, conversation_id: str) -> dict | None:
        conversation = self.store.conversation(conversation_id, student_id)
        return conversation.model_dump(mode="json", exclude={"messages"}) if conversation else None

    def begin(self, student_id: str, conversation_id: str, user_message_id: str, discard: list[str], *, detached: bool = False) -> Generation:
        # Called without awaiting in between the caller's is_generating() check, so registration is atomic.
        assistant_id = self.store.start_reply(conversation_id, user_message_id, discard)
        generation = Generation(conversation_id, user_message_id, assistant_id)
        generation.student_id = student_id
        generation.parent_id = self._thread_parent_id(student_id, conversation_id)
        generation.detached = detached
        self.active[conversation_id] = generation
        self._report(generation, "working", "正在处理这项任务，详细过程可在支线中查看。")
        generation.queue.put_nowait(("start", {
            "conversation": self._conversation(student_id, conversation_id),
            "user_message": self._message(student_id, user_message_id),
            "assistant_message": self._message(student_id, assistant_id),
            "discarded_ids": discard,
        }))
        generation.task = asyncio.create_task(self._run(student_id, generation))
        self.tasks.add(generation.task)
        generation.task.add_done_callback(self.tasks.discard)
        return generation

    def resume(self, student_id: str, conversation_id: str, message_id: str) -> Generation:
        message = self.store.message(message_id, student_id)
        if message is None or message.conversation_id != conversation_id:
            raise LookupError("断点不存在或不属于当前对话。")
        if self.store.role_context(conversation_id)["role"] != "thread":
            raise ValueError("目前仅执行支线支持从断点继续。")
        existing = self.active.get(conversation_id)
        if existing:
            if existing.assistant_message_id == message_id:
                return existing  # A lost HTTP response must not launch a second worker.
            raise ValueError("支线正在执行，请稍候。")
        if self.closing or not self.has_thread_slot(student_id, conversation_id):
            raise ValueError("当前没有空闲执行槽位，请稍候。")
        checkpoint = self.store.message_meta(message_id).get("last_checkpoint")
        available, blocked = resume_state(checkpoint, message.status)
        if not available:
            raise ValueError(blocked or "此回复没有可以继续的断点。")
        latest, intervening = self.store.last_user_message(conversation_id)
        if message.reply_to != latest or intervening:
            raise ValueError("这条回复之后已有新内容，请在最新对话中继续。")
        workspace = workspace_of(self.settings)
        if checkpoint.get("workspace") != (str(workspace) if workspace else None):
            raise ValueError("工作区设置已变化，请恢复原设置后再从断点继续。")
        self.store.finish_reply(message_id, content="".join(checkpoint["parts"]), status="streaming",
                                meta={"pending_approval": None})
        generation = Generation(conversation_id, message.reply_to, message_id)
        generation.student_id = student_id
        generation.parent_id = self._thread_parent_id(student_id, conversation_id)
        generation.detached = True
        generation.checkpoint = checkpoint
        self.active[conversation_id] = generation
        self._report(generation, "working", "正在从已保存的工具断点继续。")
        generation.task = asyncio.create_task(self._run(student_id, generation))
        self.tasks.add(generation.task)
        generation.task.add_done_callback(self.tasks.discard)
        return generation

    def _save_checkpoint(self, generation: Generation, state: dict) -> None:
        self.store.merge_meta(generation.assistant_message_id, {"last_checkpoint": state})

    async def _execute_tools(self, generation, state, definitions, ctx) -> None:
        # Commit the intent before external execution, then commit each result before proceeding.
        # If a crash lands between a write and its result commit, resume_state rejects replay.
        queue = generation.queue
        pending = state["pending"]
        for index in range(state["next_call"], len(pending)):
            call = pending[index]
            name, raw_args = call.get("name") or "", call.get("arguments") or "{}"
            state.update(next_call=index, in_flight=False)
            self._save_checkpoint(generation, state)
            supported = any(t["function"]["name"] == name for t in definitions) or (
                name == "plan_steps" and generation.checkpoint is not None)
            allowed, blocked = True, None
            if name in NEEDS_APPROVAL and supported:
                # The blacklist is checked before asking, so the user is never asked to approve `rm -rf /`.
                blocked = preflight_blacklist(name, raw_args)
                if not blocked:
                    allowed = await self._await_approval(generation, name, raw_args)
            output, ok = "用户拒绝了这次操作。", False
            if blocked:
                output = blocked
            elif allowed:
                queue.put_nowait(("tool_start", {"id": call["id"], "name": name, "arguments": raw_args}))
                try:
                    if not supported:
                        raise ToolError("当前对话不支持这个工具。")
                    arguments = parse_arguments(raw_args)
                    state["in_flight"] = True
                    self._save_checkpoint(generation, state)
                    output = await run_tool(name, arguments, ctx)
                    ok = (output.startswith(("已更新", "已存在")) if name == "memory" else True)
                except (ToolError, json.JSONDecodeError, ValueError) as exc:
                    output = str(exc) or "工具参数无效。"
            record = {"id": call["id"], "name": name, "arguments": raw_args, "output": output, "ok": ok}
            state["tool_log"].append(record)
            result = {"role": "tool", "tool_call_id": call["id"], "content": output}
            state["messages"].append(result)
            state["tool_messages"].append(result)
            state.update(next_call=index + 1, in_flight=False)
            self._save_checkpoint(generation, state)
            self.store.merge_meta(generation.assistant_message_id, {"tool_calls": state["tool_log"]})
            queue.put_nowait(("tool_end", record))
        state.update(phase="model", pending=[], next_call=0, in_flight=False)
        self._save_checkpoint(generation, state)

    async def events(self, generation: Generation) -> AsyncIterator[str]:
        try:
            while True:
                item = await generation.queue.get()
                if item is None:
                    return
                yield sse(*item)
        finally:
            # Client went away mid-reply: treat it like Stop so the reply is not left "streaming".
            if not generation.detached and generation.streaming and generation.task and not generation.task.done():
                generation.task.cancel()

    async def replay(self, student_id: str, conversation_id: str, user_id: str, assistant_id: str) -> AsyncIterator[str]:
        """A retried request whose reply already completed: return the stored result, do not call the model."""
        yield sse("start", {
            "conversation": self._conversation(student_id, conversation_id),
            "user_message": self._message(student_id, user_id),
            "assistant_message": self._message(student_id, assistant_id), "discarded_ids": [], "replayed": True,
        })
        yield sse("done", {"message": self._message(student_id, assistant_id)})
        yield sse("analysis", {
            "user_message": self._message(student_id, user_id),
            "assistant_message": self._message(student_id, assistant_id),
        })

    async def _read_images(self, student_id: str, history: list[dict], user_message_id: str) -> tuple[list[dict], str]:
        """把 [[kg-image:...]] 换成对话模型能读的文字；返回新的历史和要放在回复开头的识图卡片。

        只识别本轮学生消息里的图片（最多 3 张）；更早的图片只留一句占位，不重复调视觉模型。
        """
        cards: list[str] = []
        result: list[dict] = []
        for original in history:
            if original["role"] != "user" or not IMAGE_MARKER.search(original["content"]):
                result.append(original)
                continue
            row = dict(original)
            question = IMAGE_MARKER.sub("", row["content"]).strip()
            if row["id"] != user_message_id:
                row["content"] = f"（学生发了一张图片）\n{question}".strip()
                result.append(row)
                continue
            blocks: list[str] = []
            for image_id in list(dict.fromkeys(IMAGE_MARKER.findall(row["content"])))[:MAX_TURN_IMAGES]:
                try:
                    if self.vision is None:
                        raise RuntimeError("视觉服务没有启动")
                    vision_store, service_models = self.vision
                    analysis = await analyze_image_for_relay(
                        VisionAnalyzeRequest(image_id=image_id, prompt=question[:2000], mode="auto"),
                        service_models, store=vision_store, student_id=student_id,
                    )
                except asyncio.CancelledError:
                    raise
                except Exception as exc:  # 识图失败也要让学生知道原因，而不是让模型凭空作答
                    reason = str(getattr(exc, "detail", "") or exc or type(exc).__name__)
                    logger.warning("vision analysis failed for %s: %s", image_id, reason)
                    blocks.append(IMAGE_FAILED.format(reason=reason[:200]))
                    if question:
                        blocks.append(f"【学生的提问】\n{question}")
                    continue
                blocks.append(analysis["relay_prompt"])
                if analysis.get("widget_markdown"):
                    cards.append(analysis["widget_markdown"])
            row["content"] = "\n\n".join(blocks)
            result.append(row)
        return result, "\n\n".join(cards)

    def _release(self, generation: Generation) -> None:
        generation.streaming = False
        if self.active.get(generation.conversation_id) is generation:
            del self.active[generation.conversation_id]

    async def _run(self, student_id: str, generation: Generation) -> None:
        queue = generation.queue
        assistant_id = generation.assistant_message_id
        parts: list[str] = []
        thoughts: list[str] = []
        tool_log: list[dict] = []
        tool_messages: list[dict] = []
        last_flush = 0.0
        try:
            await asyncio.sleep(0)  # let the queued "start" event reach the client before any blocking work
            history = [row for row in self.store.history(generation.conversation_id) if row["id"] != assistant_id]
            user_row = next(row for row in history if row["id"] == generation.user_message_id)
            # Queued inputs can be inserted before an earlier turn's reply. Keep those
            # replies with their own user turn, while excluding later queued inputs.
            user_seqs = {row["id"]: row["seq"] for row in history if row["role"] == "user"}
            history = [row for row in history if user_seqs.get(row["reply_to"], row["seq"]) <= user_row["seq"]]
            history.sort(key=lambda row: (user_seqs.get(row["reply_to"], row["seq"]), row["seq"]))
            history, attached_files = prepare_attachment_history(history, self.library, student_id)
            image_card = ""
            if not generation.checkpoint:
                # 续跑时上下文已在检查点里，不再重复调视觉模型
                history, image_card = await self._read_images(student_id, history, generation.user_message_id)
            user_text = next(row['content'] for row in history if row['id'] == generation.user_message_id)
            interview = self.store.onboarding_status(student_id)
            if interview["conversation_id"] == generation.conversation_id:
                from app.chat.onboarding import EXTRACTION_PROMPT, QUESTIONS, apply_answer
                if interview["status"] != "in_progress":
                    raise ProviderError(409, "这段访谈已结束或暂停，请从学习记忆继续完善画像。")
                model = self.model()
                result = await self._complete_json(model, [
                    {"role": "system", "content": EXTRACTION_PROMPT},
                    {"role": "user", "content": json.dumps({"stage": interview["stage"],
                        "draft": interview["draft"], "answer": user_text}, ensure_ascii=False)},
                ], generation.conversation_id, assistant_id, "onboarding")
                if not isinstance(result.get("answers"), list):
                    raise ProviderError(502, "访谈响应格式无效，请重试；回答尚未计入进度。")
                with self.store.connection() as db:
                    db.execute("BEGIN IMMEDIATE")
                    updated = apply_answer(db, student_id, generation.user_message_id, user_text, result, interview["version"])
                    text = (str(result.get("reply") or "")[:500] + "\n\n" + (
                        "谢谢，下面是我整理的候选画像。请核对或修改后确认；确认前不会写入长期画像。"
                        if updated["ready"] else QUESTIONS[updated["stage"]])).strip()
                    # State advancement and its visible reply commit together.
                    db.execute("UPDATE conversation_messages SET content=?, status='complete', error=NULL WHERE id=?", (text, assistant_id))
                queue.put_nowait(("done", {"message": self._message(student_id, assistant_id)}))
                queue.put_nowait(("analysis", {"skipped": True}))
                return
            exercise = active_exercise(history)
            subject = self.store.conversation_subject(generation.conversation_id)
            subject_id = subject.id if subject else None
            memories = self.store.relevant_memories(
                student_id, user_text, None, subject_id,
            )
            if self.library and attached_files:
                sources = self.library.search(student_id, attachment_query(user_text)[:600], 8,
                                              document_ids=[item['id'] for item in attached_files])
            else:
                sources = self.library.search_scoped(student_id, user_text[:600], 5, subject_id) if self.library else []
            model = self.model()
            finish = "stop"
            role = self.store.role_context(generation.conversation_id)
            user_meta = self.store.message_meta(generation.user_message_id)
            role["delegated_task"] = user_meta.get("delegated_task")
            role["delegated_skill"] = user_meta.get("delegated_skill")
            conv_info = self._conversation(student_id, generation.conversation_id) or {}
            conv_title = conv_info.get("title") or ""
            snapshot = self.store.frozen_notes(generation.conversation_id, student_id)
            thinking_depth = (self.settings.agent_config().get("reasoning_effort", "medium")
                              if self.settings is not None else "medium")
            custom_skills = self.store.list_custom_skills(student_id)
            compressed_summary, compressed_seq = self.store.get_context_summary(generation.conversation_id)
            plans = PlanStore(self.store)
            plan_at_start = plans.read(generation.conversation_id, student_id)
            learning_plan, plan_user_events = (plans.context(generation.conversation_id, student_id)
                                                if not generation.checkpoint else (None, []))
            messages = chat_messages(
                history, memories, exercise, sources, subject, role, snapshot, thinking_depth, conv_title,
                custom_skills=custom_skills, compressed_summary=compressed_summary,
                compressed_up_to_seq=compressed_seq,
                learning_plan=learning_plan, plan_user_events=plan_user_events,
                attached_files=attached_files,
            )
            ctx = ToolContext(
                workspace_of(self.settings), self.store, student_id, generation.conversation_id,
                self._agent_flag("memory_write_approval"),
            )
            ctx.exercise = exercise
            ctx.assistant_message_id = assistant_id
            ctx.user_message_id = generation.user_message_id
            ctx.plan_version = plans.read(generation.conversation_id, student_id)["version"]
            ctx.on_plan = lambda plan: queue.put_nowait(("plan", plan))
            # search_good_problems 用当前对话的模型抽题、用讲义库做本地检索
            ctx.model = model
            ctx.library = self.library
            ctx.files = self.files
            ctx.generated = []

            def on_file(file: dict) -> None:
                self.store.merge_meta(assistant_id, {"files": list(ctx.generated)})
                if not generation.detached:
                    queue.put_nowait(("file", file))
            ctx.on_file = on_file
            if role["role"] == "main":
                ctx.dispatch_thread = lambda arguments: self._dispatch_thread(student_id, generation, arguments)
                ctx.propose_threads = lambda arguments: self._propose_threads(student_id, generation, arguments)
            if role["role"] == "thread":
                ctx.report_progress = lambda arguments: self._progress(student_id, generation, ctx, arguments)
            definitions = [tool for tool in DEFINITIONS if (
                tool["function"]["name"] in {"dispatch_thread", "propose_threads", "session_search", "memory", "update_plan",
                                             "agenda_list", "agenda_add", "agenda_update",
                                             "create_document", "edit_document", "read_document"}
                if role["role"] == "main" else tool["function"]["name"] not in {"dispatch_thread", "propose_threads"}
                and (role["role"] == "thread" or tool["function"]["name"] != "report_progress")
            )]
            if exercise is None:
                definitions = [tool for tool in definitions if tool["function"]["name"] != "exercise_reference"]
            if self.files is None:
                definitions = [tool for tool in definitions if tool["function"]["name"] not in
                               {"create_document", "edit_document", "read_document"}]
            if ctx.workspace is None:
                # 读写文件与终端命令属于开发者模式：没有绑定工作区时不提供给模型
                definitions = [tool for tool in definitions if tool["function"]["name"] not in {"read", "write", "edit", "bash"}]
            if role["role"] == "chat" and lesson_first(user_text):
                # 「先讲概念再出题」由教学流程现场出题；顺手检索真题会触发严格溯源，把随堂小题隐藏掉
                definitions = [tool for tool in definitions if tool["function"]["name"] != SEARCH_TOOL]
            state = generation.checkpoint or {
                "version": 1, "role": role["role"], "phase": "model", "rounds": 0, "messages": messages,
                "parts": parts, "tool_log": tool_log, "tool_messages": tool_messages,
                "pending": [], "next_call": 0, "in_flight": False,
                "workspace": str(ctx.workspace) if ctx.workspace else None,
            }
            drill_active, forced = drill_plan(
                role["role"], user_text, role.get("delegated_task"), role.get("delegated_skill"),
                [row["content"] for row in history if row["role"] == "assistant"], memories,
            )
            if generation.checkpoint:
                messages, parts = state["messages"], state["parts"]
                tool_log, tool_messages = state["tool_log"], state["tool_messages"]
                if state["phase"] == "tools":
                    await self._execute_tools(generation, state, definitions, ctx)
            else:
                # 出题轮：知识点明确时，服务端先替模型调用一次搜题，模型直接拿结果出题。
                # 小模型经常只说「我去搜一下」就结束，不真正调用工具。
                if forced and any(t["function"]["name"] == SEARCH_TOOL for t in definitions):
                    call = {"id": new_id("tool"), "name": SEARCH_TOOL,
                            "arguments": json.dumps(forced, ensure_ascii=False)}
                    batch = [{"role": "assistant", "content": "", "tool_calls": [{
                        "id": call["id"], "type": "function",
                        "function": {"name": call["name"], "arguments": call["arguments"]},
                    }]}]
                    messages.extend(batch)
                    tool_messages.extend(batch)
                    state.update(phase="tools", pending=[call], next_call=0, in_flight=False)
                    self._save_checkpoint(generation, state)
                    await self._execute_tools(generation, state, definitions, ctx)
            if image_card:
                # 识图卡片（原图圈画 / 电路网表）由服务端放在回复开头，模型只看文字结果
                parts.append(image_card + "\n\n")
                if not generation.detached:
                    queue.put_nowait(("delta", {"text": image_card + "\n\n"}))
            empty_retries = 0
            for round_index in range(state["rounds"], MAX_TOOL_ROUNDS):
                nudged = empty_retries > 0 and not "".join(parts).strip()
                if nudged:
                    # 同样的请求再发一遍多半还是空的：第二次起带上一句提醒，改变一下请求
                    messages.append({"role": "user", "content": "（系统提示：上一次没有给出任何文字，请直接回答学生。）"})
                state.update(phase="model", rounds=round_index)
                self._save_checkpoint(generation, state)
                request_id = new_id("usage")
                self._usage(request_id, model, generation.conversation_id, assistant_id, "chat")
                calls = None
                round_text: list[str] = []
                # 最后一次重试：把历史里的工具调用压成普通文字再问，绕开个别模型对工具历史的挑剔
                sent = flatten_tool_history(messages) if nudged and empty_retries >= EMPTY_REPLY_RETRIES else messages
                try:
                    stream = model.stream(sent, definitions)
                except TypeError:
                    stream = model.stream(sent)
                async for kind, value in stream:
                    if kind == "text":
                        parts.append(value)
                        round_text.append(value)
                        if not generation.detached:
                            queue.put_nowait(("delta", {"text": value}))
                        elif time.monotonic() - last_flush >= 0.3:
                            self.store.finish_reply(assistant_id, content="".join(parts), status="streaming")
                            last_flush = time.monotonic()
                    elif kind == "reasoning":
                        thoughts.append(value)
                        if not generation.detached:
                            queue.put_nowait(("reasoning", {"text": value}))
                    elif kind == "usage":
                        self._usage(request_id, model, generation.conversation_id, assistant_id, "chat", value)
                    elif kind == "tool_calls":
                        calls = value
                    elif kind == "finish":
                        finish = value
                if nudged:
                    messages.pop()
                if not calls and not "".join(parts).strip() and empty_retries < EMPTY_REPLY_RETRIES:
                    # 个别模型偶尔只吐出思考、既没有正文也没有工具调用：自动再问几次，不让学生白等
                    empty_retries += 1
                    continue
                if not calls:
                    break
                assistant_calls = []
                for call in calls:
                    if not call.get("id"):
                        call["id"] = new_id("tool")
                    assistant_calls.append({
                        "id": call["id"], "type": "function",
                        "function": {"name": call.get("name") or "", "arguments": call.get("arguments") or "{}"},
                        **({"gemini_part": call["gemini_part"]} if isinstance(call.get("gemini_part"), dict) else {}),
                    })
                batch = [{"role": "assistant", "content": "".join(round_text), "tool_calls": assistant_calls}]
                messages.extend(batch)
                tool_messages.extend(batch)
                state.update(phase="tools", pending=calls, next_call=0, in_flight=False, rounds=round_index + 1)
                self._save_checkpoint(generation, state)
                await self._execute_tools(generation, state, definitions, ctx)
                ctx.workspace = workspace_of(self.settings)
            else:
                raise ProviderError(502, "工具调用已达到本轮上限，请缩小任务范围后重试。")
            text = "".join(parts)
            if not text.strip():
                raise ProviderError(502, "模型返回了空回复，请重试。")
            # 逐题核对 micro_quiz：来源不明或被改动的题隐藏，meta.source 按检索记录重写。
            # 流式阶段已显示的原文会在 done 事件里被存储的核对结果替换。
            text, quiz_report = guard_reply(
                text, tool_log, allowed_misconceptions={m.id for m, _ in memories if m.kind == "misconception"},
                drill_active=drill_active and wants_problems(user_text),
                # history 含本轮用户消息；只有这一条时，「你之前提到」之类的说法一定是编的
                first_turn=sum(1 for row in history if row["role"] == "user") <= 1,
            )
            if any(quiz_report.values()):  # 有任何核对、替换或清理动作就记一笔
                # warning 级别：uvicorn 默认不输出应用自己的 info 日志
                logger.warning("problem_drill quiz check: %s", quiz_report)
            cited = [source.model_dump() for source in sources if f"[{source.label}]" in text]
            self.store.finish_reply(assistant_id, content=text, status="complete", meta={
                "context_memory_ids": [m.id for m, _ in memories], "sources": cited, "truncated": finish == "length",
                "tool_calls": tool_log, "tool_messages": tool_messages, **_reasoning_meta(thoughts),
                "last_checkpoint": {"version": 1, "phase": "done"},
            })
            self._release(generation)
            queue.put_nowait(("done", {"message": self._message(student_id, assistant_id)}))
            if generation.parent_id and not self.closing:
                # The slot is free once the reply is stored; queued Threads need not wait for analysis.
                # This Thread's own next input still starts in `finally`, after its status report.
                try:
                    self._start_next_queued_thread(student_id, generation.parent_id,
                                                   exclude=generation.conversation_id)
                except Exception:
                    logger.exception("Could not start the next queued thread")
            if text.strip():
                # A regenerated reply must not count the same user turn twice.
                already_counted = self.store.message_meta(generation.user_message_id).get("note_counted")
                # A mid-conversation memory note does not replace the ten-turn review;
                # only the review below resets the counter.
                count = 0 if already_counted else self.store.bump_note_turns(
                    student_id, False, generation.conversation_id,
                )
                self.store.merge_meta(generation.user_message_id, {"note_counted": True})
                if count >= 10:
                    self.store.bump_note_turns(student_id, True, generation.conversation_id)
                    # Ten counted turns from this conversation, including long messages in full.
                    user_rows = [row for row in history if row["role"] == "user" and
                                 self.store.message_meta(row["id"]).get("note_counted")]
                    start_seq = user_rows[-10]["seq"]
                    turns = dialogue([row for row in history if row["seq"] >= start_seq], bounded=False)
                    turns.append({"role": "assistant", "content": text})
                    task = asyncio.create_task(self._review(student_id, self._background_model(model), turns,
                                                            generation.conversation_id, assistant_id))
                    self.reviews.add(task)
                    task.add_done_callback(self.reviews.discard)
            await asyncio.sleep(0)
            try:
                if role["role"] == "main" and any(item["name"] == "dispatch_thread" and item["ok"] for item in tool_log):
                    queue.put_nowait(("analysis", {"skipped": True}))
                else:
                    await self._analyze(student_id, generation, history, user_text, text, memories, exercise,
                                        self._background_model(model),
                                        subject_id, plan_at_start)
            except Exception:
                # The reply is already complete and stored; note-taking problems must not mark it failed.
                logger.exception("Learning analysis failed")
                queue.put_nowait(("analysis", {"skipped": True}))
        except asyncio.CancelledError:
            if generation.streaming:
                close_tool_batch(tool_messages)
                self.store.finish_reply(assistant_id, content="".join(parts),
                                        status="failed" if self.closing else "cancelled",
                                        error=INTERRUPTED if self.closing else None,
                                        meta={"tool_calls": tool_log, "tool_messages": tool_messages, **_reasoning_meta(thoughts)})
                queue.put_nowait(("cancelled", {"message": self._message(student_id, assistant_id)}))
        except ProviderError as exc:
            close_tool_batch(tool_messages)
            self.store.finish_reply(assistant_id, content="".join(parts), status="failed", error=exc.detail,
                                    meta={"tool_calls": tool_log, "tool_messages": tool_messages, **_reasoning_meta(thoughts)})
            queue.put_nowait(("error", {
                "detail": exc.detail, "status_code": exc.status_code,
                "message": self._message(student_id, assistant_id),
            }))
        except Exception:
            logger.exception("Chat generation failed")
            detail = "生成回复时发生内部错误，请重试。"
            try:
                close_tool_batch(tool_messages)
                self.store.finish_reply(assistant_id, content="".join(parts), status="failed", error=detail,
                                        meta={"tool_calls": tool_log, "tool_messages": tool_messages, **_reasoning_meta(thoughts)})
            except Exception:
                logger.exception("Could not record the failed reply")
            queue.put_nowait(("error", {"detail": detail, "status_code": 500, "message": None}))
        finally:
            self._release(generation)
            try:
                result = self.store.message(assistant_id, student_id)
                if result:
                    meta = self.store.message_meta(assistant_id)
                    status = result.status if result.status in {"failed", "cancelled"} else (
                        "waiting" if meta.get("needs_user") else "idle")
                    summary = result.error if result.status == "failed" else (
                        "任务已停止，可在支线中继续。" if result.status == "cancelled" else
                        meta.get("progress_summary") or f"本轮回复节选：{result.content[:500]}")
                    self._report(generation, status, summary or "请打开支线查看。")
            except Exception:
                logger.exception("Could not publish thread status")
            try:
                # A deleted worker or failed status report must still release its space's slot.
                if generation.parent_id and not self.closing:
                    self._start_next_queued_thread(student_id, generation.parent_id)
            except Exception:
                logger.exception("Could not start the next queued thread")
            queue.put_nowait(None)

    async def _review(self, student_id: str, model: ChatModel, turns: list[dict],
                      conversation_id: str, message_id: str) -> None:
        try:
            raw = await self._complete_json(model, review_messages(self.store.agent_notes(student_id), turns),
                                            conversation_id, message_id, "review")
        except Exception:
            logger.exception("Background memory review failed")
            return
        ops = raw.get("ops") if isinstance(raw, dict) else None
        approve = self._agent_flag("memory_write_approval")
        for op in ops if isinstance(ops, list) else []:
            if not isinstance(op, dict):
                continue
            self.store.apply_agent_memory(
                student_id, str(op.get("action") or ""), str(op.get("target") or ""),
                op.get("content"), op.get("old_text"), approve,
            )

    async def _analyze(
        self, student_id, generation, history, user_text, reply, memories, exercise, model, subject_id=None,
        plan_at_start=None,
    ) -> None:
        user_id = generation.user_message_id
        if self.store.message_meta(user_id).get("analyzed"):
            # Regenerated reply: the learning evidence in this user message was already recorded once.
            generation.queue.put_nowait(("analysis", {
                "user_message": self._message(student_id, user_id),
                "assistant_message": self._message(student_id, generation.assistant_message_id),
            }))
            return
        given = [m.id for m, _ in memories]
        is_thread = self.store.role_context(generation.conversation_id)["role"] == "thread"
        learning_plan = brief(PlanStore(self.store).read(generation.conversation_id, student_id))
        try:
            raw = await asyncio.wait_for(
                self._complete_json(model, analysis_messages(history, user_text, reply, memories, given, exercise, is_thread,
                                    learning_plan),
                                    generation.conversation_id, generation.assistant_message_id, "analysis"),
                ANALYSIS_TIMEOUT,
            )
        except (ProviderError, TimeoutError) as exc:
            # The reply is already delivered; failing to take notes must not turn it into an error.
            logger.warning("Learning analysis skipped: %s", getattr(exc, "detail", type(exc).__name__))
            generation.queue.put_nowait(("analysis", {"skipped": True}))
            return
        result = validate_analysis(raw, user_text, exercise, given, learning_plan)
        plan, plan_changes = PlanStore(self.store).apply_analysis(
            generation.conversation_id, student_id, result["plan_updates"], generation.assistant_message_id, user_id,
        )
        if plan_changes:
            generation.queue.put_nowait(("plan", plan))
        if is_thread and isinstance(raw, dict) and isinstance(raw.get("thread_report"), dict):
            try:
                summary = ReportProgress(**raw["thread_report"])
            except ValueError:
                logger.warning("Ignored invalid thread report")
            else:
                self.store.merge_meta(generation.assistant_message_id, {
                    "progress_summary": summary.summary, "needs_user": summary.needs_user,
                })
        topic_key = exercise.topic_key if exercise and result["attempt"] else None
        changes = []
        for observation in result["observations"]:
            recorded = self.store.record_observation_changes(
                student_id, kind=observation["kind"], topic=observation["topic"], topic_key=topic_key,
                summary=observation["summary"], quote=observation["quote"], reason=observation["reason"],
                signal=observation["signal"], related_id=observation["related_id"],
                conversation_id=generation.conversation_id, message_id=user_id,
                subject_id=subject_id, tags=observation["tags"],
            )
            changes += [{"action": change.action, "memory_id": change.memory.id} for change in recorded]
        self.store.merge_meta(user_id, {"analyzed": True, "attempt": result["attempt"], "memory_changes": changes})
        user_turns = sum(1 for row in history if row["role"] == "user")
        prompt = self._record_profile(
            student_id, result.get("profile_ops") or [], generation.assistant_message_id,
        ) if user_turns <= 3 else None
        from app.chat.next_actions import choose
        actions = choose(
            reply=reply, started=plan_at_start, after=plan,
            repeated=self._repeated_misconception(student_id, generation.conversation_id, result["observations"]),
        )
        assistant_meta = {
            "used_memory_ids": result["used_memory_ids"], "suggested_problem_id": result["suggested_problem_id"],
            "next_actions": actions,
        }
        if prompt:
            assistant_meta["preference_prompt"] = prompt
        self.store.merge_meta(generation.assistant_message_id, assistant_meta)
        # Topic naming: once, on the first turn. Manual renames and exercise titles stay untouched.
        if result.get("topic_title") and user_turns == 1 and exercise is None:
            self.store.set_auto_title(generation.conversation_id, result["topic_title"])
        # Compress only when the verbatim part (rows after the last summary) reaches the window limits.
        _, compressed_seq = self.store.get_context_summary(generation.conversation_id)
        fresh = [row for row in history if int(row["seq"]) > compressed_seq]
        fresh_chars = sum(len(row["content"] or "") for row in fresh) + len(reply or "")
        if len(fresh) >= HISTORY_MESSAGES or fresh_chars >= HISTORY_CHARS:
            self._compress_later(student_id, generation.conversation_id, model)
        generation.queue.put_nowait(("analysis", {
            "conversation": self._conversation(student_id, generation.conversation_id),
            "user_message": self._message(student_id, user_id),
            "assistant_message": self._message(student_id, generation.assistant_message_id),
        }))

    async def start_from_topic(self, student_id: str, text: str) -> dict:
        from app.chat.onboarding import INFER_PROMPT, fallback_space, opener_for, parse_inference
        cleaned = " ".join((text or "").split()).strip()
        if not cleaned or len(cleaned) > 200:
            raise ValueError("请用一句话说明你最近在学什么。")
        guessed = fallback_space(cleaned)
        try:
            raw = await asyncio.wait_for(self.model().complete_json([
                {"role": "system", "content": INFER_PROMPT},
                {"role": "user", "content": json.dumps({"text": cleaned}, ensure_ascii=False)},
            ]), 15)
            guessed = parse_inference(raw, cleaned)
        except Exception:
            logger.info("Space inference used the original wording")
            guessed = fallback_space(cleaned)
        subject = self.store.create_subject(student_id, guessed["name"], "", "", goal=guessed["goal"])
        self.store.mark_onboarding(student_id, "completed")
        return {
            "subject_id": subject.id,
            "conversation_id": subject.main_conversation_id,
            "name": subject.name,
            "goal": subject.goal,
            "opener": opener_for(subject.name),
        }

    def _repeated_misconception(self, student_id: str, conversation_id: str, observations: list[dict]) -> bool:
        topics = [item["topic"] for item in observations if item.get("kind") == "misconception" and item.get("signal") == "supports"]
        if not topics:
            return False
        with self.store.connection() as db:
            rows = db.execute(
                "SELECT m.topic AS topic, COUNT(*) AS n FROM learner_memory_evidence e "
                "JOIN learner_memories m ON m.id = e.memory_id "
                "WHERE m.student_id = ? AND m.kind = 'misconception' AND e.conversation_id = ? AND e.signal = 'supports' "
                "GROUP BY m.id",
                (student_id, conversation_id),
            ).fetchall()
        counts: dict[str, int] = {}
        for row in rows:
            counts[row["topic"]] = counts.get(row["topic"], 0) + row["n"]
        return any(counts.get(topic, 0) >= 2 for topic in topics)

    def _record_profile(self, student_id: str, ops: list[dict], message_id: str) -> dict | None:
        if not ops:
            return None
        existing = [" ".join(_PROFILE_LABEL_RE.sub("", entry).split()) for entry in
                    re.split(r"\s*§\s*", self.store.agent_notes(student_id).get("user", "")) if entry.strip()]
        approve = self._agent_flag("memory_write_approval")
        prompt = None
        for op in ops:
            content = " ".join(op["content"].split())
            # Exact-match dedup is not enough: the same fact comes back reworded on every turn.
            if any(content in old or old in content for old in existing if old):
                continue
            if op["layer"] == "Preference":
                if prompt is None:
                    prompt = self.store.queue_preference(student_id, message_id, content, existing)
                continue
            self.store.apply_agent_memory(student_id, "add", "user", f"[{op['layer']}] {content}", None, approve)
            existing.append(content)
        return prompt

    def _compress_later(self, student_id: str, conversation_id: str, model: ChatModel) -> None:
        if conversation_id in self.compressing or self.closing:
            return
        self.compressing.add(conversation_id)

        async def run() -> None:
            try:
                await self.compress_conversation(student_id, conversation_id, model=self._background_model(model))
            except Exception:
                logger.warning("Auto context compression skipped", exc_info=True)
            finally:
                self.compressing.discard(conversation_id)

        task = asyncio.create_task(run())
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)

    async def compress_conversation(
        self, student_id: str, conversation_id: str, *, model: ChatModel | None = None,
    ) -> dict:
        conversation = self.store.conversation(conversation_id, student_id)
        if conversation is None:
            raise LookupError("会话不存在或已删除。")
        history = self.store.history(conversation_id)
        prev_summary, prev_seq = self.store.get_context_summary(conversation_id)
        user_seqs = [int(row["seq"]) for row in history if row["role"] == "user" and row["status"] != "failed"]
        # The two latest user turns and their replies always stay verbatim.
        cutoff = user_seqs[-2] - 1 if len(user_seqs) >= 3 else prev_seq
        rows = [row for row in history if prev_seq < int(row["seq"]) <= cutoff]
        turns = dialogue(rows, bounded=False)
        if not turns:
            return {"conversation_id": conversation_id, "summary": prev_summary, "compressed_turns": 0,
                    "up_to_seq": prev_seq}
        summary_text = ""
        try:
            raw = await asyncio.wait_for(
                self._complete_json(model or self._background_model(self.model()),
                                    compress_history_messages(turns, prev_summary), conversation_id, None, "compress"),
                20,
            )
            if isinstance(raw, dict) and isinstance(raw.get("summary"), str) and raw["summary"].strip():
                summary_text = raw["summary"].strip()[:1800]
        except Exception:
            logger.warning("LLM compression failed; using deterministic summary")
        if not summary_text:
            summary_text = deterministic_compress_fallback(turns, prev_summary)
        self.store.save_context_summary(conversation_id, summary_text, cutoff)
        return {"conversation_id": conversation_id, "summary": summary_text, "compressed_turns": len(turns),
                "up_to_seq": cutoff}

    async def draft_resolution(self, student_id: str, conversation_id: str) -> dict:
        conversation = self.store.conversation(conversation_id, student_id)
        if conversation is None:
            raise LookupError("会话不存在或已删除。")
        if conversation.kind != "thread":
            raise ValueError("只有支线可以整理成小结。")
        subject = self.store.conversation_subject(conversation_id)
        role = self.store.role_context(conversation_id)
        raw = await self._complete_json(
            self.model(), resolution_messages(subject, role.get("anchor"), dialogue(self.store.history(conversation_id))),
            conversation_id, None, "resolution",
        )
        return validate_resolution(raw)

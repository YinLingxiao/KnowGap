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
import logging
import time
from collections.abc import AsyncIterator, Callable

from app.agent_tools import DEFINITIONS, NEEDS_APPROVAL, parse_arguments, run as run_tool, workspace_of
from app.agent_tools.guard import ToolError
from app.agents.llm import ChatModel, ProviderError
from app.chat.agent import (
    active_exercise, analysis_messages, chat_messages, dialogue, resolution_messages, review_messages,
    validate_analysis, validate_resolution,
)
from app.chat.store import ChatStore
from app.chat.schemas import DispatchThread, ReportProgress
from app.chat.coordination import cancel_deliveries, dispatch, next_delivery, report
from app.memory.store import new_id
from app.services.materials import MaterialStore

logger = logging.getLogger(__name__)
ANALYSIS_TIMEOUT = 60
MAX_TOOL_ROUNDS = 8


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


class ToolContext:
    def __init__(self, workspace, store: ChatStore, student_id: str, conversation_id: str, approve_memory: bool = False):
        self.workspace = workspace
        self.store = store
        self.student_id = student_id
        self.conversation_id = conversation_id
        self.approve_memory = approve_memory
        self.dispatch_thread = None
        self.report_progress = None
        self.exercise = None


class ChatService:
    def __init__(self, store: ChatStore, model: Callable[[], ChatModel], library: MaterialStore | None = None, settings=None):
        self.store = store
        self.model = model
        self.library = library
        self.settings = settings
        self.active: dict[str, Generation] = {}
        self.approvals: dict[str, asyncio.Future] = {}
        self.reviews: set[asyncio.Task] = set()
        self.tasks: set[asyncio.Task] = set()
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
            report(self.store, row["student_id"], row["conversation_id"], row["reply_to"], "failed",
                   "服务重启中断了任务，请在 Thread 中检查已有进展后重试。")
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

    def _auto_approve(self) -> bool:
        return self._agent_flag("auto_approve")

    async def _await_approval(self, generation: Generation, name: str, arguments: str) -> bool:
        # A working directory is not a shell sandbox. Commands always require consent.
        if name != "bash" and self._auto_approve():
            return True
        approval_id = new_id("approval")
        future: asyncio.Future = asyncio.get_running_loop().create_future()
        self.approvals[approval_id] = future
        approval = {"id": approval_id, "name": name, "arguments": arguments}
        self.store.merge_meta(generation.assistant_message_id, {"pending_approval": approval})
        self._report(generation, "waiting", "需要你在 Thread 中确认操作后继续。")
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
        user_id = next_delivery(self.store, thread_id)
        if user_id:
            self.begin(student_id, thread_id, user_id, [], detached=True)

    def _dispatch_thread(self, student_id: str, generation: Generation, arguments: dict) -> str:
        body = DispatchThread(**arguments)
        thread_id, message_id = dispatch(
            self.store, student_id, generation.conversation_id, generation.user_message_id,
            body.title, body.task, body.thread_id,
        )
        if not self.store.replies(message_id):
            report(self.store, student_id, thread_id, message_id, "queued", "已收到主对话交办的任务，等待执行。")
        self._start_delivery(student_id, thread_id)
        generation.queue.put_nowait(("thread_dispatched", {"thread_id": thread_id}))
        return json.dumps({"thread_id": thread_id, "delivered": True,
                           "status": "queued" if not self.store.replies(message_id) else
                           self.store.conversation(thread_id, student_id).execution_status}, ensure_ascii=False)

    def _progress(self, student_id: str, generation: Generation, ctx: ToolContext, arguments: dict) -> str:
        body = ReportProgress(**arguments)
        self.store.merge_meta(generation.assistant_message_id, {"needs_user": body.needs_user,
                                                               "progress_summary": body.summary})
        report(self.store, student_id, generation.conversation_id, generation.user_message_id,
               "working", body.summary)
        return "已将进展同步到主对话。"

    def stop(self, conversation_id: str) -> bool:
        generation = self.active.get(conversation_id)
        if generation and generation.streaming and generation.task and not generation.task.done():
            for message_id in cancel_deliveries(self.store, conversation_id):
                report(self.store, generation.student_id, conversation_id, message_id, "cancelled", "这条排队的补充已停止执行。")
            generation.task.cancel()
            return True
        return False

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
        generation.detached = detached
        self.active[conversation_id] = generation
        self._report(generation, "working", "正在处理这项任务，详细过程可在 Thread 中查看。")
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

    def _release(self, generation: Generation) -> None:
        generation.streaming = False
        if self.active.get(generation.conversation_id) is generation:
            del self.active[generation.conversation_id]

    async def _run(self, student_id: str, generation: Generation) -> None:
        queue = generation.queue
        assistant_id = generation.assistant_message_id
        parts: list[str] = []
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
            user_text = user_row["content"]
            exercise = active_exercise(history)
            subject = self.store.conversation_subject(generation.conversation_id)
            subject_id = subject.id if subject else None
            memories = self.store.relevant_memories(
                student_id, user_text, None, subject_id,
            )
            sources = self.library.search_scoped(student_id, user_text[:600], 3, subject_id) if self.library else []
            model = self.model()
            finish = "stop"
            role = self.store.role_context(generation.conversation_id)
            role["delegated_task"] = self.store.message_meta(generation.user_message_id).get("delegated_task")
            snapshot = self.store.frozen_notes(generation.conversation_id, student_id)
            messages = chat_messages(history, memories, exercise, sources, subject, role, snapshot)
            ctx = ToolContext(
                workspace_of(self.settings), self.store, student_id, generation.conversation_id,
                self._agent_flag("memory_write_approval"),
            )
            ctx.exercise = exercise
            if role["role"] == "main":
                ctx.dispatch_thread = lambda arguments: self._dispatch_thread(student_id, generation, arguments)
            if role["role"] == "thread":
                ctx.report_progress = lambda arguments: self._progress(student_id, generation, ctx, arguments)
            definitions = [tool for tool in DEFINITIONS if (
                tool["function"]["name"] in {"dispatch_thread", "session_search", "memory"}
                if role["role"] == "main" else tool["function"]["name"] != "dispatch_thread"
                and (role["role"] == "thread" or tool["function"]["name"] != "report_progress")
            )]
            if exercise is None:
                definitions = [tool for tool in definitions if tool["function"]["name"] != "exercise_reference"]
            for _ in range(MAX_TOOL_ROUNDS):
                calls = None
                round_text: list[str] = []
                try:
                    stream = model.stream(messages, definitions)
                except TypeError:
                    stream = model.stream(messages)
                async for kind, value in stream:
                    if kind == "text":
                        parts.append(value)
                        round_text.append(value)
                        if not generation.detached:
                            queue.put_nowait(("delta", {"text": value}))
                        elif time.monotonic() - last_flush >= 0.3:
                            self.store.finish_reply(assistant_id, content="".join(parts), status="streaming")
                            last_flush = time.monotonic()
                    elif kind == "tool_calls":
                        calls = value
                    elif kind == "finish":
                        finish = value
                if not calls:
                    break
                assistant_calls = []
                for call in calls:
                    if not call.get("id"):
                        call["id"] = new_id("tool")
                    assistant_calls.append({
                        "id": call["id"], "type": "function",
                        "function": {"name": call.get("name") or "", "arguments": call.get("arguments") or "{}"},
                    })
                batch = [{"role": "assistant", "content": "".join(round_text), "tool_calls": assistant_calls}]
                messages.extend(batch)
                tool_messages.extend(batch)
                for call in calls:
                    name = call.get("name") or ""
                    raw_args = call.get("arguments") or "{}"
                    allowed = True
                    if name in NEEDS_APPROVAL and any(t["function"]["name"] == name for t in definitions):
                        allowed = await self._await_approval(generation, name, raw_args)
                    output = "用户拒绝了这次操作。"
                    ok = False
                    if allowed:
                        queue.put_nowait(("tool_start", {"id": call["id"], "name": name, "arguments": raw_args}))
                        try:
                            if not any(t["function"]["name"] == name for t in definitions):
                                raise ToolError("当前对话不支持这个工具。")
                            output = await run_tool(name, parse_arguments(raw_args), ctx)
                            ok = True
                        except (ToolError, json.JSONDecodeError, ValueError) as exc:
                            output = str(exc) or "工具参数无效。"
                        queue.put_nowait(("tool_end", {"id": call["id"], "name": name, "ok": ok, "output": output}))
                    else:
                        queue.put_nowait(("tool_end", {"id": call["id"], "name": name, "ok": False, "output": output}))
                    tool_log.append({"id": call["id"], "name": name, "arguments": raw_args, "output": output, "ok": ok})
                    if generation.detached:
                        self.store.merge_meta(assistant_id, {"tool_calls": tool_log})
                    result = {"role": "tool", "tool_call_id": call["id"], "content": output}
                    messages.append(result)
                    tool_messages.append(result)
                ctx.workspace = workspace_of(self.settings)
            else:
                raise ProviderError(502, "工具调用已达到本轮上限，请缩小任务范围后重试。")
            text = "".join(parts)
            if not text.strip():
                raise ProviderError(502, "模型返回了空回复，请重试。")
            cited = [source.model_dump() for source in sources if f"[{source.label}]" in text]
            self.store.finish_reply(assistant_id, content=text, status="complete", meta={
                "context_memory_ids": [m.id for m, _ in memories], "sources": cited, "truncated": finish == "length",
                "tool_calls": tool_log, "tool_messages": tool_messages,
            })
            self._release(generation)
            queue.put_nowait(("done", {"message": self._message(student_id, assistant_id)}))
            if text.strip():
                # A regenerated reply must not count the same user turn twice.
                already_counted = self.store.message_meta(generation.user_message_id).get("note_counted")
                reset = any(item.get("name") == "memory" and item.get("ok") and
                            item.get("output", "").startswith("已更新") for item in tool_log)
                count = 0 if already_counted else self.store.bump_note_turns(
                    student_id, reset, generation.conversation_id,
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
                    task = asyncio.create_task(self._review(student_id, model, turns))
                    self.reviews.add(task)
                    task.add_done_callback(self.reviews.discard)
            await asyncio.sleep(0)
            try:
                if role["role"] == "main" and any(item["name"] == "dispatch_thread" and item["ok"] for item in tool_log):
                    queue.put_nowait(("analysis", {"skipped": True}))
                else:
                    await self._analyze(student_id, generation, history, user_text, text, memories, exercise, model,
                                        subject_id)
            except Exception:
                # The reply is already complete and stored; note-taking problems must not mark it failed.
                logger.exception("Learning analysis failed")
                queue.put_nowait(("analysis", {"skipped": True}))
        except asyncio.CancelledError:
            if generation.streaming:
                close_tool_batch(tool_messages)
                self.store.finish_reply(assistant_id, content="".join(parts), status="cancelled",
                                        meta={"tool_calls": tool_log, "tool_messages": tool_messages})
                queue.put_nowait(("cancelled", {"message": self._message(student_id, assistant_id)}))
        except ProviderError as exc:
            close_tool_batch(tool_messages)
            self.store.finish_reply(assistant_id, content="".join(parts), status="failed", error=exc.detail,
                                    meta={"tool_calls": tool_log, "tool_messages": tool_messages})
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
                                        meta={"tool_calls": tool_log, "tool_messages": tool_messages})
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
                        "任务已停止，可在 Thread 中继续。" if result.status == "cancelled" else
                        meta.get("progress_summary") or f"本轮回复节选：{result.content[:500]}")
                    self._report(generation, status, summary or "请打开 Thread 查看。")
                self._start_delivery(student_id, generation.conversation_id)
            except Exception:
                logger.exception("Could not publish thread status or start its next delivery")
            queue.put_nowait(None)

    async def _review(self, student_id: str, model: ChatModel, turns: list[dict]) -> None:
        try:
            raw = await model.complete_json(review_messages(self.store.agent_notes(student_id), turns))
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
        try:
            raw = await asyncio.wait_for(
                model.complete_json(analysis_messages(history, user_text, reply, memories, given, exercise, is_thread)),
                ANALYSIS_TIMEOUT,
            )
        except (ProviderError, TimeoutError) as exc:
            # The reply is already delivered; failing to take notes must not turn it into an error.
            logger.warning("Learning analysis skipped: %s", getattr(exc, "detail", type(exc).__name__))
            generation.queue.put_nowait(("analysis", {"skipped": True}))
            return
        result = validate_analysis(raw, user_text, exercise, given)
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
            change = self.store.record_observation(
                student_id, kind=observation["kind"], topic=observation["topic"], topic_key=topic_key,
                summary=observation["summary"], quote=observation["quote"], reason=observation["reason"],
                signal=observation["signal"], related_id=observation["related_id"],
                conversation_id=generation.conversation_id, message_id=user_id,
                subject_id=subject_id, tags=observation["tags"],
            )
            if change:
                changes.append({"action": change.action, "memory_id": change.memory.id})
        self.store.merge_meta(user_id, {"analyzed": True, "attempt": result["attempt"], "memory_changes": changes})
        self.store.merge_meta(generation.assistant_message_id, {
            "used_memory_ids": result["used_memory_ids"], "suggested_problem_id": result["suggested_problem_id"],
        })
        generation.queue.put_nowait(("analysis", {
            "user_message": self._message(student_id, user_id),
            "assistant_message": self._message(student_id, generation.assistant_message_id),
        }))

    async def draft_resolution(self, student_id: str, conversation_id: str) -> dict:
        conversation = self.store.conversation(conversation_id, student_id)
        if conversation is None:
            raise LookupError("会话不存在或已删除。")
        if conversation.kind != "thread":
            raise ValueError("只有 Thread 可以整理成小结。")
        subject = self.store.conversation_subject(conversation_id)
        role = self.store.role_context(conversation_id)
        raw = await self.model().complete_json(
            resolution_messages(subject, role.get("anchor"), dialogue(self.store.history(conversation_id))),
        )
        return validate_resolution(raw)

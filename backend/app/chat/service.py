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
from collections.abc import AsyncIterator, Callable

from app.agents.llm import ChatModel, ProviderError
from app.chat.agent import (
    active_exercise, analysis_messages, chat_messages, dialogue, resolution_messages, validate_analysis,
    validate_resolution,
)
from app.chat.store import ChatStore
from app.services.materials import MaterialStore

logger = logging.getLogger(__name__)
ANALYSIS_TIMEOUT = 60


def sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


class Generation:
    def __init__(self, conversation_id: str, user_message_id: str, assistant_message_id: str):
        self.conversation_id = conversation_id
        self.user_message_id = user_message_id
        self.assistant_message_id = assistant_message_id
        self.queue: asyncio.Queue[tuple[str, dict] | None] = asyncio.Queue()
        self.streaming = True
        self.task: asyncio.Task | None = None


class ChatService:
    def __init__(self, store: ChatStore, model: Callable[[], ChatModel], library: MaterialStore | None = None):
        self.store = store
        self.model = model
        self.library = library
        self.active: dict[str, Generation] = {}

    def is_generating(self, conversation_id: str) -> bool:
        return conversation_id in self.active

    def stop(self, conversation_id: str) -> bool:
        generation = self.active.get(conversation_id)
        if generation and generation.streaming and generation.task and not generation.task.done():
            generation.task.cancel()
            return True
        return False

    def _message(self, student_id: str, message_id: str) -> dict | None:
        message = self.store.message(message_id, student_id)
        return message.model_dump(mode="json") if message else None

    def _conversation(self, student_id: str, conversation_id: str) -> dict | None:
        conversation = self.store.conversation(conversation_id, student_id)
        return conversation.model_dump(mode="json", exclude={"messages"}) if conversation else None

    def begin(self, student_id: str, conversation_id: str, user_message_id: str, discard: list[str]) -> Generation:
        # Called without awaiting in between the caller's is_generating() check, so registration is atomic.
        assistant_id = self.store.start_reply(conversation_id, user_message_id, discard)
        generation = Generation(conversation_id, user_message_id, assistant_id)
        self.active[conversation_id] = generation
        generation.queue.put_nowait(("start", {
            "conversation": self._conversation(student_id, conversation_id),
            "user_message": self._message(student_id, user_message_id),
            "assistant_message": self._message(student_id, assistant_id),
            "discarded_ids": discard,
        }))
        generation.task = asyncio.create_task(self._run(student_id, generation))
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
            if generation.streaming and generation.task and not generation.task.done():
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
        try:
            await asyncio.sleep(0)  # let the queued "start" event reach the client before any blocking work
            history = [row for row in self.store.history(generation.conversation_id) if row["id"] != assistant_id]
            user_row = next(row for row in history if row["id"] == generation.user_message_id)
            user_text = user_row["content"]
            exercise = active_exercise(history)
            subject = self.store.conversation_subject(generation.conversation_id)
            subject_id = subject.id if subject else None
            query = f"{user_text} {exercise.title if exercise else ''}"
            memories = self.store.relevant_memories(
                student_id, query, exercise.topic_key if exercise else None, subject_id,
            )
            sources = self.library.search_scoped(student_id, user_text[:600], 3, subject_id) if self.library else []
            model = self.model()
            finish = "stop"
            role = self.store.role_context(generation.conversation_id)
            async for kind, value in model.stream(chat_messages(history, memories, exercise, sources, subject, role)):
                if kind == "text":
                    parts.append(value)
                    queue.put_nowait(("delta", {"text": value}))
                elif kind == "finish":
                    finish = value
            text = "".join(parts)
            if not text.strip():
                raise ProviderError(502, "模型返回了空回复，请重试。")
            cited = [source.model_dump() for source in sources if f"[{source.label}]" in text]
            self.store.finish_reply(assistant_id, content=text, status="complete", meta={
                "context_memory_ids": [m.id for m, _ in memories], "sources": cited, "truncated": finish == "length",
            })
            self._release(generation)
            queue.put_nowait(("done", {"message": self._message(student_id, assistant_id)}))
            await asyncio.sleep(0)
            try:
                await self._analyze(student_id, generation, history, user_text, text, memories, exercise, model,
                                    subject_id)
            except Exception:
                # The reply is already complete and stored; note-taking problems must not mark it failed.
                logger.exception("Learning analysis failed")
                queue.put_nowait(("analysis", {"skipped": True}))
        except asyncio.CancelledError:
            if generation.streaming:
                self.store.finish_reply(assistant_id, content="".join(parts), status="cancelled")
                queue.put_nowait(("cancelled", {"message": self._message(student_id, assistant_id)}))
        except ProviderError as exc:
            self.store.finish_reply(assistant_id, content="".join(parts), status="failed", error=exc.detail)
            queue.put_nowait(("error", {
                "detail": exc.detail, "status_code": exc.status_code,
                "message": self._message(student_id, assistant_id),
            }))
        except Exception:
            logger.exception("Chat generation failed")
            detail = "生成回复时发生内部错误，请重试。"
            try:
                self.store.finish_reply(assistant_id, content="".join(parts), status="failed", error=detail)
            except Exception:
                logger.exception("Could not record the failed reply")
            queue.put_nowait(("error", {"detail": detail, "status_code": 500, "message": None}))
        finally:
            self._release(generation)
            queue.put_nowait(None)

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
        try:
            raw = await asyncio.wait_for(
                model.complete_json(analysis_messages(history, user_text, reply, memories, given, exercise)),
                ANALYSIS_TIMEOUT,
            )
        except (ProviderError, TimeoutError) as exc:
            # The reply is already delivered; failing to take notes must not turn it into an error.
            logger.warning("Learning analysis skipped: %s", getattr(exc, "detail", type(exc).__name__))
            generation.queue.put_nowait(("analysis", {"skipped": True}))
            return
        result = validate_analysis(raw, user_text, exercise, given)
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

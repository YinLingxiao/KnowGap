"""SQLite persistence for free conversations and evidence-backed learner memories.

Legacy tables (learning_sessions/messages/learning_memories) are never modified here.
They are copied once into the new tables, and `legacy_imports` records what was copied,
so deleting an imported item does not resurrect it on the next start.
"""

import json
import logging
import re
import sqlite3
import unicodedata
from datetime import datetime, timedelta, timezone

from app.chat.schemas import (
    ChatMessage, Conversation, ConversationSummary, DispatchedThread, ExerciseAttempt, LearnerMemory, MemoryChange,
    MemoryEvidence, SystemEvent, ToolCallRecord, PreferencePrompt,
    MessageAnchor, SpaceProgress, Subject, ThreadSummary,
)
from app.chat.skills import ONBOARDING_FIRST_MESSAGE, ONBOARDING_TITLE
from app.memory.curated import LIMITS, apply as apply_note, bump_turns, decide, onboarding_state, pending, set_onboarding_state
from app.memory.curated import ensure as ensure_notes
from app.memory.curated import ensure_fts, read_all, search as search_notes, snapshot_text, write as write_note
from app.memory.store import Store, ensure_column, new_id, now
from app.models.schemas import Problem, SourceReference
from app.services.materials import terms
from app.services.problems import PROBLEMS

TOPIC_LABELS = {"stack.lifo": "栈 · 后进先出"}
TOPIC_TAGS = {"stack.lifo": ["栈", "后进先出", "LIFO"]}
# Sentinel for "field not provided" where None is meaningful (no Subject / general memory).
UNSET = object()
# Fewer topical hits than this in the Subject and general memories triggers the outward search.
MIN_LOCAL_HITS = 2
# Single characters too common to signal a shared topic.
STOP_CHARS = set("的了是在我你他她它们和与或也都就不没有吗呢吧啊这那个一些什么怎么为如何要会能可以说想看问题对吧嗯哦好请帮")
INTERRUPTED = "服务重启，生成被中断。可以重新生成这条回复。"
DEFAULT_COLOR = "#3d6fdb"
LEVELS = {"beginner", "some", "fluent", "exam"}
STATUSES = {
    "misconception": {"suspected", "needs_review", "improving", "resolved"},
    "mastery": {"observed", "uncertain"},
    "preference": {"observed", "uncertain"},
}
# Threads created by confirming a proposal already have a card in the proposal list.
PROPOSAL_TASK_PREFIX = "proposal:"
# How many Threads the coordinator's context lists with full detail, and as a bare handle.
MAIN_CONTEXT_OPEN_THREADS = 20
MAIN_CONTEXT_RESOLVED_THREADS = 10

logger = logging.getLogger(__name__)


def clip(text: str, limit: int) -> str:
    text = " ".join(text.split())
    return text if len(text) <= limit else text[:limit].rstrip() + "…"


def default_title(content: str) -> str:
    text = re.sub(r"```.*?(```|$)", " ", content, flags=re.S)
    text = re.sub(r"[#>*_`\[\]]", "", text)
    text = " ".join(text.split())
    if not text:
        return "代码讨论"
    return text if len(text) <= 20 else text[:20].rstrip() + "…"


def normalize(text: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", text).split())


def quote_in(quote: str, text: str) -> bool:
    quote = normalize(quote)
    return bool(quote) and quote in normalize(text)


def topic_terms(text: str) -> set[str]:
    return {t for t in terms(text) if len(t) > 1 or t not in STOP_CHARS}


def exercise_text(problem: Problem) -> str:
    return f"**{problem.title}**\n\n{problem.prompt}"


_NEXT_ACTIONS = {"quiz", "schedule", "save_note", "weak_points"}


def _preference_prompt(raw) -> PreferencePrompt | None:
    if not isinstance(raw, dict) or raw.get("status", "pending") != "pending":
        return None
    if not all(isinstance(raw.get(key), str) and raw.get(key) for key in ("id", "text", "content")):
        return None
    return PreferencePrompt(id=raw["id"], text=raw["text"], content=raw["content"])


def _next_actions(raw) -> list[str]:
    if not isinstance(raw, list):
        return []
    return [item for item in raw if item in _NEXT_ACTIONS][:2]


def _system_event(raw) -> SystemEvent | None:
    if not isinstance(raw, dict) or not isinstance(raw.get("type"), str) or not raw["type"]:
        return None
    return SystemEvent(
        type=raw["type"],
        report_ids=[item for item in raw.get("report_ids") or [] if isinstance(item, str)],
        thread_ids=[item for item in raw.get("thread_ids") or [] if isinstance(item, str)],
    )


def is_system_event(meta: dict) -> bool:
    """The one marker that separates a hidden system event from a learner's own message."""
    event = meta.get("system_event") if isinstance(meta, dict) else None
    return isinstance(event, dict) and bool(event.get("type"))


def is_system_event_row(row: sqlite3.Row) -> bool:
    """Same check for a stored message row; use it wherever user rows are turned into model input."""
    try:
        return is_system_event(json.loads(row["meta_json"]))
    except (TypeError, ValueError, KeyError, IndexError):
        return False


class ChatStore:
    def __init__(self, store: Store):
        self.store = store

    def connection(self):
        return self.store.connection()

    # ------------------------------------------------------------------ setup

    def initialize(self) -> None:
        with self.connection() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS thread_dispatches (
                    source_message_id TEXT NOT NULL REFERENCES conversation_messages(id) ON DELETE CASCADE,
                    task_key TEXT NOT NULL,
                    thread_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                    message_id TEXT NOT NULL REFERENCES conversation_messages(id) ON DELETE CASCADE,
                    PRIMARY KEY(source_message_id, task_key)
                );
                CREATE TABLE IF NOT EXISTS conversations (
                    id TEXT PRIMARY KEY, student_id TEXT NOT NULL,
                    title TEXT NOT NULL,
                    title_source TEXT NOT NULL CHECK(title_source IN ('pending', 'auto', 'user')),
                    client_request_id TEXT, legacy_session_id TEXT UNIQUE,
                    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                    kind TEXT NOT NULL DEFAULT 'chat',
                    parent_id TEXT, anchor_message_id TEXT, thread_status TEXT, resolved_at TEXT,
                    model_key TEXT, model_notice_key TEXT,
                    UNIQUE(student_id, client_request_id)
                );
                CREATE TABLE IF NOT EXISTS conversation_messages (
                    id TEXT PRIMARY KEY,
                    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                    seq INTEGER NOT NULL,
                    role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
                    kind TEXT NOT NULL CHECK(kind IN ('text', 'exercise')),
                    content TEXT NOT NULL,
                    status TEXT NOT NULL CHECK(status IN ('complete', 'streaming', 'failed', 'cancelled')),
                    error TEXT, client_request_id TEXT, reply_to TEXT,
                    meta_json TEXT NOT NULL DEFAULT '{}',
                    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                    UNIQUE(conversation_id, seq), UNIQUE(conversation_id, client_request_id)
                );
                CREATE TABLE IF NOT EXISTS model_usage (
                    id TEXT PRIMARY KEY,
                    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                    message_id TEXT REFERENCES conversation_messages(id) ON DELETE SET NULL,
                    purpose TEXT NOT NULL, model TEXT NOT NULL, created_at TEXT NOT NULL,
                    input_tokens INTEGER, output_tokens INTEGER, cached_tokens INTEGER
                );
                CREATE INDEX IF NOT EXISTS idx_usage_conversation ON model_usage(conversation_id);
                CREATE TABLE IF NOT EXISTS learner_memories (
                    id TEXT PRIMARY KEY, student_id TEXT NOT NULL,
                    kind TEXT NOT NULL CHECK(kind IN ('misconception', 'mastery', 'preference')),
                    topic TEXT NOT NULL, topic_key TEXT, summary TEXT NOT NULL, status TEXT NOT NULL,
                    confidence REAL NOT NULL, user_corrected INTEGER NOT NULL DEFAULT 0,
                    origin TEXT NOT NULL DEFAULT 'chat' CHECK(origin IN ('chat', 'diagnosis')),
                    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS learner_memory_evidence (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    memory_id TEXT NOT NULL REFERENCES learner_memories(id) ON DELETE CASCADE,
                    conversation_id TEXT, message_id TEXT,
                    quote TEXT NOT NULL, reason TEXT NOT NULL,
                    signal TEXT NOT NULL CHECK(signal IN ('supports', 'contradicts')),
                    created_at TEXT NOT NULL,
                    UNIQUE(memory_id, message_id)
                );
                CREATE TABLE IF NOT EXISTS legacy_imports (
                    kind TEXT NOT NULL, legacy_id TEXT NOT NULL, PRIMARY KEY(kind, legacy_id)
                );
                CREATE TABLE IF NOT EXISTS subjects (
                    id TEXT PRIMARY KEY, student_id TEXT NOT NULL, name TEXT NOT NULL,
                    description TEXT NOT NULL DEFAULT '', instructions TEXT NOT NULL DEFAULT '',
                    goal TEXT NOT NULL DEFAULT '', level TEXT, deadline TEXT,
                    color TEXT NOT NULL DEFAULT '#3d6fdb', main_conversation_id TEXT,
                    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS custom_skills (
                    id TEXT PRIMARY KEY,
                    student_id TEXT NOT NULL,
                    name TEXT NOT NULL,
                    role TEXT NOT NULL DEFAULT 'thread' CHECK(role IN ('thread', 'chat', 'main')),
                    trigger_keywords TEXT NOT NULL DEFAULT '',
                    content TEXT NOT NULL,
                    enabled INTEGER NOT NULL DEFAULT 1,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS thread_reports (
                    id TEXT PRIMARY KEY,
                    main_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                    thread_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                    source_message_id TEXT NOT NULL REFERENCES conversation_messages(id) ON DELETE CASCADE,
                    outcome TEXT NOT NULL CHECK(outcome IN ('resolved', 'failed')),
                    summary TEXT NOT NULL,
                    state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending', 'delivered', 'skipped')),
                    delivered_event_id TEXT, delivered_at TEXT,
                    attempts INTEGER NOT NULL DEFAULT 0, not_before TEXT,
                    created_at TEXT NOT NULL,
                    UNIQUE(source_message_id)
                );
                CREATE UNIQUE INDEX IF NOT EXISTS idx_thread_reports_pending
                    ON thread_reports(thread_id) WHERE state = 'pending';
            """)
            # NULL subject_id: conversation outside any Subject / general memory that applies everywhere.
            ensure_column(db, "conversations", "subject_id", "TEXT")
            ensure_column(db, "conversations", "kind", "TEXT NOT NULL DEFAULT 'chat'")
            ensure_column(db, "conversations", "parent_id", "TEXT")
            ensure_column(db, "conversations", "anchor_message_id", "TEXT")
            ensure_column(db, "conversations", "thread_status", "TEXT")
            ensure_column(db, "conversations", "resolved_at", "TEXT")
            ensure_column(db, "learner_memories", "subject_id", "TEXT")
            ensure_column(db, "learner_memories", "tags_json", "TEXT NOT NULL DEFAULT '[]'")
            ensure_column(db, "subjects", "goal", "TEXT NOT NULL DEFAULT ''")
            ensure_column(db, "subjects", "level", "TEXT")
            ensure_column(db, "subjects", "deadline", "TEXT")
            ensure_column(db, "subjects", "color", "TEXT NOT NULL DEFAULT '#3d6fdb'")
            ensure_column(db, "subjects", "main_conversation_id", "TEXT")
            ensure_column(db, "conversations", "notes_snapshot", "TEXT")
            ensure_column(db, "conversations", "context_summary", "TEXT NOT NULL DEFAULT ''")
            ensure_column(db, "conversations", "compressed_up_to_seq", "INTEGER NOT NULL DEFAULT 0")
            ensure_column(db, "conversations", "model_key", "TEXT")
            ensure_column(db, "conversations", "model_notice_key", "TEXT")
            self._migrate_spaces(db)
            ensure_notes(db)
            from app.chat.onboarding import ensure as ensure_onboarding
            from app.chat.preferences import ensure as ensure_preferences
            ensure_onboarding(db)
            ensure_preferences(db)
            ensure_fts(db)
            # A process that died mid-generation leaves "streaming" rows; they can never finish.
            db.execute(
                "UPDATE conversation_messages SET status = 'failed', error = ?, updated_at = ? WHERE status = 'streaming'",
                (INTERRUPTED, now()),
            )
            self._prune_thread_update_cards(db)
        self.import_legacy()

    def _prune_thread_update_cards(self, db: sqlite3.Connection) -> None:
        """Drop the per-worker-turn progress cards that older versions appended to a main line.

        Spaces can be deleted later, which turns their main line into a plain chat, so the scan
        cannot rely on `kind = 'main'`; the `thread_update` meta key is the reliable marker.
        A one-shot marker keeps startup from re-scanning every assistant message forever.
        """
        done = db.execute(
            "SELECT 1 FROM legacy_imports WHERE kind = 'migration' AND legacy_id = 'thread_update_cards'",
        ).fetchone()
        if done:
            return
        rows = db.execute(
            "SELECT id FROM conversation_messages WHERE role = 'assistant' AND kind = 'text' "
            "AND json_extract(meta_json, '$.thread_update') IS NOT NULL",
        ).fetchall()
        if rows:
            db.executemany("DELETE FROM conversation_messages WHERE id = ?", [(row["id"],) for row in rows])
            logger.info("Removed %d obsolete Thread progress cards", len(rows))
        db.execute("INSERT INTO legacy_imports VALUES ('migration', 'thread_update_cards')")

    def _migrate_spaces(self, db: sqlite3.Connection) -> None:
        """Spaces that predate the main conversation get one; their other chats become open threads."""
        db.execute("UPDATE conversations SET kind = 'chat' WHERE kind IS NULL OR kind = ''")
        for subject in db.execute("SELECT * FROM subjects").fetchall():
            main_id = subject["main_conversation_id"]
            if main_id and db.execute("SELECT 1 FROM conversations WHERE id = ?", (main_id,)).fetchone():
                continue
            timestamp = now()
            main_id = new_id("conv")
            db.execute(
                "INSERT INTO conversations(id, student_id, title, title_source, subject_id, kind, created_at, updated_at) "
                "VALUES (?, ?, ?, 'user', ?, 'main', ?, ?)",
                (main_id, subject["student_id"], subject["name"], subject["id"], timestamp, timestamp),
            )
            db.execute(
                "UPDATE subjects SET main_conversation_id = ?, color = COALESCE(NULLIF(color, ''), ?) WHERE id = ?",
                (main_id, DEFAULT_COLOR, subject["id"]),
            )
            db.execute(
                "UPDATE conversations SET kind = 'thread', parent_id = ?, thread_status = 'open' "
                "WHERE subject_id = ? AND id != ? AND COALESCE(kind, 'chat') != 'main'",
                (main_id, subject["id"], main_id),
            )

    def import_legacy(self) -> None:
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            sessions = db.execute("""
                SELECT * FROM learning_sessions s WHERE NOT EXISTS (
                    SELECT 1 FROM legacy_imports i WHERE i.kind = 'session' AND i.legacy_id = s.id
                ) ORDER BY created_at
            """).fetchall()
            for session in sessions:
                problem = PROBLEMS.get(session["problem_id"])
                rows = db.execute("SELECT * FROM messages WHERE session_id = ? ORDER BY rowid", (session["id"],)).fetchall()
                conversation_id = new_id("conv")
                updated = rows[-1]["created_at"] if rows else session["created_at"]
                title = f"练习 · {problem.title}" if problem else "历史练习"
                db.execute(
                    "INSERT INTO conversations(id, student_id, title, title_source, legacy_session_id, created_at, "
                    "updated_at) VALUES (?, ?, ?, 'auto', ?, ?, ?)",
                    (conversation_id, session["student_id"], title, session["id"], session["created_at"], updated),
                )
                seq = 0
                if problem:
                    seq += 1
                    db.execute(
                        "INSERT INTO conversation_messages VALUES (?, ?, ?, 'assistant', 'exercise', ?, 'complete', "
                        "NULL, NULL, NULL, ?, ?, ?)",
                        (new_id("cmsg"), conversation_id, seq, exercise_text(problem),
                         json.dumps({"problem_id": problem.id}), session["created_at"], session["created_at"]),
                    )
                last_user = None
                for row in rows:
                    seq += 1
                    meta: dict = {"analyzed": True}
                    if row["role"] == "user" and row["diagnosis_json"]:
                        diagnosis = json.loads(row["diagnosis_json"])
                        meta["attempt"] = {
                            "problem_id": session["problem_id"], "assessment": diagnosis["assessment"],
                            "issue": diagnosis.get("issue"), "evidence": diagnosis["evidence"],
                            "confidence": diagnosis.get("confidence"),
                        }
                    if row["role"] == "assistant":
                        meta["used_memory_ids"] = []
                    # Legacy message ids are reused so imported memory evidence can point at them.
                    db.execute(
                        "INSERT INTO conversation_messages VALUES (?, ?, ?, ?, 'text', ?, 'complete', NULL, NULL, ?, ?, ?, ?)",
                        (row["id"], conversation_id, seq, row["role"], row["content"],
                         last_user if row["role"] == "assistant" else None,
                         json.dumps(meta, ensure_ascii=False), row["created_at"], row["created_at"]),
                    )
                    if row["role"] == "user":
                        last_user = row["id"]
                db.execute("INSERT INTO legacy_imports VALUES ('session', ?)", (session["id"],))
            memories = db.execute("""
                SELECT * FROM learning_memories m WHERE NOT EXISTS (
                    SELECT 1 FROM legacy_imports i WHERE i.kind = 'memory' AND i.legacy_id = m.id
                )
            """).fetchall()
            for memory in memories:
                memory_id = new_id("lmem")
                db.execute(
                    "INSERT INTO learner_memories(id, student_id, kind, topic, topic_key, summary, status, confidence, "
                    "origin, tags_json, created_at, updated_at) "
                    "VALUES (?, ?, 'misconception', ?, ?, ?, ?, ?, 'diagnosis', ?, ?, ?)",
                    (memory_id, memory["student_id"], TOPIC_LABELS.get(memory["topic_key"], memory["topic_key"]),
                     memory["topic_key"], memory["summary"], memory["status"], memory["confidence"],
                     json.dumps(TOPIC_TAGS.get(memory["topic_key"], []), ensure_ascii=False),
                     memory["updated_at"], memory["updated_at"]),
                )
                for evidence in db.execute("""
                    SELECT m.id, m.created_at, m.diagnosis_json, c.id AS conversation_id FROM memory_evidence e
                    JOIN messages m ON m.id = e.message_id
                    LEFT JOIN conversations c ON c.legacy_session_id = m.session_id
                    WHERE e.memory_id = ? ORDER BY e.rowid
                """, (memory["id"],)).fetchall():
                    diagnosis = json.loads(evidence["diagnosis_json"])
                    db.execute(
                        "INSERT OR IGNORE INTO learner_memory_evidence"
                        "(memory_id, conversation_id, message_id, quote, reason, signal, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                        (memory_id, evidence["conversation_id"], evidence["id"], diagnosis["evidence"],
                         f"题目作答诊断：{diagnosis['assessment']}",
                         "supports" if diagnosis["assessment"] == "incorrect" else "contradicts", evidence["created_at"]),
                    )
                db.execute("INSERT INTO legacy_imports VALUES ('memory', ?)", (memory["id"],))

    # ---------------------------------------------------------- conversations

    def _summary(self, db: sqlite3.Connection, row: sqlite3.Row) -> dict:
        latest = db.execute(
            "SELECT role, status, meta_json FROM conversation_messages WHERE conversation_id = ? ORDER BY seq DESC LIMIT 1",
            (row["id"],),
        ).fetchone()
        execution = None
        if row["kind"] == "thread":
            execution = "idle"
            if latest:
                meta = json.loads(latest["meta_json"])
                if latest["role"] == "user":
                    execution = "queued"
                elif latest["status"] == "streaming":
                    execution = "waiting" if meta.get("pending_approval") else "working"
                elif latest["status"] in {"failed", "cancelled"}:
                    execution = latest["status"]
                elif meta.get("needs_user"):
                    execution = "waiting"
        stats = db.execute("""
            SELECT COUNT(*) AS n,
              (SELECT content FROM conversation_messages WHERE conversation_id = ? AND kind = 'text'
                 AND content != '' AND json_extract(meta_json, '$.system_event') IS NULL
                 ORDER BY seq DESC LIMIT 1) AS preview,
              (SELECT meta_json FROM conversation_messages WHERE conversation_id = ? AND kind = 'exercise'
                 ORDER BY seq DESC LIMIT 1) AS exercise
            FROM conversation_messages WHERE conversation_id = ?
              AND json_extract(meta_json, '$.system_event') IS NULL
        """, (row["id"], row["id"], row["id"])).fetchone()
        preview = " ".join((stats["preview"] or "").split())
        return {
            "id": row["id"], "title": row["title"], "title_source": row["title_source"],
            "subject_id": row["subject_id"],
            "kind": row["kind"] or "chat", "parent_id": row["parent_id"],
            "model_key": self._model_key(db, row),
            "thread_status": row["thread_status"], "anchor": self._anchor(db, row["anchor_message_id"]),
            "execution_status": execution,
            "active_problem_id": json.loads(stats["exercise"])["problem_id"] if stats["exercise"] else None,
            "legacy_session_id": row["legacy_session_id"], "message_count": stats["n"],
            "preview": preview[:80], "created_at": row["created_at"], "updated_at": row["updated_at"],
        }

    def _anchor(self, db: sqlite3.Connection, message_id: str | None) -> MessageAnchor | None:
        if not message_id:
            return None
        row = db.execute(
            "SELECT id, role, content FROM conversation_messages WHERE id = ?", (message_id,),
        ).fetchone()
        if row is None:
            return MessageAnchor(message_id=message_id, role="assistant", excerpt="")
        return MessageAnchor(message_id=row["id"], role=row["role"], excerpt=clip(row["content"], 80))

    def _model_key(self, db: sqlite3.Connection, row: sqlite3.Row) -> str | None:
        names = set(row.keys())
        own = row["model_key"] if "model_key" in names else None
        if own:
            return own
        if (row["kind"] or "") == "thread" and row["parent_id"]:
            parent = db.execute("SELECT model_key FROM conversations WHERE id = ?", (row["parent_id"],)).fetchone()
            if parent and parent["model_key"]:
                return parent["model_key"]
        return None

    def conversation_model_key(self, conversation_id: str) -> str | None:
        with self.connection() as db:
            row = db.execute(
                "SELECT model_key, kind, parent_id FROM conversations WHERE id = ?", (conversation_id,),
            ).fetchone()
            return self._model_key(db, row) if row else None

    def set_conversation_model(self, conversation_id: str, student_id: str, model_key: str | None) -> bool:
        with self.connection() as db:
            cur = db.execute(
                "UPDATE conversations SET model_key = ?, model_notice_key = NULL, updated_at = ? "
                "WHERE id = ? AND student_id = ?",
                (model_key, now(), conversation_id, student_id),
            )
            return cur.rowcount > 0

    def claim_model_notice(self, conversation_id: str, requested: str) -> bool:
        with self.connection() as db:
            row = db.execute(
                "SELECT model_notice_key FROM conversations WHERE id = ?", (conversation_id,),
            ).fetchone()
            if row is None or row["model_notice_key"] == requested:
                return False
            db.execute(
                "UPDATE conversations SET model_notice_key = ? WHERE id = ?", (requested, conversation_id),
            )
            return True

    def clear_model_notice(self, conversation_id: str) -> None:
        with self.connection() as db:
            db.execute(
                "UPDATE conversations SET model_notice_key = NULL WHERE id = ? AND model_notice_key IS NOT NULL",
                (conversation_id,),
            )

    def list_conversations(self, student_id: str, subject_id: str | None = None) -> list[ConversationSummary]:
        self.import_legacy()
        with self.connection() as db:
            rows = db.execute(
                "SELECT * FROM conversations WHERE student_id = ? AND (? IS NULL OR subject_id = ?) "
                "AND COALESCE(kind, 'chat') != 'main' "
                "ORDER BY updated_at DESC, created_at DESC", (student_id, subject_id, subject_id),
            ).fetchall()
            return [ConversationSummary(**self._summary(db, row)) for row in rows]

    def conversation(self, conversation_id: str, student_id: str) -> Conversation | None:
        with self.connection() as db:
            row = db.execute(
                "SELECT * FROM conversations WHERE id = ? AND student_id = ?", (conversation_id, student_id),
            ).fetchone()
            if row is None:
                return None
            rows = db.execute(
                "SELECT * FROM conversation_messages WHERE conversation_id = ? ORDER BY seq", (conversation_id,),
            ).fetchall()
            memories = self._memories_by_id(db, student_id)
            dispatched = self._dispatched_threads(db, conversation_id)
            return Conversation(**self._summary(db, row), messages=[
                self._message(r, memories, dispatched.get(r["id"])) for r in rows
            ])

    def create_conversation(
        self, student_id: str, *, title: str | None, problem: Problem | None, client_request_id: str | None,
        subject_id: str | None = None,
    ) -> str:
        timestamp = now()
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            if client_request_id:
                existing = db.execute(
                    "SELECT id FROM conversations WHERE student_id = ? AND client_request_id = ?",
                    (student_id, client_request_id),
                ).fetchone()
                if existing:
                    return existing["id"]
            conversation_id = new_id("conv")
            if title:
                title_source = "user"
            elif problem:
                title, title_source = f"练习 · {problem.title}", "auto"
            else:
                title, title_source = "新对话", "pending"
            db.execute(
                "INSERT INTO conversations(id, student_id, title, title_source, client_request_id, subject_id, "
                "created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (conversation_id, student_id, title, title_source, client_request_id, subject_id, timestamp, timestamp),
            )
            if problem:
                self._insert(db, conversation_id, role="assistant", kind="exercise", content=exercise_text(problem),
                             status="complete", meta={"problem_id": problem.id})
            return conversation_id

    def update_conversation(self, conversation_id: str, student_id: str, title=UNSET, subject_id=UNSET) -> bool:
        with self.connection() as db:
            row = db.execute("SELECT kind, subject_id FROM conversations WHERE id = ? AND student_id = ?",
                             (conversation_id, student_id)).fetchone()
            if row is None:
                return False
            if subject_id is not UNSET and subject_id != row["subject_id"] and (row["kind"] or "chat") != "chat":
                raise ValueError("主线和支线属于学习空间，不能单独移出。")
            if title is not UNSET:
                db.execute("UPDATE conversations SET title = ?, title_source = 'user' WHERE id = ?",
                           (title, conversation_id))
            if subject_id is not UNSET:
                # Memories already learned here keep their scope; the learner edits that separately.
                db.execute("UPDATE conversations SET subject_id = ? WHERE id = ?", (subject_id, conversation_id))
            return True

    def set_auto_title(self, conversation_id: str, title: str) -> bool:
        """Update conversation title only if the user has not manually renamed it."""
        clean = " ".join(title.split()).strip(" \t\r\n\"'“”‘’《》「」。，、！？!?")[:32]
        if not clean:
            return False
        with self.connection() as db:
            cur = db.execute(
                "UPDATE conversations SET title = ?, title_source = 'auto' "
                "WHERE id = ? AND title_source IN ('pending', 'auto') AND title NOT LIKE '练习 · %'",
                (clean, conversation_id),
            )
            return cur.rowcount > 0

    def get_context_summary(self, conversation_id: str) -> tuple[str, int]:
        with self.connection() as db:
            row = db.execute(
                "SELECT context_summary, compressed_up_to_seq FROM conversations WHERE id = ?",
                (conversation_id,),
            ).fetchone()
            if row is None:
                return "", 0
            return str(row["context_summary"] or ""), int(row["compressed_up_to_seq"] or 0)

    def save_context_summary(self, conversation_id: str, summary: str, up_to_seq: int) -> None:
        with self.connection() as db:
            db.execute(
                "UPDATE conversations SET context_summary = ?, compressed_up_to_seq = ?, updated_at = ? WHERE id = ?",
                (summary[:2400], max(0, int(up_to_seq)), now(), conversation_id),
            )

    def conversation_subject(self, conversation_id: str) -> Subject | None:
        with self.connection() as db:
            row = db.execute("SELECT subject_id FROM conversations WHERE id = ?", (conversation_id,)).fetchone()
            return self._subject(db, row["subject_id"]) if row and row["subject_id"] else None

    # --------------------------------------------------------------- subjects

    def _subject(self, db: sqlite3.Connection, subject_id: str, student_id: str | None = None) -> Subject | None:
        row = db.execute(
            "SELECT * FROM subjects WHERE id = ? AND (? IS NULL OR student_id = ?)", (subject_id, student_id, student_id),
        ).fetchone()
        if row is None:
            return None
        counts = db.execute(
            "SELECT (SELECT COUNT(*) FROM conversations WHERE subject_id = ? AND COALESCE(kind, 'chat') != 'main') "
            "AS conversations, "
            "(SELECT COUNT(*) FROM learner_memories WHERE subject_id = ?) AS memories, "
            "(SELECT COUNT(*) FROM course_materials WHERE subject_id = ?) AS materials",
            (subject_id, subject_id, subject_id),
        ).fetchone()
        memory = db.execute(
            "SELECT "
            "SUM(CASE WHEN kind = 'misconception' AND status IN ('suspected', 'needs_review') THEN 1 ELSE 0 END) "
            "AS to_review, "
            "SUM(CASE WHEN kind = 'misconception' AND status = 'improving' THEN 1 ELSE 0 END) AS improving, "
            "SUM(CASE WHEN kind = 'mastery' OR (kind = 'misconception' AND status = 'resolved') THEN 1 ELSE 0 END) "
            "AS mastered FROM learner_memories WHERE subject_id = ?",
            (subject_id,),
        ).fetchone()
        threads = db.execute(
            "SELECT "
            "SUM(CASE WHEN kind = 'thread' AND COALESCE(thread_status, 'open') = 'open' THEN 1 ELSE 0 END) AS open_threads, "
            "SUM(CASE WHEN kind = 'thread' AND thread_status = 'resolved' THEN 1 ELSE 0 END) AS resolved_threads, "
            "MAX(updated_at) AS studied FROM conversations WHERE subject_id = ?",
            (subject_id,),
        ).fetchone()
        return Subject(
            id=row["id"], name=row["name"], description=row["description"], instructions=row["instructions"],
            goal=row["goal"] or "", level=row["level"] if row["level"] in LEVELS else None,
            deadline=row["deadline"], color=row["color"] or DEFAULT_COLOR,
            main_conversation_id=row["main_conversation_id"],
            progress=SpaceProgress(
                to_review=memory["to_review"] or 0, improving=memory["improving"] or 0,
                mastered=memory["mastered"] or 0, open_threads=threads["open_threads"] or 0,
                resolved_threads=threads["resolved_threads"] or 0, last_studied_at=threads["studied"],
            ),
            conversation_count=counts["conversations"], memory_count=counts["memories"],
            material_count=counts["materials"], created_at=row["created_at"], updated_at=row["updated_at"],
        )

    def subjects(self, student_id: str) -> list[Subject]:
        with self.connection() as db:
            rows = db.execute(
                "SELECT id FROM subjects WHERE student_id = ? ORDER BY created_at", (student_id,),
            ).fetchall()
            return [self._subject(db, row["id"]) for row in rows]

    def subject(self, subject_id: str, student_id: str) -> Subject | None:
        with self.connection() as db:
            return self._subject(db, subject_id, student_id)

    def create_subject(
        self, student_id: str, name: str, description: str, instructions: str, *,
        goal: str = "", level: str | None = None, deadline: str | None = None, color: str | None = None,
    ) -> Subject:
        timestamp = now()
        subject_id = new_id("subj")
        main_id = new_id("conv")
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute(
                "INSERT INTO subjects(id, student_id, name, description, instructions, goal, level, deadline, color, "
                "main_conversation_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (subject_id, student_id, name, description, instructions, goal, level, deadline,
                 color or DEFAULT_COLOR, main_id, timestamp, timestamp),
            )
            db.execute(
                "INSERT INTO conversations(id, student_id, title, title_source, subject_id, kind, created_at, updated_at) "
                "VALUES (?, ?, ?, 'user', ?, 'main', ?, ?)",
                (main_id, student_id, name, subject_id, timestamp, timestamp),
            )
            return self._subject(db, subject_id)

    def update_subject(self, subject_id: str, student_id: str, changes: dict) -> Subject | None:
        with self.connection() as db:
            current = self._subject(db, subject_id, student_id)
            if current is None:
                return None
            for field in ("name", "description", "instructions", "goal", "level", "deadline", "color"):
                if field in changes:
                    db.execute(f"UPDATE subjects SET {field} = ? WHERE id = ?", (changes[field], subject_id))
            if "name" in changes and changes["name"] and current.main_conversation_id:
                db.execute(
                    "UPDATE conversations SET title = ? WHERE id = ? AND title = ?",
                    (changes["name"], current.main_conversation_id, current.name),
                )
            db.execute("UPDATE subjects SET updated_at = ? WHERE id = ?", (now(), subject_id))
            return self._subject(db, subject_id)

    def delete_subject(self, subject_id: str, student_id: str) -> bool:
        # Nothing learned is destroyed: conversations become ordinary chats, memories become general.
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            if self._subject(db, subject_id, student_id) is None:
                return False
            db.execute(
                "UPDATE conversations SET subject_id = NULL, kind = 'chat', parent_id = NULL, "
                "anchor_message_id = NULL, thread_status = NULL, resolved_at = NULL WHERE subject_id = ?",
                (subject_id,),
            )
            db.execute("UPDATE learner_memories SET subject_id = NULL WHERE subject_id = ?", (subject_id,))
            db.execute("UPDATE course_materials SET subject_id = NULL WHERE subject_id = ?", (subject_id,))
            db.execute("DELETE FROM subjects WHERE id = ?", (subject_id,))
            return True

    def threads(self, subject_id: str, student_id: str) -> list[ConversationSummary] | None:
        with self.connection() as db:
            if self._subject(db, subject_id, student_id) is None:
                return None
            rows = db.execute(
                "SELECT * FROM conversations WHERE student_id = ? AND subject_id = ? AND kind = 'thread' "
                "ORDER BY CASE WHEN COALESCE(thread_status, 'open') = 'open' THEN 0 ELSE 1 END, "
                "updated_at DESC, created_at DESC",
                (student_id, subject_id),
            ).fetchall()
            return [ConversationSummary(**self._summary(db, row)) for row in rows]

    def create_thread(
        self, student_id: str, subject_id: str, *, title: str | None, anchor_message_id: str | None,
        client_request_id: str,
    ) -> str:
        timestamp = now()
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            subject = self._subject(db, subject_id, student_id)
            if subject is None or not subject.main_conversation_id:
                raise LookupError("学习空间不存在或已删除。")
            existing = db.execute(
                "SELECT id FROM conversations WHERE student_id = ? AND client_request_id = ?",
                (student_id, client_request_id),
            ).fetchone()
            if existing:
                return existing["id"]
            # A thread nobody has written in yet is reused, so repeated clicks do not pile up empty ones.
            blank = db.execute(
                "SELECT id FROM conversations c WHERE c.student_id = ? AND c.subject_id = ? AND c.kind = 'thread' "
                "AND COALESCE(c.thread_status, 'open') = 'open' AND c.anchor_message_id IS ? "
                "AND NOT EXISTS (SELECT 1 FROM conversation_messages m WHERE m.conversation_id = c.id) "
                "ORDER BY c.created_at LIMIT 1",
                (student_id, subject_id, anchor_message_id or None),
            ).fetchone()
            if blank:
                return blank["id"]
            if anchor_message_id:
                anchor = db.execute(
                    "SELECT 1 FROM conversation_messages WHERE id = ? AND conversation_id = ?",
                    (anchor_message_id, subject.main_conversation_id),
                ).fetchone()
                if anchor is None:
                    raise LookupError("锚点消息不在主线里。")
            thread_id = new_id("conv")
            db.execute(
                "INSERT INTO conversations(id, student_id, title, title_source, client_request_id, subject_id, kind, "
                "parent_id, anchor_message_id, thread_status, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, 'thread', ?, ?, 'open', ?, ?)",
                (thread_id, student_id, title or "新支线", "user" if title else "pending", client_request_id,
                 subject_id, subject.main_conversation_id, anchor_message_id, timestamp, timestamp),
            )
            return thread_id

    def role_context(self, conversation_id: str) -> dict:
        with self.connection() as db:
            row = db.execute("SELECT * FROM conversations WHERE id = ?", (conversation_id,)).fetchone()
            if row is None or (row["kind"] or "chat") == "chat":
                return {"role": "chat"}
            if row["kind"] == "main":
                # Open Threads first, newest first; resolved ones stay as bare handles for follow-ups.
                threads = db.execute(
                    "SELECT * FROM conversations WHERE parent_id = ? AND kind = 'thread' "
                    "ORDER BY CASE WHEN COALESCE(thread_status, 'open') = 'resolved' THEN 1 ELSE 0 END, "
                    "updated_at DESC", (conversation_id,),
                ).fetchall()
                opened = [item for item in threads if (item["thread_status"] or "open") != "resolved"]
                resolved = [item for item in threads if (item["thread_status"] or "open") == "resolved"]
                opened = opened[:MAIN_CONTEXT_OPEN_THREADS]
                progress = self._progress_summaries(db, [item["id"] for item in opened])
                errors = self._thread_errors(db, [item["id"] for item in opened])
                entries = []
                for item in opened:
                    entry = {key: value for key, value in self._summary(db, item).items()
                             if key in {"id", "title", "preview", "thread_status", "execution_status"}}
                    if progress.get(item["id"]):
                        entry["progress_summary"] = progress[item["id"]]
                    if errors.get(item["id"]):
                        # 失败原因以前写在主线卡片里；现在由支线列表转达，协调者才答得上「为什么失败」
                        entry["error"] = errors[item["id"]]
                    entries.append(entry)
                entries += [
                    {"id": item["id"], "title": item["title"], "thread_status": item["thread_status"]}
                    for item in resolved[:MAIN_CONTEXT_RESOLVED_THREADS]
                ]
                return {"role": "main", "threads": entries}
            anchor = None
            if row["anchor_message_id"]:
                message = db.execute(
                    "SELECT role, content FROM conversation_messages WHERE id = ?", (row["anchor_message_id"],),
                ).fetchone()
                if message:
                    anchor = {"role": message["role"], "excerpt": clip(message["content"], 400)}
            recent = []
            if row["parent_id"]:
                rows = db.execute(
                    "SELECT role, content FROM conversation_messages WHERE conversation_id = ? "
                    "AND status != 'failed' AND TRIM(content) != '' "
                    "AND json_extract(meta_json, '$.system_event') IS NULL "
                    "ORDER BY seq DESC LIMIT 6",
                    (row["parent_id"],),
                ).fetchall()
                recent = [{"role": item["role"], "excerpt": clip(item["content"], 240)} for item in reversed(rows)]
            return {"role": "thread", "anchor": anchor, "main_recent": recent}

    def _progress_summaries(self, db: sqlite3.Connection, thread_ids: list[str]) -> dict[str, str]:
        """Latest progress note per Thread, in a single query.

        The newest message is often a queued input, an empty streaming placeholder or a
        stopped/failed reply, so take the newest assistant message that actually reported.
        """
        if not thread_ids:
            return {}
        marks = ", ".join("?" for _ in thread_ids)
        rows = db.execute(
            f"SELECT m.conversation_id AS conversation_id, m.meta_json AS meta_json "
            f"FROM conversation_messages m WHERE m.conversation_id IN ({marks}) AND m.role = 'assistant' "
            f"AND m.seq = (SELECT MAX(seq) FROM conversation_messages "
            f"  WHERE conversation_id = m.conversation_id AND role = 'assistant' "
            f"  AND TRIM(COALESCE(json_extract(meta_json, '$.progress_summary'), '')) != '')",
            thread_ids,
        ).fetchall()
        found: dict[str, str] = {}
        for row in rows:
            summary = json.loads(row["meta_json"]).get("progress_summary")
            if isinstance(summary, str) and summary.strip():
                found[row["conversation_id"]] = summary
        return found

    def _thread_errors(self, db: sqlite3.Connection, thread_ids: list[str]) -> dict[str, str]:
        """Last failure reason per Thread, in a single query, so the coordinator can explain it."""
        if not thread_ids:
            return {}
        marks = ", ".join("?" for _ in thread_ids)
        rows = db.execute(
            f"SELECT m.conversation_id AS conversation_id, m.error AS error "
            f"FROM conversation_messages m WHERE m.conversation_id IN ({marks}) "
            f"AND m.status = 'failed' AND TRIM(COALESCE(m.error, '')) != '' "
            f"AND m.seq = (SELECT MAX(seq) FROM conversation_messages "
            f"  WHERE conversation_id = m.conversation_id AND status = 'failed' "
            f"  AND TRIM(COALESCE(error, '')) != '')",
            thread_ids,
        ).fetchall()
        return {row["conversation_id"]: clip(row["error"], 200) for row in rows}

    # ---------------------------------------------------------- thread reports

    def record_thread_report(self, main_id: str, thread_id: str, source_message_id: str, outcome: str,
                             summary: str, not_before: str | None = None) -> str | None:
        """One pending report per Thread, and one report per source message.

        A newer report replaces the one still waiting to be delivered; repeating the same
        source (a retried resolve) is a no-op, which keeps the endpoint idempotent.
        """
        report_id = new_id("report")
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("DELETE FROM thread_reports WHERE thread_id = ? AND state = 'pending'", (thread_id,))
            cursor = db.execute(
                "INSERT INTO thread_reports(id, main_id, thread_id, source_message_id, outcome, summary, state, "
                "delivered_event_id, delivered_at, attempts, not_before, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, 0, ?, ?) "
                "ON CONFLICT(source_message_id) DO NOTHING",
                (report_id, main_id, thread_id, source_message_id, outcome, clip(summary, 600), not_before, now()),
            )
            return report_id if cursor.rowcount else None

    def pending_thread_reports(self, main_id: str | None = None) -> list[dict]:
        with self.connection() as db:
            rows = db.execute(
                "SELECT r.*, c.title AS thread_title FROM thread_reports r "
                "JOIN conversations c ON c.id = r.thread_id "
                "WHERE r.state = 'pending' AND (? IS NULL OR r.main_id = ?) ORDER BY r.created_at, r.id",
                (main_id, main_id),
            ).fetchall()
            return [dict(row) for row in rows]

    def pending_report_mains(self) -> list[str]:
        with self.connection() as db:
            return [row["main_id"] for row in db.execute(
                "SELECT DISTINCT main_id FROM thread_reports WHERE state = 'pending'",
            )]

    def deliver_pending_reports(self, main_id: str, limit: int, build) -> tuple[str, list[sqlite3.Row]] | None:
        """Take the oldest deliverable reports and insert the hidden event that carries them.

        Selection, the event message and the delivery marks commit together, so a replay cannot
        deliver the same report twice. `build(rows)` returns the model-facing text and its meta.
        """
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            rows = db.execute(
                "SELECT r.*, c.title AS thread_title FROM thread_reports r "
                "JOIN conversations c ON c.id = r.thread_id "
                "WHERE r.main_id = ? AND r.state = 'pending' AND (r.not_before IS NULL OR r.not_before <= ?) "
                "ORDER BY r.created_at, r.id LIMIT ?",
                (main_id, now(), limit),
            ).fetchall()
            if not rows:
                return None
            content, meta = build(rows)
            event_id = self._insert(db, main_id, role="user", kind="text", content=content, status="complete",
                                    meta=meta)
            timestamp = now()
            db.executemany(
                "UPDATE thread_reports SET state = 'delivered', delivered_event_id = ?, delivered_at = ? WHERE id = ?",
                [(event_id, timestamp, row["id"]) for row in rows],
            )
            return event_id, rows

    def delivered_event_count(self, main_id: str, since: str) -> int:
        # Delivered ids are kept even when a silent turn deletes its event message, so the cap still counts it.
        with self.connection() as db:
            return db.execute(
                "SELECT COUNT(DISTINCT delivered_event_id) FROM thread_reports "
                "WHERE main_id = ? AND state = 'delivered' AND delivered_at >= ?", (main_id, since),
            ).fetchone()[0]

    def rollback_wake(self, event_id: str, reply_id: str | None, *, preempted: bool,
                      base_delay: int, max_attempts: int) -> int:
        """Undo one delivered wake event: restore its reports and drop the reply and event atomically.

        Only reports still pointing at this event are touched, so a report re-delivered by a
        newer event is never dragged back. Returns how many reports were restored.
        """
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            event = db.execute(
                "SELECT conversation_id FROM conversation_messages WHERE id = ?", (event_id,),
            ).fetchone()
            rows = db.execute(
                "SELECT id, attempts FROM thread_reports WHERE state = 'delivered' AND delivered_event_id = ?",
                (event_id,),
            ).fetchall()
            for row in rows:
                if preempted:
                    db.execute(
                        "UPDATE thread_reports SET state = 'pending', delivered_event_id = NULL, delivered_at = NULL, "
                        "not_before = NULL WHERE id = ?", (row["id"],),
                    )
                    continue
                attempts = int(row["attempts"]) + 1
                if attempts >= max_attempts:
                    db.execute("UPDATE thread_reports SET state = 'skipped', delivered_event_id = NULL, "
                               "delivered_at = NULL, attempts = ? WHERE id = ?", (attempts, row["id"]))
                else:
                    delay = base_delay * 2 ** attempts
                    db.execute(
                        "UPDATE thread_reports SET state = 'pending', delivered_event_id = NULL, delivered_at = NULL, "
                        "attempts = ?, not_before = ? WHERE id = ?",
                        (attempts, (datetime.now(timezone.utc) + timedelta(seconds=delay)).isoformat(), row["id"]),
                    )
            if reply_id:
                db.execute("DELETE FROM conversation_messages WHERE id = ?", (reply_id,))
            db.execute("DELETE FROM conversation_messages WHERE id = ?", (event_id,))
            if event:
                self._restore_updated_at(db, event["conversation_id"])
            return len(rows)

    def skip_pending_resolved(self, thread_id: str) -> int:
        """Reopening a Thread invalidates a not-yet-delivered resolved report."""
        with self.connection() as db:
            cursor = db.execute(
                "UPDATE thread_reports SET state = 'skipped' "
                "WHERE thread_id = ? AND state = 'pending' AND outcome = 'resolved'", (thread_id,),
            )
            return cursor.rowcount

    def skip_pending_reports(self, main_id: str) -> int:
        with self.connection() as db:
            cursor = db.execute(
                "UPDATE thread_reports SET state = 'skipped', delivered_event_id = NULL, delivered_at = NULL "
                "WHERE main_id = ? AND state = 'pending'", (main_id,),
            )
            return cursor.rowcount

    def delivered_events(self) -> list[dict]:
        """Delivered events that may still need a rollback, grouped by event (bounded by reports)."""
        with self.connection() as db:
            rows = db.execute(
                "SELECT r.id AS report_id, r.delivered_event_id AS event_id, "
                "  (SELECT status FROM conversation_messages WHERE id = r.delivered_event_id) AS event_status, "
                "  (SELECT r2.id FROM conversation_messages r2 WHERE r2.reply_to = r.delivered_event_id "
                "     ORDER BY r2.seq DESC LIMIT 1) AS reply_id, "
                "  (SELECT r2.status FROM conversation_messages r2 WHERE r2.reply_to = r.delivered_event_id "
                "     ORDER BY r2.seq DESC LIMIT 1) AS reply_status "
                "FROM thread_reports r WHERE r.state = 'delivered' AND r.delivered_event_id IS NOT NULL "
                "ORDER BY r.created_at, r.id",
            ).fetchall()
        events: dict[str, dict] = {}
        for row in rows:
            event = events.setdefault(row["event_id"], {
                "event_id": row["event_id"], "report_ids": [], "reply_id": row["reply_id"],
                "reply_status": row["reply_status"], "event_status": row["event_status"],
            })
            event["report_ids"].append(row["report_id"])
        return list(events.values())

    def discard_system_event(self, event_id: str, reply_id: str | None) -> None:
        """Remove the reply first, then the hidden event that caused it (one transaction).

        The conversation goes back to its previous sort position: a silent wake turn must not
        push the main line to the top for a message the learner never saw.
        """
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            event = db.execute(
                "SELECT conversation_id FROM conversation_messages WHERE id = ?", (event_id,),
            ).fetchone()
            if reply_id:
                db.execute("DELETE FROM conversation_messages WHERE id = ?", (reply_id,))
            db.execute("DELETE FROM conversation_messages WHERE id = ?", (event_id,))
            if event:
                self._restore_updated_at(db, event["conversation_id"])

    def _restore_updated_at(self, db: sqlite3.Connection, conversation_id: str) -> None:
        db.execute(
            "UPDATE conversations SET updated_at = COALESCE("
            "(SELECT MAX(created_at) FROM conversation_messages WHERE conversation_id = ?), updated_at) "
            "WHERE id = ?", (conversation_id, conversation_id),
        )

    def last_message_at(self, conversation_id: str) -> str | None:
        with self.connection() as db:
            row = db.execute(
                "SELECT MAX(created_at) AS latest FROM conversation_messages WHERE conversation_id = ?",
                (conversation_id,),
            ).fetchone()
            return row["latest"] if row else None

    def earliest_pending_not_before(self, main_id: str) -> str | None:
        with self.connection() as db:
            row = db.execute(
                "SELECT MIN(not_before) AS earliest FROM thread_reports "
                "WHERE main_id = ? AND state = 'pending' AND not_before IS NOT NULL", (main_id,),
            ).fetchone()
            return row["earliest"] if row else None

    def thread_resolved(self, conversation_id: str) -> bool:
        with self.connection() as db:
            row = db.execute(
                "SELECT thread_status FROM conversations WHERE id = ?", (conversation_id,),
            ).fetchone()
            return bool(row) and row["thread_status"] == "resolved"

    def conversation_student(self, conversation_id: str) -> str | None:
        with self.connection() as db:
            row = db.execute("SELECT student_id FROM conversations WHERE id = ?", (conversation_id,)).fetchone()
            return row["student_id"] if row else None

    def resolve_thread(self, conversation_id: str, student_id: str, title: str, summary: str, takeaways: list[str]) -> dict:
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                "SELECT * FROM conversations WHERE id = ? AND student_id = ?", (conversation_id, student_id),
            ).fetchone()
            if row is None:
                raise LookupError("会话不存在或已删除。")
            if row["kind"] != "thread" or not row["parent_id"]:
                raise ValueError("只有支线可以合并回主线。")
            existing = self._summary_message(db, row["parent_id"], conversation_id)
            if row["thread_status"] == "resolved" and existing:
                card = json.loads(existing["meta_json"])["thread_summary"]
                return {"title": card["title"], "summary": card["summary"], "takeaways": card["takeaways"],
                        "message_id": existing["id"]}
            memory_ids = [item["memory_id"] for item in db.execute(
                "SELECT DISTINCT memory_id FROM learner_memory_evidence WHERE conversation_id = ? ORDER BY memory_id",
                (conversation_id,),
            )]
            lines = [f"支线「{title}」已解决", "", summary]
            if takeaways:
                lines += ["", *[f"- {item}" for item in takeaways]]
            message_id = self._insert(
                db, row["parent_id"], role="assistant", kind="text", content="\n".join(lines), status="complete",
                meta={"thread_summary": {
                    "thread_id": conversation_id, "title": title, "summary": summary,
                    "takeaways": takeaways, "memory_ids": memory_ids,
                }},
            )
            db.execute(
                "UPDATE conversations SET thread_status = 'resolved', resolved_at = ?, updated_at = ? WHERE id = ?",
                (now(), now(), conversation_id),
            )
            return {"title": title, "summary": summary, "takeaways": takeaways, "message_id": message_id}

    def reopen_thread(self, conversation_id: str, student_id: str) -> bool:
        with self.connection() as db:
            row = db.execute(
                "SELECT kind FROM conversations WHERE id = ? AND student_id = ?", (conversation_id, student_id),
            ).fetchone()
            if row is None:
                return False
            if row["kind"] != "thread":
                raise ValueError("只有支线可以重新打开。")
            db.execute(
                "UPDATE conversations SET thread_status = 'open', resolved_at = NULL, updated_at = ? WHERE id = ?",
                (now(), conversation_id),
            )
            return True

    def _summary_message(self, db: sqlite3.Connection, main_id: str, thread_id: str):
        rows = db.execute(
            "SELECT id, meta_json FROM conversation_messages WHERE conversation_id = ? ORDER BY seq DESC", (main_id,),
        ).fetchall()
        for item in rows:
            card = json.loads(item["meta_json"]).get("thread_summary")
            if isinstance(card, dict) and card.get("thread_id") == thread_id:
                return item
        return None

    def delete_conversation(self, conversation_id: str, student_id: str) -> bool:
        with self.connection() as db:
            row = db.execute(
                "SELECT kind FROM conversations WHERE id = ? AND student_id = ?", (conversation_id, student_id),
            ).fetchone()
            if row is not None and row["kind"] == "main":
                raise ValueError("主线不能单独删除，请删除整个学习空间。")
            cursor = db.execute(
                "DELETE FROM conversations WHERE id = ? AND student_id = ?", (conversation_id, student_id),
            )
            return cursor.rowcount == 1

    # --------------------------------------------------------------- messages

    def _insert(
        self, db: sqlite3.Connection, conversation_id: str, *, role: str, kind: str, content: str, status: str,
        meta: dict | None = None, reply_to: str | None = None, client_request_id: str | None = None,
    ) -> str:
        timestamp = now()
        seq = db.execute(
            "SELECT COALESCE(MAX(seq), 0) + 1 FROM conversation_messages WHERE conversation_id = ?", (conversation_id,),
        ).fetchone()[0]
        message_id = new_id("cmsg")
        db.execute(
            "INSERT INTO conversation_messages VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)",
            (message_id, conversation_id, seq, role, kind, content, status, client_request_id, reply_to,
             json.dumps(meta or {}, ensure_ascii=False), timestamp, timestamp),
        )
        db.execute("UPDATE conversations SET updated_at = ? WHERE id = ?", (timestamp, conversation_id))
        return message_id

    def _dispatched_threads(self, db: sqlite3.Connection, conversation_id: str,
                            source_message_id: str | None = None) -> dict[str, list[str]]:
        """Cards for the Threads each main-line user message dispatched, in dispatch order.

        Loaded once per conversation so the message mapper never queries per row. A Thread
        that no longer exists (or moved out of this main line) simply stops having a card.
        """
        rows = db.execute(
            "SELECT d.source_message_id AS source_id, d.thread_id AS thread_id "
            "FROM thread_dispatches d "
            "JOIN conversation_messages m ON m.id = d.source_message_id "
            "JOIN conversations c ON c.id = m.conversation_id "
            "JOIN conversations t ON t.id = d.thread_id "
            "WHERE m.conversation_id = ? AND c.kind = 'main' AND m.role = 'user' "
            "AND t.kind = 'thread' AND t.parent_id = c.id AND d.task_key NOT LIKE ? "
            + ("AND m.id = ? " if source_message_id else "")
            + "ORDER BY d.rowid",
            (conversation_id, f"{PROPOSAL_TASK_PREFIX}%", *([source_message_id] if source_message_id else [])),
        ).fetchall()
        grouped: dict[str, list[str]] = {}
        for row in rows:
            thread_ids = grouped.setdefault(row["source_id"], [])
            if row["thread_id"] not in thread_ids:
                thread_ids.append(row["thread_id"])
        return grouped

    def _message(self, row: sqlite3.Row, memories: dict[str, LearnerMemory],
                 dispatched: list[str] | None = None) -> ChatMessage:
        from app.chat.checkpoints import resume_state
        meta = json.loads(row["meta_json"])
        checkpoint_available, checkpoint_blocked_reason = resume_state(meta.get("last_checkpoint"), row["status"])
        changes = [
            MemoryChange(action=change["action"], memory=memories[change["memory_id"]])
            for change in meta.get("memory_changes", []) if change["memory_id"] in memories
        ]
        return ChatMessage(
            id=row["id"], conversation_id=row["conversation_id"], seq=row["seq"], role=row["role"], kind=row["kind"],
            content=row["content"], status=row["status"], error=row["error"], reply_to=row["reply_to"],
            client_request_id=row["client_request_id"], problem_id=meta.get("problem_id"),
            attempt=ExerciseAttempt(**meta["attempt"]) if meta.get("attempt") else None,
            memory_changes=changes,
            used_memory_ids=[i for i in meta.get("used_memory_ids", []) if i in memories],
            plan_changes=meta.get("plan_changes", []),
            suggested_problem_id=meta.get("suggested_problem_id"),
            sources=[SourceReference(**source) for source in meta.get("sources", [])],
            truncated=bool(meta.get("truncated")),
            reasoning=str(meta.get("reasoning") or ""),
            files=[item for item in meta.get("files", []) if isinstance(item, dict) and item.get("id")],
            tool_calls=[ToolCallRecord(**item) for item in meta.get("tool_calls", []) if isinstance(item, dict) and item.get("id") and item.get("name")],
            thread_summary=self._thread_summary(meta.get("thread_summary")),
            dispatched_threads=[DispatchedThread(thread_id=item) for item in dispatched or []],
            # Set on the hidden user message that wakes the coordinator; the learner never sees it.
            system_event=_system_event(meta.get("system_event")),
            thread_proposals=meta.get("thread_proposals", []),
            pending_approval=meta.get("pending_approval"),
            preference_prompt=_preference_prompt(meta.get("preference_prompt")),
            next_actions=_next_actions(meta.get("next_actions")),
            checkpoint_available=checkpoint_available, checkpoint_blocked_reason=checkpoint_blocked_reason,
            created_at=row["created_at"], updated_at=row["updated_at"],
        )

    def _thread_summary(self, card) -> ThreadSummary | None:
        if not isinstance(card, dict) or not isinstance(card.get("thread_id"), str):
            return None
        return ThreadSummary(
            thread_id=card["thread_id"], title=str(card.get("title") or ""), summary=str(card.get("summary") or ""),
            takeaways=[item for item in card.get("takeaways") or [] if isinstance(item, str)],
            memory_ids=[item for item in card.get("memory_ids") or [] if isinstance(item, str)],
        )

    def message(self, message_id: str, student_id: str) -> ChatMessage | None:
        with self.connection() as db:
            row = db.execute("""
                SELECT m.* FROM conversation_messages m JOIN conversations c ON c.id = m.conversation_id
                WHERE m.id = ? AND c.student_id = ?
            """, (message_id, student_id)).fetchone()
            if row is None:
                return None
            if row["role"] != "user":
                # 只有主线用户消息会带卡片，助手消息不必再查一遍派发记录
                return self._message(row, self._memories_by_id(db, student_id))
            dispatched = self._dispatched_threads(db, row["conversation_id"], row["id"])
            return self._message(row, self._memories_by_id(db, student_id), dispatched.get(row["id"]))

    def message_meta(self, message_id: str) -> dict:
        with self.connection() as db:
            row = db.execute("SELECT meta_json FROM conversation_messages WHERE id = ?", (message_id,)).fetchone()
            return json.loads(row["meta_json"]) if row else {}

    def find_request(self, conversation_id: str, client_request_id: str) -> str | None:
        with self.connection() as db:
            row = db.execute(
                "SELECT id FROM conversation_messages WHERE conversation_id = ? AND client_request_id = ?",
                (conversation_id, client_request_id),
            ).fetchone()
            return row["id"] if row else None

    def replies(self, user_message_id: str) -> list[sqlite3.Row]:
        with self.connection() as db:
            return db.execute(
                "SELECT * FROM conversation_messages WHERE reply_to = ? ORDER BY seq", (user_message_id,),
            ).fetchall()

    def last_user_message(self, conversation_id: str) -> tuple[str | None, bool]:
        """Returns the latest user text message and whether anything but its own replies follows it."""
        with self.connection() as db:
            row = db.execute("""
                SELECT id, seq FROM conversation_messages WHERE conversation_id = ? AND role = 'user'
                ORDER BY seq DESC LIMIT 1
            """, (conversation_id,)).fetchone()
            if row is None:
                return None, False
            later = db.execute("""
                SELECT COUNT(*) FROM conversation_messages
                WHERE conversation_id = ? AND seq > ? AND COALESCE(reply_to, '') != ?
            """, (conversation_id, row["seq"], row["id"])).fetchone()[0]
            return row["id"], later > 0

    def add_user_message(self, conversation_id: str, content: str, client_request_id: str) -> str:
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            message_id = self._insert(db, conversation_id, role="user", kind="text", content=content,
                                      status="complete", client_request_id=client_request_id)
            db.execute(
                "UPDATE conversations SET title = ?, title_source = 'auto' WHERE id = ? AND title_source = 'pending'",
                (default_title(content), conversation_id),
            )
            return message_id

    def add_exercise(self, conversation_id: str, problem: Problem) -> str:
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            message_id = self._insert(db, conversation_id, role="assistant", kind="exercise",
                                      content=exercise_text(problem), status="complete", meta={"problem_id": problem.id})
            db.execute(
                "UPDATE conversations SET title = ?, title_source = 'auto' WHERE id = ? AND title_source = 'pending'",
                (f"练习 · {problem.title}", conversation_id),
            )
            return message_id

    def start_reply(self, conversation_id: str, reply_to: str, discard: list[str]) -> str:
        """Atomically drop superseded replies (retry/regenerate) and open a streaming placeholder."""
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            for message_id in discard:
                db.execute("DELETE FROM conversation_messages WHERE id = ? AND reply_to = ?", (message_id, reply_to))
            return self._insert(db, conversation_id, role="assistant", kind="text", content="",
                                status="streaming", reply_to=reply_to)

    def finish_reply(
        self, message_id: str, *, content: str, status: str, error: str | None = None, meta: dict | None = None,
    ) -> None:
        with self.connection() as db:
            current = db.execute("SELECT meta_json FROM conversation_messages WHERE id = ?", (message_id,)).fetchone()
            if current is None:
                return
            merged = {**json.loads(current["meta_json"]), **(meta or {})}
            timestamp = now()
            db.execute(
                "UPDATE conversation_messages SET content = ?, status = ?, error = ?, meta_json = ?, updated_at = ? WHERE id = ?",
                (content, status, error, json.dumps(merged, ensure_ascii=False), timestamp, message_id),
            )

    def merge_meta(self, message_id: str, meta: dict) -> None:
        with self.connection() as db:
            current = db.execute("SELECT meta_json FROM conversation_messages WHERE id = ?", (message_id,)).fetchone()
            if current is not None:
                db.execute("UPDATE conversation_messages SET meta_json = ? WHERE id = ?",
                           (json.dumps({**json.loads(current["meta_json"]), **meta}, ensure_ascii=False), message_id))

    def history(self, conversation_id: str, before_seq: int | None = None) -> list[sqlite3.Row]:
        with self.connection() as db:
            return db.execute("""
                SELECT * FROM conversation_messages WHERE conversation_id = ? AND (? IS NULL OR seq < ?) ORDER BY seq
            """, (conversation_id, before_seq, before_seq)).fetchall()

    def record_usage(self, request_id: str, conversation_id: str, message_id: str | None,
                     purpose: str, model: str, usage: dict | None = None) -> None:
        # One row per provider request, not per streamed chunk. Regeneration keeps its real cost
        # even when the old reply is discarded. Deleting the conversation removes its ledger.
        with self.connection() as db:
            if not db.execute("SELECT 1 FROM conversations WHERE id = ?", (conversation_id,)).fetchone():
                return
            if message_id and not db.execute("SELECT 1 FROM conversation_messages WHERE id = ?", (message_id,)).fetchone():
                message_id = None
            values = usage or {}
            db.execute("""
                INSERT INTO model_usage VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET input_tokens=excluded.input_tokens,
                    output_tokens=excluded.output_tokens, cached_tokens=excluded.cached_tokens
            """, (request_id, conversation_id, message_id, purpose, model, now(),
                  values.get("input_tokens"), values.get("output_tokens"), values.get("cached_tokens")))

    def usage(self, student_id: str, subject_id: str | None = None,
              conversation_id: str | None = None) -> dict:
        with self.connection() as db:
            rows = db.execute("""
                SELECT u.* FROM model_usage u JOIN conversations c ON c.id = u.conversation_id
                WHERE c.student_id = ? AND (? IS NULL OR c.subject_id = ?)
                  AND (? IS NULL OR c.id = ?)
            """, (student_id, subject_id, subject_id, conversation_id, conversation_id)).fetchall()
        def totals(items):
            cached = [r["cached_tokens"] for r in items if r["cached_tokens"] is not None]
            return {
                "requests": len(items), "reported_requests": sum(r["input_tokens"] is not None for r in items),
                "input_tokens": sum(r["input_tokens"] or 0 for r in items),
                "output_tokens": sum(r["output_tokens"] or 0 for r in items),
                "cached_tokens": sum(cached) if cached else None,
            }
        ids = {r["conversation_id"] for r in rows}
        return {"total": totals(rows), "conversations": {
            cid: totals([r for r in rows if r["conversation_id"] == cid]) for cid in ids
        }}

    # --------------------------------------------------------------- memories

    def _memories_by_id(self, db: sqlite3.Connection, student_id: str) -> dict[str, LearnerMemory]:
        return {memory.id: memory for memory in self._memories(db, student_id)}

    def _memories(self, db: sqlite3.Connection, student_id: str, memory_id: str | None = None) -> list[LearnerMemory]:
        rows = db.execute("""
            SELECT * FROM learner_memories WHERE student_id = ? AND (? IS NULL OR id = ?) ORDER BY updated_at DESC
        """, (student_id, memory_id, memory_id)).fetchall()
        result = []
        for row in rows:
            evidence = db.execute("""
                SELECT e.*, EXISTS(SELECT 1 FROM conversations c WHERE c.id = e.conversation_id) AS available
                FROM learner_memory_evidence e WHERE e.memory_id = ? ORDER BY e.id
            """, (row["id"],)).fetchall()
            result.append(LearnerMemory(
                id=row["id"], kind=row["kind"], topic=row["topic"], topic_key=row["topic_key"], summary=row["summary"],
                status=row["status"], confidence=row["confidence"], user_corrected=bool(row["user_corrected"]),
                origin=row["origin"], subject_id=row["subject_id"], tags=json.loads(row["tags_json"]),
                created_at=row["created_at"], updated_at=row["updated_at"],
                evidence=[MemoryEvidence(
                    conversation_id=e["conversation_id"], message_id=e["message_id"], quote=e["quote"],
                    reason=e["reason"], signal=e["signal"], created_at=e["created_at"],
                    source_available=bool(e["available"]),
                ) for e in evidence],
            ))
        return result

    def _notes_view(self, notes: dict[str, str]) -> dict:
        return {**notes, "limits": dict(LIMITS)}

    def agent_notes(self, student_id: str) -> dict[str, str]:
        with self.connection() as db:
            return read_all(db, student_id)

    def agent_notes_view(self, student_id: str) -> dict:
        return self._notes_view(self.agent_notes(student_id))

    def save_agent_note(self, student_id: str, target: str, content: str) -> dict:
        with self.connection() as db:
            write_note(db, student_id, target, content, now())
            return self._notes_view(read_all(db, student_id))

    def apply_agent_memory(self, student_id: str, action: str, target: str, content, old_text, approve: bool = False) -> str:
        with self.connection() as db:
            return apply_note(db, student_id, action, target, content, old_text, now(), approve)

    def pending_notes(self, student_id: str) -> list[dict]:
        with self.connection() as db:
            return pending(db, student_id)

    def queue_preference(self, student_id: str, message_id: str, content: str, existing: list[str]) -> dict | None:
        from app.chat.preferences import queue
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            return queue(db, student_id, message_id, content, existing)

    def decide_preference(self, student_id: str, prompt_id: str, allow: bool) -> str | None:
        from app.chat.preferences import decide as settle
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            return settle(db, student_id, prompt_id, allow)

    def decide_pending(self, student_id: str, pending_id: str, allow: bool) -> str | None:
        with self.connection() as db:
            return decide(db, student_id, pending_id, allow, now())

    def bump_note_turns(self, student_id: str, reset: bool, conversation_id: str) -> int:
        with self.connection() as db:
            return bump_turns(db, student_id, reset, conversation_id)

    def onboarding_status(self, student_id: str) -> dict:
        with self.connection() as db:
            from app.chat.onboarding import state as read_state
            state = read_state(db, student_id)
            state["has_user_profile"] = bool(read_all(db, student_id)["user"].strip())
            conv_id = state.get("conversation_id")
            if conv_id:
                exists = db.execute(
                    "SELECT id FROM conversations WHERE id = ? AND student_id = ?",
                    (conv_id, student_id),
                ).fetchone()
                if not exists:
                    state["conversation_id"] = None
            return state

    def start_onboarding(self, student_id: str) -> Conversation:
        from app.chat.onboarding import QUESTIONS
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            from app.chat.onboarding import state as read_state
            state = read_state(db, student_id)
            conv_id = state.get("conversation_id")
            if conv_id:
                existing = db.execute(
                    "SELECT id FROM conversations WHERE id = ? AND student_id = ?",
                    (conv_id, student_id),
                ).fetchone()
                if existing:
                    if state["status"] != "in_progress":
                        db.execute("UPDATE onboarding_sessions SET status='in_progress', version=version+1 WHERE student_id=?", (student_id,))
                    conv = self.conversation(conv_id, student_id)
                    if conv is not None:
                        return conv
            timestamp = now()
            conv_id = new_id("conv")
            db.execute(
                "INSERT INTO conversations(id, student_id, title, title_source, kind, created_at, updated_at) "
                "VALUES (?, ?, ?, 'user', 'chat', ?, ?)",
                (conv_id, student_id, ONBOARDING_TITLE, timestamp, timestamp),
            )
            self._insert(
                db,
                conv_id,
                role="assistant",
                kind="text",
                content=(ONBOARDING_FIRST_MESSAGE if state["stage"] == "background" and not state["draft"] else
                         "欢迎回来。请继续核对候选画像。" if state["ready"] else
                         QUESTIONS[state["stage"]]),
                status="complete",
            )
            set_onboarding_state(db, student_id, onboarded=False, conversation_id=conv_id)
            db.execute('''INSERT INTO onboarding_sessions(student_id, conversation_id, status)
                VALUES (?, ?, 'in_progress') ON CONFLICT(student_id) DO UPDATE SET
                conversation_id=excluded.conversation_id, status='in_progress', version=version+1''', (student_id, conv_id))
        conv = self.conversation(conv_id, student_id)
        assert conv is not None
        return conv

    def complete_onboarding(self, student_id: str, version: int, entries: dict) -> dict:
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            from app.chat.onboarding import state, FIELDS, LABELS
            current = state(db, student_id)
            if current["status"] == "completed":
                return current
            if current["status"] != "in_progress" or not current["ready"] or current["version"] != version:
                raise ValueError("请完成访谈并核对最新画像后再确认。")
            if set(entries) - set(FIELDS):
                raise ValueError("画像字段无效。")
            from app.memory.curated import split_entries, join_entries
            notes = split_entries(read_all(db, student_id)["user"])
            additions = []
            for key, value in entries.items():
                if not isinstance(value, str) or len(value) > 220:
                    raise ValueError("画像条目过长或格式无效。")
                if value.strip():
                    additions.append(f"{LABELS[key]}：{value.strip()}")
            # The confirmation is explicit authorization; preserve all existing notes.
            replaced_labels = tuple(f"{LABELS[key]}：" for key in entries)
            kept = [entry for entry in notes if not (replaced_labels and entry.startswith(replaced_labels))]
            write_note(db, student_id, "user", join_entries(kept + additions), now())
            db.execute("UPDATE onboarding_sessions SET status='completed', confirmed_entries=?, version=version+1 WHERE student_id=?", (json.dumps(entries, ensure_ascii=False), student_id))
            return state(db, student_id)

    def restart_onboarding(self, student_id: str) -> Conversation:
        with self.connection() as db:
            db.execute("DELETE FROM onboarding_sessions WHERE student_id = ?", (student_id,))
            db.execute(
                "UPDATE agent_state SET onboarded = 0, onboarding_conversation_id = NULL WHERE student_id = ?",
                (student_id,),
            )
        return self.start_onboarding(student_id)

    def skip_onboarding(self, student_id: str) -> dict:
        return self.mark_onboarding(student_id, "skipped")

    def mark_onboarding(self, student_id: str, status: str) -> dict:
        from app.chat.onboarding import state
        if status not in {"completed", "skipped"}:
            raise ValueError("状态无效。")
        with self.connection() as db:
            db.execute("INSERT OR IGNORE INTO onboarding_sessions(student_id) VALUES (?)", (student_id,))
            if status == "skipped":
                db.execute(
                    "UPDATE onboarding_sessions SET status='skipped', version=version+1 WHERE student_id=? AND status != 'completed'",
                    (student_id,),
                )
            else:
                db.execute(
                    "UPDATE onboarding_sessions SET status='completed', version=version+1 WHERE student_id=? AND status != 'completed'",
                    (student_id,),
                )
            return state(db, student_id)

    def learning_checklist(self, student_id: str) -> dict:
        with self.connection() as db:
            tables = {row["name"] for row in db.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
            explained = db.execute(
                "SELECT 1 FROM conversation_messages m JOIN conversations c ON c.id = m.conversation_id "
                "WHERE c.student_id = ? AND m.role = 'assistant' AND m.status = 'complete' "
                "AND length(m.content) >= 80 AND c.title NOT LIKE '初识引导%' LIMIT 1",
                (student_id,),
            ).fetchone()
            answered = db.execute(
                "SELECT 1 FROM conversation_messages m JOIN conversations c ON c.id = m.conversation_id "
                "WHERE c.student_id = ? AND ("
                "m.meta_json LIKE '%\"assessment\": \"correct\"%' OR "
                "(m.meta_json LIKE '%\"from\": \"awaiting_learner\"%' AND m.meta_json LIKE '%\"to\": \"done\"%')"
                ") LIMIT 1",
                (student_id,),
            ).fetchone()
            scheduled = None
            if "agenda_tasks" in tables:
                scheduled = db.execute(
                    "SELECT 1 FROM agenda_tasks WHERE student_id = ? AND source = 'ai_breakdown' LIMIT 1",
                    (student_id,),
                ).fetchone()
        return {
            "explained": explained is not None,
            "answered": answered is not None,
            "scheduled": scheduled is not None,
        }

    def learning_preferences(self, student_id: str) -> dict:
        from app.chat.onboarding import FIELDS, LABELS
        from app.memory.curated import split_entries
        with self.connection() as db:
            notes = split_entries(read_all(db, student_id)["user"])
        found = {key: "" for key in FIELDS}
        for key in FIELDS:
            prefix = f"{LABELS[key]}："
            for entry in notes:
                if entry.startswith(prefix):
                    found[key] = entry[len(prefix):]
        return found

    def save_learning_preferences(self, student_id: str, entries: dict) -> dict:
        from app.chat.onboarding import FIELDS, LABELS
        from app.memory.curated import join_entries, split_entries
        if set(entries) - set(FIELDS):
            raise ValueError("画像字段无效。")
        additions = []
        for key, value in entries.items():
            if not isinstance(value, str) or len(value) > 220:
                raise ValueError("画像条目过长或格式无效。")
            if value.strip():
                additions.append(f"{LABELS[key]}：{value.strip()}")
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            notes = split_entries(read_all(db, student_id)["user"])
            replaced = tuple(f"{LABELS[key]}：" for key in entries)
            kept = [entry for entry in notes if not entry.startswith(replaced)]
            write_note(db, student_id, "user", join_entries(kept + additions), now())
        return self.learning_preferences(student_id)

    def frozen_notes(self, conversation_id: str, student_id: str) -> str:
        with self.connection() as db:
            text = snapshot_text(read_all(db, student_id))
            db.execute("UPDATE conversations SET notes_snapshot = ? WHERE id = ? AND student_id = ?",
                       (text, conversation_id, student_id))
            return text

    def search_messages(self, student_id: str, query: str, limit: int = 5, exclude_conversation_id: str | None = None) -> str:
        with self.connection() as db:
            return search_notes(db, student_id, query, limit, exclude_conversation_id)

    # ------------------------------------------------------------------ custom skills

    def list_custom_skills(self, student_id: str) -> list[dict]:
        with self.connection() as db:
            rows = db.execute(
                "SELECT * FROM custom_skills WHERE student_id = ? ORDER BY created_at DESC",
                (student_id,),
            ).fetchall()
            return [
                {
                    "id": row["id"],
                    "name": row["name"],
                    "role": row["role"],
                    "trigger_keywords": row["trigger_keywords"],
                    "content": row["content"],
                    "enabled": bool(row["enabled"]),
                    "created_at": row["created_at"],
                    "updated_at": row["updated_at"],
                }
                for row in rows
            ]

    def create_custom_skill(
        self, student_id: str, *, name: str, role: str = "thread", trigger_keywords: str = "", content: str,
    ) -> dict:
        clean_name = (name or "").strip()[:60]
        clean_content = (content or "").strip()[:8000]
        clean_triggers = (trigger_keywords or "").strip()[:200]
        if not clean_name or not clean_content:
            raise ValueError("Skill 名称和内容不能为空。")
        if role not in {"thread", "chat", "main"}:
            raise ValueError("Skill 角色只能是 thread、chat 或 main。")
        skill_id = new_id("skill")
        timestamp = now()
        with self.connection() as db:
            db.execute(
                """INSERT INTO custom_skills(id, student_id, name, role, trigger_keywords, content, enabled, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)""",
                (skill_id, student_id, clean_name, role, clean_triggers, clean_content, timestamp, timestamp),
            )
        return next(item for item in self.list_custom_skills(student_id) if item["id"] == skill_id)

    def update_custom_skill(self, student_id: str, skill_id: str, *, enabled: bool | None = None, name: str | None = None,
                            role: str | None = None, trigger_keywords: str | None = None, content: str | None = None) -> dict | None:
        with self.connection() as db:
            row = db.execute(
                "SELECT * FROM custom_skills WHERE id = ? AND student_id = ?", (skill_id, student_id),
            ).fetchone()
            if row is None:
                return None
            next_name = (name.strip()[:60] if name is not None else row["name"]) or row["name"]
            next_role = role if role in {"thread", "chat", "main"} else row["role"]
            next_triggers = trigger_keywords.strip()[:200] if trigger_keywords is not None else row["trigger_keywords"]
            next_content = (content.strip()[:8000] if content is not None else row["content"]) or row["content"]
            next_enabled = int(bool(enabled)) if enabled is not None else row["enabled"]
            db.execute(
                """UPDATE custom_skills
                   SET name = ?, role = ?, trigger_keywords = ?, content = ?, enabled = ?, updated_at = ?
                   WHERE id = ? AND student_id = ?""",
                (next_name, next_role, next_triggers, next_content, next_enabled, now(), skill_id, student_id),
            )
        return next((item for item in self.list_custom_skills(student_id) if item["id"] == skill_id), None)

    def delete_custom_skill(self, student_id: str, skill_id: str) -> bool:
        with self.connection() as db:
            cursor = db.execute("DELETE FROM custom_skills WHERE id = ? AND student_id = ?", (skill_id, student_id))
            return cursor.rowcount == 1

    def memories(self, student_id: str) -> list[LearnerMemory]:
        self.import_legacy()
        with self.connection() as db:
            return self._memories(db, student_id)

    def relevant_memories(
        self, student_id: str, query: str, topic_key: str | None, subject_id: str | None,
    ) -> list[tuple[LearnerMemory, str]]:
        """Layered recall. Returns (memory, scope) with scope "subject", "global" or "other:<Subject name>".

        1. Preferences (general, or this Subject's) always apply.
        2. This Subject's mistakes/mastery, then general ones, by topical match.
        3. Only when 1-2 found fewer than MIN_LOCAL_HITS topical memories: other Subjects, with a stricter
           match (a concept tag or a two-character term must hit) and resolved mistakes excluded.
        """
        wanted = topic_terms(query)
        lowered = normalize(query).lower()
        names = {subject.id: subject.name for subject in self.subjects(student_id)}

        def score(memory: LearnerMemory) -> tuple[int, bool]:
            overlap = wanted & topic_terms(f"{memory.topic} {memory.summary}")
            tag_hits = sum(1 for tag in memory.tags if tag and tag.lower() in lowered)
            same_topic = bool(topic_key and memory.topic_key == topic_key)
            strong = tag_hits > 0 or same_topic or any(len(term) > 1 for term in overlap)
            return 2 * tag_hits + len(overlap) + (3 if same_topic else 0), strong

        preferences, local, outer = [], [], []
        for memory in self.memories(student_id):
            in_scope = memory.subject_id is None or memory.subject_id == subject_id
            if memory.kind == "preference":
                if in_scope and memory.status != "uncertain":
                    preferences.append((memory, "subject" if memory.subject_id else "global"))
                continue
            points, strong = score(memory)
            if in_scope and points >= 1:
                # The learner's own Subject wins ties against general memories.
                local.append((points + (1 if memory.subject_id else 0), memory.updated_at, memory,
                              "subject" if memory.subject_id else "global"))
            elif not in_scope and memory.subject_id in names and points >= 2 and strong and memory.status != "resolved":
                outer.append((points, memory.updated_at, memory, f"other:{names[memory.subject_id]}"))
        local.sort(key=lambda item: (item[0], item[1]), reverse=True)
        chosen = [(memory, scope) for _, _, memory, scope in local[:3]]
        if len(chosen) < MIN_LOCAL_HITS:
            outer.sort(key=lambda item: (item[0], item[1]), reverse=True)
            chosen += [(memory, scope) for _, _, memory, scope in outer[:2]]
        return preferences[:5] + chosen

    def update_memory(
        self, memory_id: str, student_id: str, summary: str | None, status: str | None, subject_id=UNSET,
    ) -> LearnerMemory | None:
        with self.connection() as db:
            row = db.execute(
                "SELECT * FROM learner_memories WHERE id = ? AND student_id = ?", (memory_id, student_id),
            ).fetchone()
            if row is None:
                return None
            if status and status not in STATUSES[row["kind"]]:
                raise ValueError("该类记忆不支持这个状态。")
            if subject_id is not UNSET:
                if subject_id is not None and self._subject(db, subject_id, student_id) is None:
                    raise LookupError("Subject 不存在或已删除。")
                db.execute("UPDATE learner_memories SET subject_id = ? WHERE id = ?", (subject_id, memory_id))
            db.execute(
                "UPDATE learner_memories SET summary = ?, status = ?, user_corrected = 1, updated_at = ? WHERE id = ?",
                (summary or row["summary"], status or row["status"], now(), memory_id),
            )
            return self._memories(db, student_id, memory_id)[0]

    def delete_memory(self, memory_id: str, student_id: str) -> bool:
        with self.connection() as db:
            cursor = db.execute("DELETE FROM learner_memories WHERE id = ? AND student_id = ?", (memory_id, student_id))
            return cursor.rowcount == 1

    def record_observation(
        self, student_id: str, *, kind: str, topic: str, topic_key: str | None, summary: str, quote: str, reason: str,
        signal: str, related_id: str | None, conversation_id: str, message_id: str,
        subject_id: str | None = None, tags: list[str] | None = None,
    ) -> MemoryChange | None:
        """Deterministic status transitions; the model only proposes evidence."""
        changes = self.record_observation_changes(
            student_id, kind=kind, topic=topic, topic_key=topic_key, summary=summary, quote=quote, reason=reason,
            signal=signal, related_id=related_id, conversation_id=conversation_id, message_id=message_id,
            subject_id=subject_id, tags=tags,
        )
        return changes[0] if changes else None

    def record_observation_changes(
        self, student_id: str, *, kind: str, topic: str, topic_key: str | None, summary: str, quote: str, reason: str,
        signal: str, related_id: str | None, conversation_id: str, message_id: str,
        subject_id: str | None = None, tags: list[str] | None = None,
    ) -> list[MemoryChange]:
        """Like record_observation, but a mastery that disproves a misconception yields both changes."""
        fields = dict(topic_key=topic_key, quote=quote, reason=reason, conversation_id=conversation_id,
                      message_id=message_id, subject_id=subject_id, tags=tags)
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            changes = []
            if signal == "contradicts" and related_id and kind != "misconception":
                # Analysis often labels a correct re-derivation as {"kind": "mastery", "effect": "weakens"}
                # pointing at the old misconception; that is counter-evidence for the misconception.
                target = db.execute(
                    "SELECT * FROM learner_memories WHERE id = ? AND student_id = ? AND kind = 'misconception'",
                    (related_id, student_id),
                ).fetchone()
                if target is not None:
                    change = self._record_locked(
                        db, student_id, kind="misconception", topic=target["topic"], summary=target["summary"],
                        signal="contradicts", related_id=related_id, **fields,
                    )
                    changes += [change] if change else []
                    if kind == "mastery":
                        change = self._record_locked(
                            db, student_id, kind="mastery", topic=topic, summary=summary,
                            signal="supports", related_id=None, **fields,
                        )
                        changes += [change] if change else []
                    return changes
            change = self._record_locked(
                db, student_id, kind=kind, topic=topic, summary=summary, signal=signal, related_id=related_id, **fields,
            )
            return [change] if change else []

    def _record_locked(
        self, db, student_id: str, *, kind: str, topic: str, topic_key: str | None, summary: str, quote: str,
        reason: str, signal: str, related_id: str | None, conversation_id: str, message_id: str,
        subject_id: str | None, tags: list[str] | None,
    ) -> MemoryChange | None:
        timestamp = now()
        row = None
        if related_id:
            row = db.execute(
                "SELECT * FROM learner_memories WHERE id = ? AND student_id = ? AND kind = ?",
                (related_id, student_id, kind),
            ).fetchone()
        # Preferences are general; what is learned about a topic belongs to the conversation's Subject.
        scope = None if kind == "preference" else subject_id
        if row is None:
            row = db.execute(
                "SELECT * FROM learner_memories WHERE student_id = ? AND kind = ? AND lower(topic) = lower(?) "
                "AND subject_id IS ?",
                (student_id, kind, topic, scope),
            ).fetchone()
        if row is None and signal != "supports":
            return None  # Nothing to weaken; counter-evidence alone never creates a memory.
        action = "updated" if row else "created"
        memory_id = row["id"] if row else new_id("lmem")
        if row is None:
            db.execute(
                "INSERT INTO learner_memories(id, student_id, kind, topic, topic_key, summary, status, confidence, "
                "origin, subject_id, tags_json, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, 0.5, 'chat', ?, '[]', ?, ?)",
                (memory_id, student_id, kind, topic, topic_key, summary,
                 "suspected" if kind == "misconception" else "observed", scope, timestamp, timestamp),
            )
        if tags:
            known = json.loads(db.execute(
                "SELECT tags_json FROM learner_memories WHERE id = ?", (memory_id,)).fetchone()["tags_json"])
            merged = list(dict.fromkeys(known + tags))[:6]
            db.execute("UPDATE learner_memories SET tags_json = ? WHERE id = ?",
                       (json.dumps(merged, ensure_ascii=False), memory_id))
        inserted = db.execute(
            "INSERT OR IGNORE INTO learner_memory_evidence"
            "(memory_id, conversation_id, message_id, quote, reason, signal, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (memory_id, conversation_id, message_id, quote, reason, signal, timestamp),
        ).rowcount
        if not inserted:
            return None
        signals = [r["signal"] for r in db.execute(
            "SELECT signal FROM learner_memory_evidence WHERE memory_id = ? ORDER BY id", (memory_id,),
        )]
        supports = signals.count("supports")
        if kind == "misconception":
            last_support = max(i for i, s in enumerate(signals) if s == "supports")
            after = len(signals) - 1 - last_support
            status = ("resolved" if after >= 2 else "improving" if after == 1
                      else "needs_review" if supports >= 2 else "suspected")
        else:
            status = "observed" if signals[-1] == "supports" else "uncertain"
        confidence = round(min(0.9, 0.35 + 0.15 * supports) if signals[-1] == "supports"
                           else max(0.2, 0.5 - 0.1 * (len(signals) - supports)), 2)
        db.execute(
            "UPDATE learner_memories SET status = ?, confidence = ?, updated_at = ?, "
            "topic_key = COALESCE(topic_key, ?) WHERE id = ?",
            (status, confidence, timestamp, topic_key, memory_id),
        )
        return MemoryChange(action=action, memory=self._memories(db, student_id, memory_id)[0])

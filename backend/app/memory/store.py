"""SQLite persistence and evidence-based, deterministic memory transitions."""

import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from app.models.schemas import (
    Diagnosis, Evidence, Memory, MemoryChange, Session, SessionMessage, TeachingResponse, TutorOutput, SourceReference,
)


class StateConflict(Exception):
    """The state used by an in-flight generation was changed by another request."""


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def new_id(prefix: str) -> str:
    return f"{prefix}-{uuid4().hex}"


class Store:
    def __init__(self, path: Path):
        self.path = path

    @contextmanager
    def connection(self):
        connection = sqlite3.connect(self.path, timeout=5)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def initialize(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connection() as db:
            db.execute("PRAGMA journal_mode = WAL")
            db.executescript("""
                CREATE TABLE IF NOT EXISTS learning_sessions (
                    id TEXT PRIMARY KEY, student_id TEXT NOT NULL,
                    problem_id TEXT NOT NULL, created_at TEXT NOT NULL,
                    turn INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS messages (
                    id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES learning_sessions(id),
                    role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
                    content TEXT NOT NULL, created_at TEXT NOT NULL,
                    phase TEXT NOT NULL CHECK(phase IN ('initial', 'tutoring')),
                    diagnosis_json TEXT, used_memory_ids_json TEXT NOT NULL DEFAULT '[]'
                );
                CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id);
                CREATE TABLE IF NOT EXISTS message_sources (
                    message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
                    sources_json TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS learning_memories (
                    id TEXT PRIMARY KEY, student_id TEXT NOT NULL,
                    topic_key TEXT NOT NULL, issue_key TEXT NOT NULL,
                    summary TEXT NOT NULL, status TEXT NOT NULL,
                    confidence REAL NOT NULL, updated_at TEXT NOT NULL,
                    UNIQUE(student_id, topic_key, issue_key)
                );
                CREATE TABLE IF NOT EXISTS memory_evidence (
                    memory_id TEXT NOT NULL REFERENCES learning_memories(id) ON DELETE CASCADE,
                    message_id TEXT NOT NULL REFERENCES messages(id),
                    UNIQUE(memory_id, message_id)
                );
            """)

    def _memory(self, db: sqlite3.Connection, row: sqlite3.Row) -> Memory:
        records = db.execute("""
            SELECT m.*, s.problem_id FROM memory_evidence e
            JOIN messages m ON m.id = e.message_id
            JOIN learning_sessions s ON s.id = m.session_id
            WHERE e.memory_id = ? ORDER BY e.rowid
        """, (row["id"],)).fetchall()
        evidence = []
        for record in records:
            diagnosis = json.loads(record["diagnosis_json"])
            evidence.append(Evidence(
                message_id=record["id"], session_id=record["session_id"],
                problem_id=record["problem_id"], quote=diagnosis["evidence"],
                assessment=diagnosis["assessment"], phase=record["phase"],
                created_at=record["created_at"],
            ))
        return Memory(**dict(row), evidence_count=len(evidence), evidence_refs=evidence)

    def memories(self, student_id: str, topic_key: str | None = None) -> list[Memory]:
        with self.connection() as db:
            rows = db.execute("""
                SELECT * FROM learning_memories WHERE student_id = ?
                AND (? IS NULL OR topic_key = ?) ORDER BY updated_at DESC
            """, (student_id, topic_key, topic_key)).fetchall()
            return [self._memory(db, row) for row in rows]

    def delete_memory(self, memory_id: str, student_id: str) -> bool:
        with self.connection() as db:
            cursor = db.execute(
                "DELETE FROM learning_memories WHERE id = ? AND student_id = ?",
                (memory_id, student_id),
            )
            return cursor.rowcount == 1

    def session(self, session_id: str, student_id: str) -> Session | None:
        with self.connection() as db:
            row = db.execute(
                "SELECT * FROM learning_sessions WHERE id = ? AND student_id = ?",
                (session_id, student_id),
            ).fetchone()
            if row is None:
                return None
            messages = db.execute(
                "SELECT m.*, COALESCE(s.sources_json, '[]') AS sources_json FROM messages m "
                "LEFT JOIN message_sources s ON s.message_id = m.id WHERE m.session_id = ? ORDER BY m.rowid", (session_id,)
            ).fetchall()
            return Session(**dict(row), messages=[SessionMessage(
                id=m["id"], role=m["role"], content=m["content"], created_at=m["created_at"],
                diagnosis=Diagnosis.model_validate_json(m["diagnosis_json"]) if m["diagnosis_json"] else None,
                used_memory_ids=json.loads(m["used_memory_ids_json"]),
                sources=[SourceReference.model_validate(source) for source in json.loads(m["sources_json"])],
            ) for m in messages])

    def _update_memory(
        self, db: sqlite3.Connection, student_id: str, topic_key: str,
        user_message_id: str, result: TutorOutput, timestamp: str,
    ) -> list[MemoryChange]:
        issue_key = "lifo_order"
        row = db.execute("""
            SELECT * FROM learning_memories WHERE student_id = ? AND topic_key = ? AND issue_key = ?
        """, (student_id, topic_key, issue_key)).fetchone()
        if result.assessment == "uncertain" or (row is None and result.assessment != "incorrect"):
            return []
        action = "updated" if row else "created"
        memory_id = row["id"] if row else new_id("memory")
        if row is None:
            db.execute("INSERT INTO learning_memories VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                       (memory_id, student_id, topic_key, issue_key, "", "suspected", result.confidence, timestamp))
        db.execute("INSERT INTO memory_evidence(memory_id, message_id) VALUES (?, ?)",
                   (memory_id, user_message_id))
        row = db.execute("SELECT * FROM learning_memories WHERE id = ?", (memory_id,)).fetchone()
        evidence = self._memory(db, row).evidence_refs
        if result.assessment == "incorrect":
            status = "needs_review" if sum(e.assessment == "incorrect" for e in evidence) >= 2 else "suspected"
        else:
            last_error = max(i for i, e in enumerate(evidence) if e.assessment == "incorrect")
            independent = {
                e.problem_id for e in evidence[last_error + 1:]
                if e.assessment == "correct" and e.phase == "initial"
            }
            status = "resolved" if len(independent) >= 2 else "improving"
        summaries = {
            "suspected": "作答中出现可能忽略栈顶约束的证据，仍需进一步核实。",
            "needs_review": "多次作答出现栈顶顺序问题，建议通过逐步模拟巩固 LIFO。",
            "improving": "后续作答表现出改善，尚需在不同题目上独立验证。",
            "resolved": "最近一次错误后，已在至少两道不同题目的首次作答中表现正确。",
        }
        db.execute("""
            UPDATE learning_memories SET summary = ?, status = ?, confidence = ?, updated_at = ? WHERE id = ?
        """, (summaries[status], status, result.confidence, timestamp, memory_id))
        row = db.execute("SELECT * FROM learning_memories WHERE id = ?", (memory_id,)).fetchone()
        return [MemoryChange(action=action, memory=self._memory(db, row))]

    def save_turn(
        self, *, student_id: str, problem_id: str, topic_key: str, answer: str,
        result: TutorOutput, used_memory_ids: list[str], session: Session | None,
        sources: list[SourceReference] | None = None,
    ) -> TeachingResponse:
        session_id = session.id if session else new_id("session")
        timestamp = now()
        phase = "tutoring" if session else "initial"
        sources = sources or []
        diagnosis = Diagnosis(topic_key=topic_key, **result.model_dump(exclude={"reply", "citation_ids"}))
        turn = (session.turn if session else 0) + 1
        with self.connection() as db:
            # Never hold a database lock across a model HTTP request.
            db.execute("BEGIN IMMEDIATE")
            for source in sources:
                if db.execute('SELECT id FROM course_chunks WHERE id = ?', (source.id,)).fetchone() is None:
                    raise StateConflict('生成期间引用资料已删除，请重新提交作答。')
            for memory_id in used_memory_ids:
                if db.execute(
                    "SELECT id FROM learning_memories WHERE id = ? AND student_id = ?", (memory_id, student_id)
                ).fetchone() is None:
                    raise StateConflict("生成期间相关记忆已删除，请重新提交作答。")
            if session:
                cursor = db.execute(
                    "UPDATE learning_sessions SET turn = ? WHERE id = ? AND turn = ? AND student_id = ?",
                    (turn, session_id, session.turn, student_id),
                )
                if cursor.rowcount != 1:
                    raise StateConflict("会话已收到其他回答，请刷新会话后重试。")
            else:
                db.execute("INSERT INTO learning_sessions VALUES (?, ?, ?, ?, ?)",
                           (session_id, student_id, problem_id, timestamp, turn))
            user_id = new_id("message")
            db.execute("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                       (user_id, session_id, "user", answer, timestamp, phase, diagnosis.model_dump_json(), "[]"))
            assistant_id = new_id('message')
            db.execute("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                       (assistant_id, session_id, "assistant", result.reply, now(), phase,
                        None, json.dumps(used_memory_ids)))
            if sources:
                db.execute('INSERT INTO message_sources VALUES (?, ?)',
                           (assistant_id, json.dumps([source.model_dump() for source in sources], ensure_ascii=False)))
            changes = self._update_memory(db, student_id, topic_key, user_id, result, timestamp)
        return TeachingResponse(
            session_id=session_id, turn=turn, diagnosis=diagnosis, reply=result.reply,
            used_memory_ids=used_memory_ids, memory_changes=changes, sources=sources,
        )

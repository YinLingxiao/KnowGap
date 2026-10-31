"""Durable dispatches for a learning space.

Workers never narrate into the main line: a dispatched Thread owns exactly one card
there, and that card's state is read live from the Thread's own messages.
"""

from app.chat.store import ChatStore, normalize
from app.memory.store import new_id, now


def dispatch(store: ChatStore, student: str, main_id: str, source_id: str,
             title: str, task: str, thread_id: str | None, *, task_key: str | None = None,
             skill: str | None = None, content: str | None = None) -> tuple[str, str]:
    # Creation and delivery are atomic. Replaying a coordinator turn cannot deliver twice.
    # `content` overrides the copied source text: a hidden system event must never become the
    # first "learner message" inside the Thread.
    thread_id = thread_id or None
    key = task_key or thread_id or normalize(title).casefold()
    with store.connection() as db:
        db.execute("BEGIN IMMEDIATE")
        main = db.execute("SELECT * FROM conversations WHERE id = ? AND student_id = ?", (main_id, student)).fetchone()
        if main is None or main["kind"] != "main" or not main["subject_id"]:
            raise ValueError("只有学习空间的主线可以分派支线。")
        source = db.execute(
            "SELECT * FROM conversation_messages WHERE id = ? AND conversation_id = ? AND role = 'user'",
            (source_id, main_id),
        ).fetchone()
        if source is None:
            raise ValueError("找不到本轮用户需求。")
        if thread_id:
            target = db.execute(
                "SELECT id FROM conversations WHERE id = ? AND student_id = ? AND parent_id = ? "
                "AND subject_id = ? AND kind = 'thread'", (thread_id, student, main_id, main["subject_id"]),
            ).fetchone()
            if target is None:
                raise ValueError("只能续接本学习空间的支线。")
        previous = db.execute(
            "SELECT thread_id, message_id FROM thread_dispatches WHERE source_message_id = ? AND (task_key = ? OR thread_id = ?)",
            (source_id, key, thread_id),
        ).fetchone()
        if previous:
            return previous["thread_id"], previous["message_id"]
        timestamp = now()
        if thread_id is None:
            thread_id = new_id("conv")
            db.execute(
                "INSERT INTO conversations(id, student_id, title, title_source, subject_id, kind, parent_id, "
                "anchor_message_id, thread_status, created_at, updated_at) VALUES (?, ?, ?, 'auto', ?, 'thread', ?, ?, 'open', ?, ?)",
                (thread_id, student, title, main["subject_id"], main_id, source_id, timestamp, timestamp),
            )
        else:
            db.execute("UPDATE conversations SET thread_status = 'open', resolved_at = NULL WHERE id = ?", (thread_id,))
        meta = {"delegated_task": task, "source_message_id": source_id, "source_conversation_id": main_id}
        if skill:
            meta["delegated_skill"] = skill
        message_id = store._insert(
            db, thread_id, role="user", kind="text", content=source["content"] if content is None else content,
            status="complete", meta=meta,
        )
        db.execute("INSERT INTO thread_dispatches VALUES (?, ?, ?, ?)", (source_id, key, thread_id, message_id))
        return thread_id, message_id


def next_delivery(store: ChatStore, thread_id: str) -> str | None:
    with store.connection() as db:
        row = db.execute(
            "SELECT d.message_id FROM thread_dispatches d JOIN conversation_messages m ON m.id = d.message_id "
            "WHERE d.thread_id = ? AND NOT EXISTS "
            "(SELECT 1 FROM conversation_messages r WHERE r.reply_to = m.id) ORDER BY m.seq LIMIT 1",
            (thread_id,),
        ).fetchone()
        return row["message_id"] if row else None


def cancel_deliveries(store: ChatStore, thread_id: str) -> list[str]:
    with store.connection() as db:
        db.execute("BEGIN IMMEDIATE")
        pending = db.execute(
            "SELECT d.message_id FROM thread_dispatches d WHERE d.thread_id = ? AND NOT EXISTS "
            "(SELECT 1 FROM conversation_messages r WHERE r.reply_to = d.message_id)", (thread_id,),
        ).fetchall()
        for row in pending:
            store._insert(db, thread_id, role="assistant", kind="text", content="任务已停止，尚未执行这条补充。",
                          status="cancelled", reply_to=row["message_id"])
        return [row["message_id"] for row in pending]

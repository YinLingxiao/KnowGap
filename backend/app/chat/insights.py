"""Read-only aggregation of one learning space: who the learner is here, what they get wrong, what they settled.

Contract: docs/contracts/subject-insights.md. The cheat sheet and the concept graph build on this shape,
so it stays deterministic (no model calls, no writes) and only grows by adding fields.

How the data is linked (see store.py):
- memories belong to a space through learner_memories.subject_id (preferences are always global, so they are excluded);
- threads are conversations with kind = 'thread' and the space's subject_id;
- a resolved thread's summary/takeaways live on the summary card that resolve_thread() posts into the space's
  main conversation (conversation_messages.meta_json -> thread_summary, keyed by thread_id).
"""

import json
import sqlite3
from datetime import date

from app.chat.store import ChatStore

SCHEMA_VERSION = 1
# Order in which open misconceptions should be reviewed first.
REVIEW_ORDER = {"needs_review": 0, "suspected": 1, "improving": 2, "resolved": 3}


def _evidence(db: sqlite3.Connection, memory_id: str) -> list[dict]:
    rows = db.execute(
        "SELECT e.*, EXISTS(SELECT 1 FROM conversations c WHERE c.id = e.conversation_id) AS available "
        "FROM learner_memory_evidence e WHERE e.memory_id = ? ORDER BY e.id",
        (memory_id,),
    ).fetchall()
    return [{
        "quote": row["quote"], "reason": row["reason"], "signal": row["signal"],
        "conversation_id": row["conversation_id"], "message_id": row["message_id"],
        "source_available": bool(row["available"]), "created_at": row["created_at"],
    } for row in rows]


def _memory(db: sqlite3.Connection, row: sqlite3.Row) -> dict:
    return {
        "id": row["id"], "kind": row["kind"], "topic": row["topic"], "topic_key": row["topic_key"],
        "summary": row["summary"], "status": row["status"], "confidence": row["confidence"],
        "user_corrected": bool(row["user_corrected"]), "tags": json.loads(row["tags_json"] or "[]"),
        "evidence": _evidence(db, row["id"]), "created_at": row["created_at"], "updated_at": row["updated_at"],
    }


def _summary_cards(db: sqlite3.Connection, main_id: str | None) -> dict[str, dict]:
    """thread_id -> the latest summary card posted into the main conversation."""
    if not main_id:
        return {}
    cards: dict[str, dict] = {}
    rows = db.execute(
        "SELECT meta_json FROM conversation_messages WHERE conversation_id = ? AND meta_json LIKE '%thread_summary%' "
        "ORDER BY seq",
        (main_id,),
    ).fetchall()
    for row in rows:
        card = json.loads(row["meta_json"]).get("thread_summary")
        if isinstance(card, dict) and isinstance(card.get("thread_id"), str):
            cards[card["thread_id"]] = card
    return cards


def _days_left(deadline: str | None, today: date | None) -> int | None:
    if not deadline:
        return None
    try:
        return (date.fromisoformat(deadline[:10]) - (today or date.today())).days
    except ValueError:
        return None


def subject_insights(store: ChatStore, student_id: str, subject_id: str, *, today: date | None = None) -> dict | None:
    """None when the space does not exist or belongs to another student (callers answer 404)."""
    subject = store.subject(subject_id, student_id)
    if subject is None:
        return None
    with store.connection() as db:
        memory_rows = db.execute(
            "SELECT * FROM learner_memories WHERE student_id = ? AND subject_id = ? AND kind != 'preference' "
            "ORDER BY updated_at DESC, id",
            (student_id, subject_id),
        ).fetchall()
        memories = [_memory(db, row) for row in memory_rows]
        cards = _summary_cards(db, subject.main_conversation_id)
        thread_rows = db.execute(
            "SELECT id, title, thread_status, anchor_message_id, created_at, updated_at, resolved_at "
            "FROM conversations WHERE student_id = ? AND subject_id = ? AND kind = 'thread' "
            "ORDER BY CASE WHEN COALESCE(thread_status, 'open') = 'open' THEN 0 ELSE 1 END, updated_at DESC, id",
            (student_id, subject_id),
        ).fetchall()
        material_rows = db.execute(
            "SELECT id, title, kind, chunk_count, created_at FROM course_materials "
            "WHERE student_id = ? AND subject_id = ? ORDER BY created_at, id",
            (student_id, subject_id),
        ).fetchall()

    misconceptions = sorted(
        (m for m in memories if m["kind"] == "misconception" and m["status"] != "resolved"),
        key=lambda m: (REVIEW_ORDER.get(m["status"], 9), m["updated_at"]),
    )
    # Resolved misconceptions count as mastered, matching Subject.progress.mastered.
    mastered = [
        {**m, "source": "mastery" if m["kind"] == "mastery" else "resolved_misconception"}
        for m in memories if m["kind"] == "mastery" or m["status"] == "resolved"
    ]
    threads = []
    for row in thread_rows:
        status = "resolved" if row["thread_status"] == "resolved" else "open"
        card = cards.get(row["id"]) if status == "resolved" else None
        threads.append({
            "id": row["id"], "title": row["title"], "status": status,
            "summary": str(card.get("summary") or "") if card else "",
            "takeaways": [t for t in (card.get("takeaways") or []) if isinstance(t, str)] if card else [],
            "memory_ids": [i for i in (card.get("memory_ids") or []) if isinstance(i, str)] if card else [],
            "anchor_message_id": row["anchor_message_id"],
            "created_at": row["created_at"], "updated_at": row["updated_at"], "resolved_at": row["resolved_at"],
        })
    stats = {
        "misconceptions": len(misconceptions),
        "to_review": sum(m["status"] in {"suspected", "needs_review"} for m in misconceptions),
        "improving": sum(m["status"] == "improving" for m in misconceptions),
        "mastered": len(mastered),
        "evidence": sum(len(m["evidence"]) for m in memories),
        "threads_open": sum(t["status"] == "open" for t in threads),
        "threads_resolved": sum(t["status"] == "resolved" for t in threads),
        "materials": len(material_rows),
        "last_studied_at": subject.progress.last_studied_at,
        "days_to_deadline": _days_left(subject.deadline, today),
    }
    return {
        "schema_version": SCHEMA_VERSION,
        "subject": {
            "id": subject.id, "name": subject.name, "description": subject.description, "goal": subject.goal,
            "level": subject.level, "deadline": subject.deadline, "color": subject.color,
            "main_conversation_id": subject.main_conversation_id,
        },
        "stats": stats,
        "misconceptions": misconceptions,
        "mastered": mastered,
        "threads": threads,
        "materials": [dict(row) for row in material_rows],
    }

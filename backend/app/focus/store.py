from datetime import datetime, timedelta, timezone

from app.memory.store import Store, new_id, now


def local_day(value: str | None) -> str | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return value[:10]
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone().date().isoformat()


class FocusStore:
    def __init__(self, store: Store):
        self.store = store

    def ensure(self) -> None:
        with self.store.connection() as db:
            db.execute(
                """
                CREATE TABLE IF NOT EXISTS focus_sessions (
                    id TEXT PRIMARY KEY,
                    student_id TEXT NOT NULL,
                    task_id TEXT,
                    subject_id TEXT,
                    title TEXT NOT NULL,
                    planned_minutes INTEGER NOT NULL,
                    started_at TEXT NOT NULL,
                    ended_at TEXT,
                    actual_seconds INTEGER,
                    status TEXT CHECK(status IN ('completed', 'abandoned')),
                    note TEXT
                )
                """
            )
            db.execute(
                "CREATE INDEX IF NOT EXISTS idx_focus_student_ended ON focus_sessions(student_id, ended_at)"
            )

    def start(
        self, student_id: str, *, title: str, planned_minutes: int,
        task_id: str | None, subject_id: str | None,
    ) -> dict:
        self.ensure()
        session_id = new_id("focus")
        started = now()
        with self.store.connection() as db:
            db.execute(
                """
                INSERT INTO focus_sessions(
                    id, student_id, task_id, subject_id, title, planned_minutes, started_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (session_id, student_id, task_id, subject_id, title, planned_minutes, started),
            )
            row = db.execute("SELECT * FROM focus_sessions WHERE id = ?", (session_id,)).fetchone()
        return _public(row)

    def finish(
        self, student_id: str, session_id: str, *, status: str, note: str,
        actual_seconds: int | None,
    ) -> dict:
        self.ensure()
        ended = now()
        with self.store.connection() as db:
            row = db.execute(
                "SELECT * FROM focus_sessions WHERE id = ? AND student_id = ?",
                (session_id, student_id),
            ).fetchone()
            if row is None:
                raise LookupError(session_id)
            if row["status"] is not None:
                raise ValueError("这次专注已经结项")
            seconds = actual_seconds
            if seconds is None:
                started = datetime.fromisoformat(row["started_at"])
                stopped = datetime.fromisoformat(ended)
                if started.tzinfo is None:
                    started = started.replace(tzinfo=timezone.utc)
                seconds = max(0, int((stopped - started).total_seconds()))
            db.execute(
                """
                UPDATE focus_sessions
                SET status = ?, note = ?, ended_at = ?, actual_seconds = ?
                WHERE id = ?
                """,
                (status, note, ended, seconds, session_id),
            )
            saved = db.execute("SELECT * FROM focus_sessions WHERE id = ?", (session_id,)).fetchone()
        return _public(saved)

    def heatmap(self, student_id: str, weeks: int) -> dict:
        self.ensure()
        today = datetime.now().astimezone().date()
        start = today - timedelta(days=today.weekday()) - timedelta(weeks=weeks - 1)
        total = weeks * 7
        buckets = {
            (start + timedelta(days=offset)).isoformat(): {"seconds": 0, "misconceptions": 0, "threads": 0}
            for offset in range(total)
        }
        with self.store.connection() as db:
            for row in db.execute(
                """
                SELECT ended_at, actual_seconds FROM focus_sessions
                WHERE student_id = ? AND ended_at IS NOT NULL AND actual_seconds IS NOT NULL
                """,
                (student_id,),
            ):
                day = local_day(row["ended_at"])
                if day in buckets:
                    buckets[day]["seconds"] += int(row["actual_seconds"])
            for row in db.execute(
                """
                SELECT updated_at FROM learner_memories
                WHERE student_id = ? AND kind = 'misconception' AND status IN ('resolved', 'improving')
                """,
                (student_id,),
            ):
                day = local_day(row["updated_at"])
                if day in buckets:
                    buckets[day]["misconceptions"] += 1
            for row in db.execute(
                """
                SELECT resolved_at FROM conversations
                WHERE student_id = ? AND kind = 'thread' AND thread_status = 'resolved'
                  AND resolved_at IS NOT NULL
                """,
                (student_id,),
            ):
                day = local_day(row["resolved_at"])
                if day in buckets:
                    buckets[day]["threads"] += 1
        end = start + timedelta(days=total - 1)
        return {
            "weeks": weeks,
            "start": start.isoformat(),
            "end": end.isoformat(),
            "days": [
                {
                    "date": day,
                    "focus_minutes": round(bucket["seconds"] / 60, 2),
                    "misconceptions_resolved": bucket["misconceptions"],
                    "threads_resolved": bucket["threads"],
                }
                for day, bucket in buckets.items()
            ],
        }


def _public(row) -> dict:
    return {
        "id": row["id"],
        "student_id": row["student_id"],
        "task_id": row["task_id"],
        "subject_id": row["subject_id"],
        "title": row["title"],
        "planned_minutes": row["planned_minutes"],
        "started_at": row["started_at"],
        "ended_at": row["ended_at"],
        "actual_seconds": row["actual_seconds"],
        "status": row["status"],
        "note": row["note"],
    }

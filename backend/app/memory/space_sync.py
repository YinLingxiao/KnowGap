"""学习空间的独立记忆定期汇总进总记忆（USER 笔记）。

每个学习空间的误区与掌握只在本空间召回；为了让通用对话也知道「你在学什么、卡在哪」，
每个空间在 USER 笔记里只占一条简短的 [Activity] 条目，每天（或用户手动）刷新。
摘要按规则从记忆里拼出来，不调用模型，不会编造，也不耗 Token。

只按本空间上次写入的原文找回那一条（不按名称前缀猜），同名空间互不影响；
用户在别处改过那条后，下次同步会另起一条。开了「写入前确认」时由调用方跳过自动同步，
手动点「立即同步」就是确认，所以这里从不排队。
"""

import sqlite3
from datetime import datetime, timedelta

from app.memory.curated import apply as apply_note
from app.memory.curated import read_all, split_entries

SYNC_INTERVAL = timedelta(days=1)
ENTRY_LIMIT = 160
MAX_TOPICS = 3
OK_PREFIX = "已更新"


def ensure(db: sqlite3.Connection) -> None:
    db.execute("""
        CREATE TABLE IF NOT EXISTS space_memory_sync (
            student_id TEXT NOT NULL,
            subject_id TEXT NOT NULL,
            synced_at TEXT NOT NULL,
            entry TEXT NOT NULL DEFAULT '',
            PRIMARY KEY (student_id, subject_id)
        )
    """)


def _plain(text: str) -> str:
    # USER 笔记用「§」分隔条目：正文里的 § 去掉，免得一条被拆成两条。
    return " ".join((text or "").replace("§", "").split())


def entry_prefix(name: str) -> str:
    return f"[Activity] 学习空间「{_plain(name)}」："


def _topics(memories, keep) -> list[str]:
    seen: list[str] = []
    for memory in memories:  # 调用方按 updated_at 倒序传入：最近的在前
        topic = _plain(memory.topic)
        if memory.kind != "preference" and keep(memory) and topic and topic not in seen:
            seen.append(topic)
    return seen[:MAX_TOPICS]


def summary_entry(name: str, goal: str, memories) -> str | None:
    """本空间误区与掌握的一行摘要；空间里还没有可汇总的记忆时返回 None。"""
    weak = _topics(memories, lambda m: m.kind == "misconception" and m.status != "resolved")
    mastered = _topics(memories, lambda m: m.kind == "mastery" or m.status == "resolved")
    if not weak and not mastered:
        return None
    parts = []
    if _plain(goal):
        parts.append("目标：" + _plain(goal)[:40])
    if mastered:
        parts.append("已掌握：" + "、".join(mastered))
    if weak:
        parts.append("待巩固：" + "、".join(weak))
    return (entry_prefix(name) + "；".join(parts))[:ENTRY_LIMIT].strip()


def state(db: sqlite3.Connection, student_id: str, subject_id: str) -> dict | None:
    row = db.execute(
        "SELECT synced_at, entry FROM space_memory_sync WHERE student_id = ? AND subject_id = ?",
        (student_id, subject_id),
    ).fetchone()
    return dict(row) if row else None


def next_sync_at(synced_at: str | None) -> str | None:
    if not synced_at:
        return None
    return (datetime.fromisoformat(synced_at) + SYNC_INTERVAL).isoformat()


def _current_entry(db: sqlite3.Connection, student_id: str, recorded: str | None) -> str | None:
    if not recorded:
        return None
    items = split_entries(read_all(db, student_id).get("user", ""))
    return recorded if recorded in items else None


def sync(
    db: sqlite3.Connection, student_id: str, subject_id: str, name: str, goal: str, memories,
    timestamp: str, *, force: bool = False,
) -> dict:
    """把一个空间的摘要写进 USER 笔记。调用方负责事务（BEGIN IMMEDIATE）。

    返回 {"status": synced|unchanged|not_due|error, "message": str}。
    """
    previous = state(db, student_id, subject_id)
    if not force and previous and datetime.fromisoformat(timestamp) - datetime.fromisoformat(
        previous["synced_at"]) < SYNC_INTERVAL:
        return {"status": "not_due", "message": ""}
    entry = summary_entry(name, goal, memories)
    current = _current_entry(db, student_id, previous["entry"] if previous else None)

    if entry is None and current is None:
        # 还没有可汇总的记忆：不记同步时间，学到第一条时马上就能同步。
        return {"status": "unchanged", "message": ""}
    if entry == current:
        message, status = "", "unchanged"
    elif entry is None:
        message = apply_note(db, student_id, "remove", "user", "", current, timestamp, False)
        status = "synced" if message.startswith(OK_PREFIX) else "error"
    elif current:
        message = apply_note(db, student_id, "patch", "user", entry, current, timestamp, False)
        status = "synced" if message.startswith(OK_PREFIX) else "error"
    else:
        message = apply_note(db, student_id, "add", "user", entry, "", timestamp, False)
        status = "synced" if message.startswith(OK_PREFIX) else "error"

    if status != "error":
        db.execute("""
            INSERT INTO space_memory_sync (student_id, subject_id, synced_at, entry)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(student_id, subject_id) DO UPDATE SET synced_at = excluded.synced_at, entry = excluded.entry
        """, (student_id, subject_id, timestamp, entry or ""))
    return {"status": status, "message": message}


def forget(db: sqlite3.Connection, student_id: str, subject_id: str, timestamp: str) -> None:
    """空间删除时，把它在 USER 笔记里的那条摘要一起去掉（记忆本身转为通用，不丢）。"""
    previous = state(db, student_id, subject_id)
    current = _current_entry(db, student_id, previous["entry"] if previous else None)
    if current:
        apply_note(db, student_id, "remove", "user", "", current, timestamp, False)
    db.execute("DELETE FROM space_memory_sync WHERE student_id = ? AND subject_id = ?", (student_id, subject_id))

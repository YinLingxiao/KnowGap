"""学习空间的 Memory.md：主线整理的、按条目存储的空间学习记录。

- 只有主线写入：支线合并时把小结卡整理进来，主线复盘时补充结论与进度。用户也可以在设置里直接编辑。
- 主线和这个空间的所有支线在每轮开始时读取一份快照。
- 条目以 JSON 数组存储（不用分隔符拼接，正文里出现「§3.2」之类也不会被拆开）；总长有上限；
  写入前做注入与密钥检查；每次写入都留记录，可以单独撤销。
- 与 learner_memories 分层：那边是逐条证据（误区、掌握、状态），这里是给模型和用户读的整理层。
"""

import json
import re
import sqlite3
from uuid import uuid4

from app.memory.curated import scan

LIMIT = 2200
MAX_OPS = 8
SOURCES = {"thread", "main", "user"}
OK_PREFIX = "已更新"
_BULLET = re.compile(r"^\s*(?:[-*•]\s+|\d+[.)、]\s+)")


def ensure(db: sqlite3.Connection) -> None:
    db.execute("""
        CREATE TABLE IF NOT EXISTS space_memory_notes (
            student_id TEXT NOT NULL,
            subject_id TEXT NOT NULL,
            entries_json TEXT NOT NULL DEFAULT '[]',
            updated_at TEXT NOT NULL,
            PRIMARY KEY (student_id, subject_id)
        )
    """)
    cols = {row[1] for row in db.execute("PRAGMA table_info(space_memory_notes)").fetchall()}
    if "entries_json" not in cols:
        # 早期版本把条目用「§」拼成一段文本存在 content 列：迁移成 JSON 数组。
        db.execute("ALTER TABLE space_memory_notes ADD COLUMN entries_json TEXT NOT NULL DEFAULT '[]'")
        if "content" in cols:
            for row in db.execute("SELECT student_id, subject_id, content FROM space_memory_notes").fetchall():
                items = [part.strip() for part in re.split(r"\n§\n", row[2] or "") if part.strip()]
                db.execute(
                    "UPDATE space_memory_notes SET entries_json = ? WHERE student_id = ? AND subject_id = ?",
                    (json.dumps(items, ensure_ascii=False), row[0], row[1]),
                )
    db.execute("""
        CREATE TABLE IF NOT EXISTS space_memory_log (
            id TEXT PRIMARY KEY,
            student_id TEXT NOT NULL,
            subject_id TEXT NOT NULL,
            action TEXT NOT NULL CHECK(action IN ('add', 'patch', 'remove', 'replace')),
            content TEXT NOT NULL DEFAULT '',
            old_text TEXT NOT NULL DEFAULT '',
            source TEXT NOT NULL CHECK(source IN ('thread', 'main', 'user')),
            source_id TEXT,
            created_at TEXT NOT NULL,
            revoked_at TEXT
        )
    """)
    db.execute("CREATE INDEX IF NOT EXISTS idx_space_memory_log_subject "
               "ON space_memory_log(student_id, subject_id, created_at)")
    # 已整理进 Memory.md 的支线小结卡：重复合并、服务重启后重试都不会再整理一遍。
    db.execute("""
        CREATE TABLE IF NOT EXISTS space_memory_merges (
            message_id TEXT PRIMARY KEY,
            student_id TEXT NOT NULL,
            subject_id TEXT NOT NULL,
            merged_at TEXT NOT NULL
        )
    """)


def _clean(text) -> str:
    return " ".join(text.split()) if isinstance(text, str) else ""


def size(entries: list[str]) -> int:
    """Memory.md 的字数：按每条一行算。"""
    return len("\n".join(entries))


def read_entries(db: sqlite3.Connection, student_id: str, subject_id: str) -> tuple[list[str], str | None]:
    row = db.execute(
        "SELECT entries_json, updated_at FROM space_memory_notes WHERE student_id = ? AND subject_id = ?",
        (student_id, subject_id),
    ).fetchone()
    if row is None:
        return [], None
    try:
        items = json.loads(row["entries_json"])
    except ValueError:
        items = []
    return [item for item in items if isinstance(item, str) and item], row["updated_at"]


def _store(db: sqlite3.Connection, student_id: str, subject_id: str, entries: list[str], timestamp: str) -> None:
    db.execute("""
        INSERT INTO space_memory_notes (student_id, subject_id, entries_json, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(student_id, subject_id) DO UPDATE SET
            entries_json = excluded.entries_json, updated_at = excluded.updated_at
    """, (student_id, subject_id, json.dumps(entries, ensure_ascii=False), timestamp))


def _log(db, student_id, subject_id, action, content, old_text, source, source_id, timestamp) -> str:
    log_id = f"smem-{uuid4().hex}"
    db.execute(
        "INSERT INTO space_memory_log (id, student_id, subject_id, action, content, old_text, source, source_id, "
        "created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (log_id, student_id, subject_id, action, content, old_text, source, source_id, timestamp),
    )
    return log_id


def apply(
    db: sqlite3.Connection, student_id: str, subject_id: str, action: str, content, old_text,
    timestamp: str, *, source: str, source_id: str | None = None,
) -> str:
    """对一条条目做 add / patch / remove。成功时返回以「已更新」开头的说明，否则返回原因。"""
    if source not in SOURCES:
        return "source 只能是 thread、main 或 user。"
    if action not in {"add", "patch", "remove"}:
        return "action 只能是 add、patch 或 remove。"
    piece = _clean(content)
    previous = _clean(old_text)
    if action != "remove":
        blocked = scan(piece)
        if blocked:
            return blocked
    items = read_entries(db, student_id, subject_id)[0]
    if action == "add":
        if not piece:
            return "content 不能为空。"
        if piece in items:
            return "已存在。"
        items.append(piece)
    else:
        if not previous:
            return f"{action} 需要 old_text。"
        hits = [index for index, item in enumerate(items) if item == previous]
        if len(hits) != 1:
            return "没有找到这条记录。" if not hits else f"old_text 匹配了 {len(hits)} 条，需要唯一匹配。"
        if action == "patch":
            if not piece:
                return "content 不能为空。"
            if piece == previous:
                return "没有变化。"
            if piece in items:
                return "已存在。"
            items[hits[0]] = piece
        else:
            del items[hits[0]]
    if size(items) > LIMIT:
        return f"写入后有 {size(items)} 字，上限 {LIMIT}。先删或合并旧条目再写。"
    _store(db, student_id, subject_id, items, timestamp)
    _log(db, student_id, subject_id, action, piece if action != "remove" else "", previous, source, source_id, timestamp)
    return f"{OK_PREFIX}（{size(items)}/{LIMIT} 字）。"


def parse_text(text: str) -> list[str]:
    """用户整体编辑的文本：每行一条；只去掉行首的列表符号（「- 」「• 」「1. 」），不动正文里的符号。"""
    items: list[str] = []
    for line in text.replace("\r\n", "\n").split("\n"):
        item = _clean(_BULLET.sub("", line, count=1))
        if item and item not in items:
            items.append(item)
    return items


def replace(db: sqlite3.Connection, student_id: str, subject_id: str, text: str, timestamp: str) -> str:
    """用户在设置里整体编辑 Memory.md。"""
    items = parse_text(text)
    for item in items:
        blocked = scan(item)
        if blocked:
            return blocked
    if size(items) > LIMIT:
        return f"一共 {size(items)} 字，上限 {LIMIT}。"
    before = read_entries(db, student_id, subject_id)[0]
    if items == before:
        return f"{OK_PREFIX}（没有变化）。"
    _store(db, student_id, subject_id, items, timestamp)
    _log(db, student_id, subject_id, "replace", json.dumps(items, ensure_ascii=False),
         json.dumps(before, ensure_ascii=False), "user", None, timestamp)
    return f"{OK_PREFIX}（{size(items)}/{LIMIT} 字）。"


def entries_from(db: sqlite3.Connection, student_id: str, subject_id: str, source_id: str) -> list[str]:
    """这个来源（例如某条支线）写进来、现在仍在 Memory.md 里的条目。支线重新合并时据此改旧条目。"""
    items = set(read_entries(db, student_id, subject_id)[0])
    rows = db.execute(
        "SELECT content FROM space_memory_log WHERE student_id = ? AND subject_id = ? AND source_id = ? "
        "AND action IN ('add', 'patch') AND revoked_at IS NULL ORDER BY created_at, rowid",
        (student_id, subject_id, source_id),
    ).fetchall()
    return list(dict.fromkeys(row["content"] for row in rows if row["content"] in items))


def history(db: sqlite3.Connection, student_id: str, subject_id: str, limit: int = 30) -> list[dict]:
    rows = db.execute(
        "SELECT * FROM space_memory_log WHERE student_id = ? AND subject_id = ? "
        "ORDER BY created_at DESC, rowid DESC LIMIT ?",
        (student_id, subject_id, limit),
    ).fetchall()
    result = []
    for row in rows:
        item = dict(row)
        if item["action"] == "replace":
            item["content"] = "\n".join(_json_list(item["content"]))
            item["old_text"] = "\n".join(_json_list(item["old_text"]))
        result.append(item)
    return result


def _json_list(text: str) -> list[str]:
    try:
        value = json.loads(text or "[]")
    except ValueError:
        return []
    return [item for item in value if isinstance(item, str)] if isinstance(value, list) else []


def revoke(db: sqlite3.Connection, student_id: str, subject_id: str, log_id: str, timestamp: str) -> str | None:
    """撤销一次写入：新增的删掉，修改的改回去，删除的加回来，整体编辑的恢复原文。

    没有这次写入时返回 None；其他情况返回说明（成功以「已更新」开头）。
    """
    row = db.execute(
        "SELECT * FROM space_memory_log WHERE id = ? AND student_id = ? AND subject_id = ?",
        (log_id, student_id, subject_id),
    ).fetchone()
    if row is None:
        return None
    if row["revoked_at"]:
        return "已经撤销过了。"
    items = read_entries(db, student_id, subject_id)[0]
    action, content, old = row["action"], row["content"], row["old_text"]
    if action == "replace":
        if items != _json_list(content):
            return "之后又改过，不能直接恢复整体编辑前的内容。"
        items = _json_list(old)
    elif action == "add":
        if content not in items:
            return "这条已经不在了。"
        items.remove(content)
    elif action == "patch":
        if content not in items:
            return "这条之后又改过，不能撤销。"
        if old in items:  # 原条目已经被别处加回来了：只去掉这次改出的新条目
            items.remove(content)
        else:
            items[items.index(content)] = old
    else:  # remove
        if old in items:
            return "这条已经在了。"
        items.append(old)
    if size(items) > LIMIT:
        return f"撤销后会超过 {LIMIT} 字上限。"
    _store(db, student_id, subject_id, items, timestamp)
    db.execute("UPDATE space_memory_log SET revoked_at = ? WHERE id = ?", (timestamp, log_id))
    return f"{OK_PREFIX}。"


def already_merged(db: sqlite3.Connection, message_id: str) -> bool:
    return db.execute("SELECT 1 FROM space_memory_merges WHERE message_id = ?", (message_id,)).fetchone() is not None


def mark_merged(db: sqlite3.Connection, student_id: str, subject_id: str, message_id: str, timestamp: str) -> None:
    db.execute(
        "INSERT OR IGNORE INTO space_memory_merges (message_id, student_id, subject_id, merged_at) VALUES (?, ?, ?, ?)",
        (message_id, student_id, subject_id, timestamp),
    )


def drop(db: sqlite3.Connection, student_id: str, subject_id: str) -> None:
    db.execute("DELETE FROM space_memory_notes WHERE student_id = ? AND subject_id = ?", (student_id, subject_id))
    db.execute("DELETE FROM space_memory_log WHERE student_id = ? AND subject_id = ?", (student_id, subject_id))
    db.execute("DELETE FROM space_memory_merges WHERE student_id = ? AND subject_id = ?", (student_id, subject_id))


def snapshot_section(entries: list[str]) -> str:
    body = "\n".join(f"- {item}" for item in entries) or "（空）"
    return (
        "本空间 Memory.md（主线自动整理的学习记录，只读，本轮开始时的快照；不要用记忆工具写它）：\n" + body
    )

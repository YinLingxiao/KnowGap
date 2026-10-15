"""Two capped, entry-based notes the agent maintains itself."""

import re
import sqlite3
from uuid import uuid4

SEP = "\n§\n"
LIMITS = {"user": 1375, "memory": 2200}
INJECTION = re.compile(r"忽略以上|ignore previous|ignore all|system prompt|你现在是|<\s*/?\s*system", re.I)
SECRET = re.compile(r"sk-[A-Za-z0-9]|Bearer\s+\S|api[_-]?key\s*[:=]", re.I)
LONG_TOKEN = re.compile(r"[A-Za-z0-9+/]{40,}={0,2}")


def ensure(db: sqlite3.Connection) -> None:
    db.execute("""
        CREATE TABLE IF NOT EXISTS agent_memory (
            student_id TEXT NOT NULL,
            target TEXT NOT NULL CHECK(target IN ('memory', 'user')),
            content TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL,
            PRIMARY KEY (student_id, target)
        )
    """)
    db.execute("""
        CREATE TABLE IF NOT EXISTS agent_memory_pending (
            id TEXT PRIMARY KEY, student_id TEXT NOT NULL,
            action TEXT NOT NULL, target TEXT NOT NULL,
            content TEXT NOT NULL DEFAULT '', old_text TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL
        )
    """)
    db.execute("""
        CREATE TABLE IF NOT EXISTS agent_state (
            student_id TEXT PRIMARY KEY, turns_since_note INTEGER NOT NULL DEFAULT 0
        )
    """)
    db.execute("""
        CREATE TABLE IF NOT EXISTS conversation_note_state (
            student_id TEXT NOT NULL, conversation_id TEXT NOT NULL
                REFERENCES conversations(id) ON DELETE CASCADE,
            turns_since_note INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (student_id, conversation_id)
        )
    """)


def split_entries(content: str) -> list[str]:
    if not content or not content.strip():
        return []
    return [part.strip() for part in re.split(r"\s*§\s*", content) if part.strip()]


def join_entries(items: list[str]) -> str:
    return SEP.join(items)


def scan(text: str) -> str | None:
    if INJECTION.search(text or ""):
        return "内容像是在注入指令，已拒绝。"
    if SECRET.search(text or "") or LONG_TOKEN.search(text or ""):
        return "内容像是密钥，已拒绝。"
    return None


def snapshot_text(notes: dict[str, str]) -> str:
    user = notes.get("user") or "（空）"
    memory = notes.get("memory") or "（空）"
    return f"USER（本轮开始时的快照）：\n{user}\n\nMEMORY（本轮开始时的快照）：\n{memory}"


def read_all(db: sqlite3.Connection, student_id: str) -> dict[str, str]:
    rows = db.execute(
        "SELECT target, content FROM agent_memory WHERE student_id = ?", (student_id,),
    ).fetchall()
    found = {row["target"]: row["content"] for row in rows}
    return {"user": found.get("user", ""), "memory": found.get("memory", "")}


def _store(db: sqlite3.Connection, student_id: str, target: str, content: str, timestamp: str) -> None:
    db.execute("""
        INSERT INTO agent_memory(student_id, target, content, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(student_id, target) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at
    """, (student_id, target, content, timestamp))


def write(db: sqlite3.Connection, student_id: str, target: str, content: str, timestamp: str) -> None:
    if target not in LIMITS:
        raise ValueError("target 只能是 user 或 memory。")
    items: list[str] = []
    for item in split_entries(content):
        blocked = scan(item)
        if blocked:
            raise ValueError(blocked)
        if item not in items:
            items.append(item)
    updated = join_entries(items)
    if len(updated) > LIMITS[target]:
        raise ValueError(f"超过 {LIMITS[target]} 字，请先删减。")
    _store(db, student_id, target, updated, timestamp)


def _queue(db: sqlite3.Connection, student_id: str, action: str, target: str, content: str, old_text: str, timestamp: str) -> str:
    db.execute(
        "INSERT INTO agent_memory_pending VALUES (?, ?, ?, ?, ?, ?, ?)",
        (f"pending-{uuid4().hex}", student_id, action, target, content, old_text, timestamp),
    )
    return "已提交待确认。"


def apply(db: sqlite3.Connection, student_id: str, action: str, target: str, content, old_text, timestamp: str, approve: bool = False) -> str:
    if target not in LIMITS:
        return "target 只能是 user 或 memory。"
    if action not in {"add", "patch", "remove"}:
        return "action 只能是 add、patch 或 remove。"
    piece = content.strip() if isinstance(content, str) else ""
    previous = old_text.strip() if isinstance(old_text, str) else ""
    if action != "remove":
        blocked = scan(piece)
        if blocked:
            return blocked
    items = split_entries(read_all(db, student_id)[target])
    if action == "add":
        if not piece:
            return "content 不能为空。"
        if piece in items:
            return "已存在。"
        items.append(piece)
        queued = (piece, "")
    else:
        if not previous:
            return f"{action} 需要 old_text。"
        hits = [index for index, item in enumerate(items) if item == previous]
        if len(hits) != 1:
            return "没有找到这条笔记。" if not hits else f"old_text 匹配了 {len(hits)} 条，需要唯一匹配。"
        if action == "patch":
            if not piece:
                return "content 不能为空。"
            if piece in items and items[hits[0]] != piece:
                return "已存在。"
            items[hits[0]] = piece
            queued = (piece, previous)
        else:
            del items[hits[0]]
            queued = ("", previous)
    updated = join_entries(items)
    limit = LIMITS[target]
    if len(updated) > limit:
        return f"写入后有 {len(updated)} 字，上限 {limit}。请在这一轮里先 remove 再写，不会自动压缩。"
    if approve:
        return _queue(db, student_id, action, target, queued[0], queued[1], timestamp)
    _store(db, student_id, target, updated, timestamp)
    label = "用户" if target == "user" else "笔记"
    return f"已更新{label}（{len(updated)}/{limit} 字）。写入在下一轮对话里生效。"


def pending(db: sqlite3.Connection, student_id: str) -> list[dict]:
    rows = db.execute(
        "SELECT * FROM agent_memory_pending WHERE student_id = ? ORDER BY created_at", (student_id,),
    ).fetchall()
    return [dict(row) for row in rows]


def decide(db: sqlite3.Connection, student_id: str, pending_id: str, allow: bool, timestamp: str) -> str | None:
    row = db.execute(
        "SELECT * FROM agent_memory_pending WHERE id = ? AND student_id = ?", (pending_id, student_id),
    ).fetchone()
    if row is None:
        return None
    db.execute("DELETE FROM agent_memory_pending WHERE id = ?", (pending_id,))
    if not allow:
        return "已拒绝。"
    return apply(db, student_id, row["action"], row["target"], row["content"], row["old_text"], timestamp, False)


def bump_turns(db: sqlite3.Connection, student_id: str, reset: bool, conversation_id: str) -> int:
    if reset:
        db.execute("""
            INSERT INTO conversation_note_state VALUES (?, ?, 0)
            ON CONFLICT(student_id, conversation_id) DO UPDATE SET turns_since_note = 0
        """, (student_id, conversation_id))
        return 0
    db.execute("""
        INSERT INTO conversation_note_state VALUES (?, ?, 1)
        ON CONFLICT(student_id, conversation_id) DO UPDATE SET turns_since_note = turns_since_note + 1
    """, (student_id, conversation_id))
    return db.execute("SELECT turns_since_note FROM conversation_note_state WHERE student_id = ? AND conversation_id = ?",
                      (student_id, conversation_id)).fetchone()[0]


def ensure_fts(db: sqlite3.Connection) -> None:
    tokenize = "trigram"
    try:
        db.execute(f"CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(body, message_id UNINDEXED, tokenize = '{tokenize}')")
    except sqlite3.OperationalError:
        db.execute("CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(body, message_id UNINDEXED)")
    db.executescript("""
        CREATE TRIGGER IF NOT EXISTS message_fts_ai AFTER INSERT ON conversation_messages BEGIN
            INSERT INTO message_fts(body, message_id) VALUES (new.content, new.id);
        END;
        CREATE TRIGGER IF NOT EXISTS message_fts_ad AFTER DELETE ON conversation_messages BEGIN
            DELETE FROM message_fts WHERE message_id = old.id;
        END;
        CREATE TRIGGER IF NOT EXISTS message_fts_au AFTER UPDATE OF content ON conversation_messages BEGIN
            DELETE FROM message_fts WHERE message_id = old.id;
            INSERT INTO message_fts(body, message_id) VALUES (new.content, new.id);
        END;
    """)
    indexed = db.execute("SELECT COUNT(*) AS n FROM message_fts").fetchone()["n"]
    if indexed == 0:
        db.execute("INSERT INTO message_fts(body, message_id) SELECT content, id FROM conversation_messages")


def search(db: sqlite3.Connection, student_id: str, query: str, limit: int, exclude_conversation_id: str | None = None) -> str:
    match = fts_query(query)
    if not match:
        return "查询太短。"
    limit = 5 if not isinstance(limit, int) or limit < 1 else min(limit, 8)
    exclude = exclude_conversation_id or ""
    try:
        rows = db.execute("""
            SELECT m.content AS content, m.role AS role, m.created_at AS created_at, c.title AS title
            FROM message_fts
            JOIN conversation_messages m ON m.id = message_fts.message_id
            JOIN conversations c ON c.id = m.conversation_id
            WHERE message_fts MATCH ? AND c.student_id = ? AND m.status = 'complete'
              AND (? = '' OR c.id != ?)
            LIMIT ?
        """, (match, student_id, exclude, exclude, limit)).fetchall()
    except sqlite3.OperationalError:
        return "搜索语句无效。"
    if not rows:
        return "没有找到相关对话。"
    lines = []
    for row in rows:
        body = (row["content"] or "").strip().replace("\n", " ")
        if len(body) > 600:
            body = body[:600] + "…"
        lines.append(f"- [{(row['created_at'] or '')[:10]}] {row['title']} / {row['role']}: {body}")
    return "\n".join(lines)


def fts_query(text: str) -> str:
    cleaned = re.sub(r'["\']', " ", text or "").strip()
    if len(cleaned) < 2:
        return ""
    return f'"{cleaned[:80]}"'

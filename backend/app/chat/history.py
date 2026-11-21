"""对话历史：让模型知道用户最近还聊过哪些对话，并能按 id 打开读原文。

关键词搜索（curated.search）找不到「上个对话」「4 小时前那段」这种按时间指代的对话，
这里按最后活动时间列出最近的对话，再提供按 conversation_id 读原文。
"""
import re
import sqlite3
from datetime import datetime, timezone

TURN_LIMIT = 5          # 每轮自动带给模型的条数
MAX_LIST = 10           # 工具一次最多列出的条数
OPEN_BUDGET = 6000      # 打开一段对话时原文的总字数上限
MESSAGE_CHARS = 800     # 单条消息截断长度
SNIPPET_CHARS = 80

_FENCE = re.compile(r"```[\s\S]*?(```|$)")

# 只算用户真正发过消息的对话；支线归属学习空间主线，不单独列出
_VISIBLE = ("m.status = 'complete' AND m.kind = 'text' "
            "AND json_extract(m.meta_json, '$.system_event') IS NULL")


def relative_time(stamp: str | None, now: datetime | None = None) -> str:
    """把 ISO 时间写成「刚刚 / 5 分钟前 / 4 小时前 / 昨天 / 3 天前 / 2026-11-02」。"""
    if not stamp:
        return ""
    try:
        moment = datetime.fromisoformat(stamp)
    except ValueError:
        return stamp[:10]
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    now = now or datetime.now(timezone.utc)
    seconds = max(0.0, (now - moment).total_seconds())
    if seconds < 60:
        return "刚刚"
    if seconds < 3600:
        return f"{int(seconds // 60)} 分钟前"
    if seconds < 86400:
        return f"{int(seconds // 3600)} 小时前"
    days = (now.astimezone().date() - moment.astimezone().date()).days
    if days <= 1:
        return "昨天"
    if days < 7:
        return f"{days} 天前"
    return moment.astimezone().strftime("%Y-%m-%d")


def plain(text: str, limit: int) -> str:
    """卡片和代码块换成占位，压成一行再截断。"""
    body = _FENCE.sub(" [卡片或代码] ", text or "")
    body = " ".join(body.split())
    return body if len(body) <= limit else body[:limit] + "…"


def recent(db: sqlite3.Connection, student_id: str, exclude_id: str | None = None, limit: int = TURN_LIMIT,
           *, detail: bool = False, now: datetime | None = None) -> list[dict]:
    """最近有用户消息的对话，按最后一条消息的时间倒序；不含 exclude_id 和支线。"""
    limit = max(1, min(int(limit), MAX_LIST))
    rows = db.execute(f"""
        SELECT c.id, c.title, s.name AS space,
               (SELECT MAX(m.created_at) FROM conversation_messages m WHERE m.conversation_id = c.id AND {_VISIBLE}) AS last_at
        FROM conversations c
        LEFT JOIN subjects s ON s.id = c.subject_id AND s.student_id = c.student_id
        WHERE c.student_id = ? AND c.id != ? AND COALESCE(c.kind, 'chat') != 'thread'
          AND EXISTS (SELECT 1 FROM conversation_messages m
                      WHERE m.conversation_id = c.id AND m.role = 'user' AND {_VISIBLE})
        ORDER BY last_at DESC, c.created_at DESC
        LIMIT ?
    """, (student_id, exclude_id or "", limit)).fetchall()
    items = []
    for row in rows:
        item = {"conversation_id": row["id"], "title": row["title"], "when": relative_time(row["last_at"], now)}
        if row["space"]:
            item["space"] = row["space"]
        if detail:
            first = db.execute(f"""SELECT content FROM conversation_messages m WHERE m.conversation_id = ?
                                  AND m.role = 'user' AND {_VISIBLE} ORDER BY m.seq LIMIT 1""", (row["id"],)).fetchone()
            last = db.execute(f"""SELECT content FROM conversation_messages m WHERE m.conversation_id = ?
                                 AND m.role = 'assistant' AND {_VISIBLE} ORDER BY m.seq DESC LIMIT 1""", (row["id"],)).fetchone()
            item["first_question"] = plain(first["content"], SNIPPET_CHARS) if first else ""
            item["last_answer"] = plain(last["content"], SNIPPET_CHARS * 2) if last else ""
        items.append(item)
    return items


def recent_text(items: list[dict]) -> str:
    if not items:
        return "没有别的对话。"
    lines = ["最近的对话（新的在前，不含当前对话）："]
    for index, item in enumerate(items, 1):
        space = f" · 学习空间「{item['space']}」" if item.get("space") else ""
        lines.append(f"{index}. 「{item['title']}」 · {item['when']}{space} · conversation_id: {item['conversation_id']}")
        if item.get("first_question"):
            lines.append(f"   首问：{item['first_question']}")
        if item.get("last_answer"):
            lines.append(f"   最后的回答：{item['last_answer']}")
    lines.append("要看某段的原文，用 session_search 传它的 conversation_id。")
    return "\n".join(lines)


def open_text(db: sqlite3.Connection, student_id: str, conversation_id: str, *, now: datetime | None = None) -> str:
    """一段对话的原文。太长时保留开头两条和结尾若干条，中间注明省略了几条。"""
    conversation = db.execute(
        "SELECT c.title, s.name AS space FROM conversations c "
        "LEFT JOIN subjects s ON s.id = c.subject_id AND s.student_id = c.student_id "
        "WHERE c.id = ? AND c.student_id = ?", (conversation_id, student_id)).fetchone()
    if conversation is None:
        return "找不到这段对话，可能已经删除。"
    rows = db.execute(f"""SELECT role, content, created_at FROM conversation_messages m
                          WHERE m.conversation_id = ? AND {_VISIBLE} ORDER BY m.seq""", (conversation_id,)).fetchall()
    if not rows:
        return f"「{conversation['title']}」里还没有消息。"
    speaker = {"user": "用户", "assistant": "助手"}
    lines = [f"{speaker[row['role']]}：{plain(row['content'], MESSAGE_CHARS)}" for row in rows]
    if sum(len(line) for line in lines) > OPEN_BUDGET:
        head = lines[:2]
        budget = OPEN_BUDGET - sum(len(line) for line in head)
        tail: list[str] = []
        for line in reversed(lines[2:]):
            if budget - len(line) < 0:
                break
            tail.insert(0, line)
            budget -= len(line)
        omitted = len(lines) - len(head) - len(tail)
        lines = head + ([f"……（中间省略 {omitted} 条）……"] if omitted else []) + tail
    space = f" · 学习空间「{conversation['space']}」" if conversation["space"] else ""
    header = (f"「{conversation['title']}」{space} · 最后一条在 {relative_time(rows[-1]['created_at'], now)}"
              f" · 共 {len(rows)} 条消息")
    return header + "\n" + "\n".join(lines)

"""讲解 / 互动偏好先问一句，记住才写入 USER。同一条拒绝后不再问。"""
import json

from app.memory.curated import apply as apply_note
from app.memory.store import new_id, now


def ensure(db):
    db.execute('''CREATE TABLE IF NOT EXISTS preference_prompts (
        id TEXT PRIMARY KEY, student_id TEXT NOT NULL, message_id TEXT NOT NULL,
        content TEXT NOT NULL, prompt TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending')''')
    db.execute('''CREATE TABLE IF NOT EXISTS preference_dismissals (
        student_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
        PRIMARY KEY (student_id, fingerprint))''')


def fingerprint(content: str) -> str:
    return " ".join(content.split())


def prompt_text(content: str) -> str:
    sentence = f"看起来你{fingerprint(content)}，要记住吗？"
    return sentence if len(sentence) <= 20 else "要记住这个偏好吗？"


def _blocked(db, student_id: str, content: str, existing: list[str]) -> bool:
    current = fingerprint(content)
    if not current:
        return True
    if any(current in old or old in current for old in existing if old):
        return True
    rows = db.execute("SELECT fingerprint FROM preference_dismissals WHERE student_id = ?", (student_id,)).fetchall()
    return any(current in row[0] or row[0] in current for row in rows if row[0])


def queue(db, student_id: str, message_id: str, content: str, existing: list[str]) -> dict | None:
    ensure(db)
    cleaned = fingerprint(content)
    if _blocked(db, student_id, cleaned, existing):
        return None
    pending = db.execute(
        "SELECT id, prompt, content FROM preference_prompts WHERE student_id = ? AND status = 'pending' AND content = ?",
        (student_id, cleaned),
    ).fetchone()
    if pending:
        return {"id": pending["id"], "text": pending["prompt"], "content": pending["content"]}
    prompt_id = new_id("pref")
    text = prompt_text(cleaned)
    db.execute(
        "INSERT INTO preference_prompts(id, student_id, message_id, content, prompt, status) VALUES (?, ?, ?, ?, ?, 'pending')",
        (prompt_id, student_id, message_id, cleaned, text),
    )
    return {"id": prompt_id, "text": text, "content": cleaned}


def decide(db, student_id: str, prompt_id: str, allow: bool) -> str | None:
    ensure(db)
    row = db.execute(
        "SELECT * FROM preference_prompts WHERE id = ? AND student_id = ?", (prompt_id, student_id),
    ).fetchone()
    if row is None or row["status"] != "pending":
        return None
    status = "accepted" if allow else "declined"
    if allow:
        result = apply_note(db, student_id, "add", "user", f"[Preference] {row['content']}", "", now(), False)
        if not (result.startswith("已更新") or result.startswith("已存在")):
            raise ValueError(result)
    else:
        db.execute(
            "INSERT OR IGNORE INTO preference_dismissals(student_id, fingerprint) VALUES (?, ?)",
            (student_id, row["content"]),
        )
    db.execute("UPDATE preference_prompts SET status = ? WHERE id = ?", (status, prompt_id))
    message = db.execute("SELECT meta_json FROM conversation_messages WHERE id = ?", (row["message_id"],)).fetchone()
    if message:
        meta = json.loads(message["meta_json"])
        prompt = meta.get("preference_prompt")
        if isinstance(prompt, dict) and prompt.get("id") == prompt_id:
            prompt["status"] = status
            meta["preference_prompt"] = prompt
            db.execute("UPDATE conversation_messages SET meta_json = ? WHERE id = ?",
                       (json.dumps(meta, ensure_ascii=False), row["message_id"]))
    return status

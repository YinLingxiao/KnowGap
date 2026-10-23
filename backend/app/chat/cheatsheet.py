"""考前急救一页纸: a four-quadrant exam cheat sheet for one learning space.

① 易错红榜 and ② 支线核心结论 come straight from subject_insights() — the model never writes them, so every
quote is a real learner quote. ③ 公式与适用边界 and ④ 易混对比 + 押题自测 are model-generated; when the model is
missing, fails or times out they come back empty with a notice and ①② are still returned (never a 500).

Successful results are cached in the `subject_cheatsheets` table (created here, not in store.py) under a
fingerprint of the inputs, so reopening the sheet does not call the model again until the space changes.
Degraded results are not cached, so the next open retries the model.
"""

import asyncio
import hashlib
import json
import logging
import re
from datetime import datetime

from app.chat.insights import subject_insights
from app.chat.store import ChatStore, clip
from app.memory.store import now

logger = logging.getLogger(__name__)

MODEL_TIMEOUT_SECONDS = 60
MAX_PITFALLS = 8
MAX_CONCLUSIONS = 8
MAX_FORMULAS = 8
MAX_CONTRASTS = 5
MAX_QUIZ = 6
NOTICE_UNAVAILABLE = "模型暂不可用，③ 公式与 ④ 对比/自测暂未生成；① ② 来自你的学习记录。稍后可点「重新生成」。"
NOTICE_TIMEOUT = "模型响应超时，③ 公式与 ④ 对比/自测暂未生成；① ② 来自你的学习记录。稍后可点「重新生成」。"
NOTICE_EMPTY = "模型没有给出可用的公式或对比内容，可以在空间里多聊几轮或上传讲义后重新生成。"

PROMPT = """你是考前复习助手，为一名学生生成「考前一页纸」的两个区块。只输出 JSON 对象，不要任何其他文字：
{"formulas":[{"name":"名称","formula":"核心公式或定义，数学用 $...$ 包裹","conditions":"适用条件/边界","pitfall":"常见误用（可空）"}],
 "contrasts":[{"a":"概念A","b":"概念B","difference":"一句话核心区别","tip":"记忆口诀或判别方法（可空）"}],
 "quiz":[{"question":"押题自测题，短小可在一分钟内作答","answer":"简明答案"}]}
要求：
- 内容只能基于输入里的学习空间信息、讲义片段、对话摘录、支线结论与笔记；材料不足时宁可少写，不要编造课程之外的内容。
- formulas 最多 8 条，优先覆盖学生的误区（misconceptions）相关知识；没有公式的学科可写核心定义/定理/算法步骤。
- contrasts 最多 5 组，优先选学生容易混淆的概念；quiz 最多 6 题，优先针对误区出题。
- 每个字段尽量简短（单条不超过 80 字），适合打印在一页 A4 上。数学公式使用 KaTeX 语法并用 $...$ 包裹。"""


def ensure_table(store: ChatStore) -> None:
    with store.connection() as db:
        db.execute(
            "CREATE TABLE IF NOT EXISTS subject_cheatsheets ("
            "student_id TEXT NOT NULL, subject_id TEXT NOT NULL, fingerprint TEXT NOT NULL, "
            "payload_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(student_id, subject_id))"
        )


def _fingerprint(insights: dict, notes: str) -> str:
    # Only what the sheet is made of: timestamps move on every chat turn and must not invalidate it.
    stable = {
        "subject": insights["subject"],
        "memories": [(m["id"], m["topic"], m["summary"], m["status"], len(m["evidence"]))
                     for m in insights["misconceptions"] + insights["mastered"]],
        "threads": [(t["id"], t["status"], t["summary"], t["takeaways"]) for t in insights["threads"]],
        "materials": [m["id"] for m in insights["materials"]],
    }
    raw = json.dumps([stable, notes.strip()], ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def pitfalls(insights: dict) -> list[dict]:
    result = []
    for memory in insights["misconceptions"][:MAX_PITFALLS]:
        quotes = [clip(e["quote"], 90) for e in memory["evidence"] if e["signal"] == "supports" and e["quote"].strip()]
        result.append({
            "memory_id": memory["id"], "topic": memory["topic"], "summary": memory["summary"],
            "status": memory["status"], "quotes": quotes[:2],
        })
    return result


def conclusions(insights: dict) -> list[dict]:
    return [
        {"thread_id": t["id"], "title": t["title"], "summary": t["summary"], "takeaways": t["takeaways"][:4]}
        for t in insights["threads"] if t["status"] == "resolved" and (t["summary"] or t["takeaways"])
    ][:MAX_CONCLUSIONS]


# Models often write LaTeX like "\tau" / "\frac" / "\beta" unescaped inside JSON, which decodes to control characters.
LATEX_CONTROL = {"\t": "\\t", "\f": "\\f", "\b": "\\b", "\r": "\\r"}


def repair_latex(text: str) -> str:
    for char, escaped in LATEX_CONTROL.items():
        text = text.replace(char, escaped)
    # "\nu" / "\neq" / "\nabla" decode to a newline; only inside $...$ can that be told apart from a line break.
    return re.sub(r"\$[^$]*\$", lambda m: re.sub(r"\n(?=[a-zA-Z])", r"\\n", m.group(0)), text)


def _strings(item, keys: tuple[str, ...], required: tuple[str, ...], limit: int = 240) -> dict | None:
    if not isinstance(item, dict):
        return None
    out = {key: clip(repair_latex(str(item.get(key) or "")), limit)
           if isinstance(item.get(key), (str, int, float)) else "" for key in keys}
    return out if all(out[key] for key in required) else None


def validate(raw) -> dict:
    raw = raw if isinstance(raw, dict) else {}

    def items(name, keys, required, cap):
        values = raw.get(name) if isinstance(raw.get(name), list) else []
        return [v for v in (_strings(item, keys, required) for item in values) if v][:cap]

    return {
        "formulas": items("formulas", ("name", "formula", "conditions", "pitfall"), ("formula",), MAX_FORMULAS),
        "contrasts": items("contrasts", ("a", "b", "difference", "tip"), ("a", "b", "difference"), MAX_CONTRASTS),
        "quiz": items("quiz", ("question", "answer"), ("question", "answer"), MAX_QUIZ),
    }


def _material_excerpts(store: ChatStore, library, student_id: str, insights: dict) -> list[dict]:
    subject_id = insights["subject"]["id"]
    query = " ".join([insights["subject"]["name"], insights["subject"]["goal"],
                      *[m["topic"] for m in insights["misconceptions"]]])
    found = []
    if library is not None:
        try:
            found = [{"title": s.title, "excerpt": clip(s.excerpt, 500)}
                     for s in library.search(student_id, query[:600], 6, scope=subject_id)]
        except Exception:
            logger.warning("cheatsheet material search failed", exc_info=True)
    if not found:
        with store.connection() as db:
            rows = db.execute(
                "SELECT c.content, d.title FROM course_chunks c JOIN course_materials d ON d.id = c.document_id "
                "WHERE d.student_id = ? AND d.subject_id = ? ORDER BY d.created_at, c.rowid LIMIT 6",
                (student_id, subject_id),
            ).fetchall()
        found = [{"title": row["title"], "excerpt": clip(row["content"], 500)} for row in rows]
    return found


def _dialogue(store: ChatStore, main_id: str | None) -> list[dict]:
    if not main_id:
        return []
    rows = [row for row in store.history(main_id)
            if row["status"] == "complete" and row["kind"] == "text" and row["content"].strip()]
    return [{"role": row["role"], "excerpt": clip(row["content"], 300)} for row in rows[-12:]]


def model_input(store: ChatStore, library, student_id: str, insights: dict, notes: str) -> list[dict]:
    subject = insights["subject"]
    payload = {
        "subject": {key: subject[key] for key in ("name", "goal", "level", "deadline", "description")},
        "misconceptions": [{"topic": m["topic"], "summary": m["summary"]} for m in insights["misconceptions"][:10]],
        "mastered": [m["topic"] for m in insights["mastered"][:10]],
        "thread_conclusions": [{"title": c["title"], "summary": clip(c["summary"], 300), "takeaways": c["takeaways"]}
                               for c in conclusions(insights)],
        "materials": _material_excerpts(store, library, student_id, insights),
        "recent_dialogue": _dialogue(store, subject["main_conversation_id"]),
        "notes": clip(notes, 2000) if notes.strip() else "",
    }
    return [{"role": "system", "content": PROMPT}, {"role": "user", "content": json.dumps(payload, ensure_ascii=False)}]


def to_markdown(sheet: dict) -> str:
    s = sheet["sections"]
    lines = [f"# ⚡ 考前一页纸 · {sheet['subject']['name']}", ""]
    generated = datetime.fromisoformat(sheet["generated_at"]).astimezone().strftime("%Y-%m-%d %H:%M")
    meta = [f"生成于 {generated}"]
    if sheet["subject"].get("deadline"):
        meta.insert(0, f"考试/截止：{sheet['subject']['deadline']}")
    lines += [" · ".join(meta), ""]

    lines += ["## ① 个人易错红榜", ""]
    for p in s["pitfalls"]:
        lines.append(f"- **{p['topic']}**：{p['summary']}")
        lines += [f"  > 「{q}」" for q in p["quotes"]]
    if not s["pitfalls"]:
        lines.append("_暂无记录的误区。_")

    lines += ["", "## ② 支线核心结论", ""]
    for c in s["conclusions"]:
        lines.append(f"- **{c['title']}**：{c['summary']}".rstrip("："))
        lines += [f"  - {t}" for t in c["takeaways"]]
    if not s["conclusions"]:
        lines.append("_暂无已解决的支线。_")

    lines += ["", "## ③ 核心公式与适用边界", ""]
    for f in s["formulas"]:
        head = f"**{f['name']}**：" if f["name"] else ""
        lines.append(f"- {head}{f['formula']}")
        if f["conditions"]:
            lines.append(f"  - 适用：{f['conditions']}")
        if f["pitfall"]:
            lines.append(f"  - 易错：{f['pitfall']}")
    if not s["formulas"]:
        lines.append("_暂未生成。_")

    lines += ["", "## ④ 易混概念对比与押题自测", ""]
    if s["contrasts"]:
        lines += ["| 概念 A | 概念 B | 核心区别 | 判别方法 |", "| --- | --- | --- | --- |"]
        lines += [f"| {c['a']} | {c['b']} | {c['difference']} | {c['tip']} |".replace("\n", " ") for c in s["contrasts"]]
        lines.append("")
    for index, q in enumerate(s["quiz"], 1):
        lines.append(f"{index}. {q['question']}")
        lines.append(f"   - 答案：{q['answer']}")
    if not s["contrasts"] and not s["quiz"]:
        lines.append("_暂未生成。_")
    if sheet.get("notice"):
        lines += ["", f"> {sheet['notice']}"]
    return "\n".join(lines).rstrip() + "\n"


def _cached(store: ChatStore, student_id: str, subject_id: str, fingerprint: str) -> dict | None:
    with store.connection() as db:
        row = db.execute(
            "SELECT fingerprint, payload_json FROM subject_cheatsheets WHERE student_id = ? AND subject_id = ?",
            (student_id, subject_id),
        ).fetchone()
    if row is None or row["fingerprint"] != fingerprint:
        return None
    return json.loads(row["payload_json"])


def _save(store: ChatStore, student_id: str, subject_id: str, fingerprint: str, sheet: dict) -> None:
    with store.connection() as db:
        db.execute(
            "INSERT INTO subject_cheatsheets(student_id, subject_id, fingerprint, payload_json, created_at) "
            "VALUES (?, ?, ?, ?, ?) ON CONFLICT(student_id, subject_id) DO UPDATE SET "
            "fingerprint = excluded.fingerprint, payload_json = excluded.payload_json, created_at = excluded.created_at",
            (student_id, subject_id, fingerprint, json.dumps(sheet, ensure_ascii=False), now()),
        )


async def build_cheatsheet(store: ChatStore, service, student_id: str, subject_id: str, *,
                           notes: str = "", force: bool = False) -> dict | None:
    """None when the space is not this student's. Never raises for model problems."""
    insights = subject_insights(store, student_id, subject_id)
    if insights is None:
        return None
    ensure_table(store)
    notes = notes or ""
    fingerprint = _fingerprint(insights, notes)
    if not force and (hit := _cached(store, student_id, subject_id, fingerprint)) is not None:
        return {**hit, "cached": True}

    generated = {"formulas": [], "contrasts": [], "quiz": []}
    notice, degraded, model_name = None, False, None
    try:
        if service is None:
            raise RuntimeError("chat service unavailable")
        model = service.model()
        model_name = getattr(getattr(model, "settings", None), "llm_model", None)
        raw = await asyncio.wait_for(
            service._complete_json(model, model_input(store, getattr(service, "library", None), student_id,
                                                      insights, notes),
                                   insights["subject"]["main_conversation_id"], None, "cheatsheet"),
            MODEL_TIMEOUT_SECONDS,
        )
        generated = validate(raw)
        if not any(generated.values()):
            notice = NOTICE_EMPTY
    except (TimeoutError, asyncio.TimeoutError):
        logger.warning("cheatsheet model timed out for %s", subject_id)
        notice, degraded = NOTICE_TIMEOUT, True
    except Exception:
        logger.warning("cheatsheet model failed for %s", subject_id, exc_info=True)
        notice, degraded = NOTICE_UNAVAILABLE, True

    subject = insights["subject"]
    sheet = {
        "subject_id": subject_id,
        "subject": {key: subject[key] for key in ("id", "name", "goal", "level", "deadline")},
        "stats": insights["stats"],
        "generated_at": now(),
        "cached": False,
        "degraded": degraded,
        "notice": notice,
        "model": model_name,
        "sections": {"pitfalls": pitfalls(insights), "conclusions": conclusions(insights), **generated},
    }
    sheet["markdown"] = to_markdown(sheet)
    if not degraded:
        _save(store, student_id, subject_id, fingerprint, sheet)
    return sheet

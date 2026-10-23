"""Outer ring of the space concept graph: 3–8 next concepts the learner has not unlocked yet.

Inputs are the space goal, course-material titles and headings, and the misconceptions / threads already
in subject_insights(). A model failure, timeout or empty answer returns an empty outer ring with a notice
and HTTP 200. Successful results are cached in subject_concept_graphs (created here, not in store.py).
"""

import asyncio
import hashlib
import json
import logging
import re

from app.chat.insights import subject_insights
from app.chat.store import ChatStore, clip
from app.memory.store import now

logger = logging.getLogger(__name__)

MODEL_TIMEOUT_SECONDS = 60
MAX_CONCEPTS = 8
NOTICE_UNAVAILABLE = "模型暂不可用，外环待解锁概念暂未生成。稍后可点「刷新」。"
NOTICE_TIMEOUT = "模型响应超时，外环待解锁概念暂未生成。稍后可点「刷新」。"
NOTICE_EMPTY = "模型没有给出可用的待解锁概念。可以补充空间目标或上传讲义后再刷新。"

PROMPT = """你是学习路径规划助手。根据一个学习空间里已经出现的内容，推出下一阶段最值得解锁的概念。只输出 JSON 对象，不要任何其他文字：
{"concepts":[{"name":"概念名","summary":"一句话说明","related_ids":["已有节点 id"]}]}
要求：
- 只依据输入中的空间目标、资料标题与目录、已有误区、已掌握概念和支线。材料不足时宁可少写，不要编造该空间之外的内容。
- concepts 给 3 到 8 个。不要重复 known_nodes 里已经出现的名称。
- related_ids 只能填写 known_nodes 中的 id，表示新概念和哪些已有节点有关；不确定就给空数组。
- name 不超过 20 字，summary 不超过 40 字。"""

HEADING_RE = re.compile(r"^\s{0,3}#{1,3}\s+(.+?)\s*#*\s*$")
CHAPTER_RE = re.compile(
    r"^(?:第[0-9０-９一二三四五六七八九十百千]+[章节篇部]|[0-9]{1,2}(?:\.[0-9]{1,2}){1,3}|[0-9]{1,2}[、.])\s*\S"
)


def ensure_table(store: ChatStore) -> None:
    with store.connection() as db:
        db.execute(
            "CREATE TABLE IF NOT EXISTS subject_concept_graphs ("
            "student_id TEXT NOT NULL, subject_id TEXT NOT NULL, fingerprint TEXT NOT NULL, "
            "payload_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(student_id, subject_id))"
        )


def material_outlines(store: ChatStore, student_id: str, subject_id: str) -> list[dict]:
    """Titles plus markdown / chapter headings. Materials have no separate TOC column; headings live in chunks."""
    with store.connection() as db:
        docs = db.execute(
            "SELECT id, title, kind FROM course_materials WHERE student_id = ? AND subject_id = ? "
            "ORDER BY created_at, id",
            (student_id, subject_id),
        ).fetchall()
        outlines = []
        for doc in docs:
            rows = db.execute(
                "SELECT content FROM course_chunks WHERE document_id = ? ORDER BY rowid LIMIT 40",
                (doc["id"],),
            ).fetchall()
            headings: list[str] = []
            for row in rows:
                for line in (row["content"] or "").splitlines():
                    text = line.strip()
                    if not text or len(text) > 80:
                        continue
                    heading = HEADING_RE.match(text)
                    if heading:
                        text = heading.group(1).strip().strip("#").strip()
                    elif not CHAPTER_RE.match(text):
                        continue
                    text = clip(text, 40)
                    if text and text not in headings:
                        headings.append(text)
                    if len(headings) >= 8:
                        break
                if len(headings) >= 8:
                    break
            outlines.append({"id": doc["id"], "title": doc["title"], "kind": doc["kind"], "outline": headings})
    return outlines


def _fingerprint(insights: dict, outlines: list[dict]) -> str:
    subject = insights["subject"]
    stable = {
        "subject": {key: subject[key] for key in ("name", "goal", "level", "description", "deadline")},
        "misconceptions": [(m["id"], m["topic"], m["summary"], m["status"], len(m["evidence"]))
                           for m in insights["misconceptions"]],
        "mastered": [(m["id"], m["topic"], m["summary"]) for m in insights["mastered"]],
        "threads": [(t["id"], t["status"], t["title"], t["summary"], tuple(t["takeaways"])) for t in insights["threads"]],
        "materials": [(m["id"], m["title"], tuple(m["outline"])) for m in outlines],
    }
    raw = json.dumps(stable, ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _known(insights: dict) -> list[dict]:
    nodes = [{"id": m["id"], "kind": "mastered", "label": m["topic"]} for m in insights["mastered"]]
    nodes += [{"id": m["id"], "kind": "misconception", "label": m["topic"]} for m in insights["misconceptions"]]
    nodes += [{"id": t["id"], "kind": "thread", "label": t["title"]} for t in insights["threads"]]
    return nodes


def _fog_id(name: str) -> str:
    return "fog-" + hashlib.sha256(name.casefold().encode("utf-8")).hexdigest()[:12]


def _related(value, ids: set[str], label_to_id: dict[str, str]) -> list[str]:
    found: list[str] = []
    if not isinstance(value, list):
        return found
    for item in value:
        key = item.get("id") if isinstance(item, dict) else item
        if not isinstance(key, (str, int, float)):
            continue
        text = str(key).strip()
        mapped = text if text in ids else label_to_id.get(text)
        if mapped and mapped not in found:
            found.append(mapped)
        if len(found) >= 6:
            break
    return found


def validate(raw, known: list[dict]) -> list[dict]:
    if isinstance(raw, dict):
        values = raw.get("concepts") if isinstance(raw.get("concepts"), list) else []
    elif isinstance(raw, list):
        values = raw
    else:
        values = []
    ids = {node["id"] for node in known}
    label_to_id: dict[str, str] = {}
    taken: set[str] = set()
    for node in known:
        label = str(node["label"]).strip()
        label_to_id.setdefault(label, node["id"])
        if label:
            taken.add(label.casefold())
    nodes = []
    seen: set[str] = set()
    for item in values:
        if not isinstance(item, dict):
            continue
        name = clip(str(item.get("name") or ""), 40)
        summary = clip(str(item.get("summary") or ""), 120)
        if not name or not summary:
            continue
        key = name.casefold()
        if key in taken or key in seen:
            continue
        seen.add(key)
        link_field = item.get("related_ids")
        if not isinstance(link_field, list):
            link_field = item.get("related") if isinstance(item.get("related"), list) else []
        nodes.append({
            "id": _fog_id(name),
            "name": name,
            "summary": summary,
            "related_ids": _related(link_field, ids, label_to_id),
        })
        if len(nodes) >= MAX_CONCEPTS:
            break
    nodes.sort(key=lambda node: node["id"])
    return nodes


def model_input(insights: dict, outlines: list[dict]) -> list[dict]:
    subject = insights["subject"]
    payload = {
        "subject": {key: subject[key] for key in ("name", "goal", "level", "description", "deadline")},
        "materials": [{"title": item["title"], "kind": item["kind"], "outline": item["outline"]} for item in outlines],
        "misconceptions": [{"id": m["id"], "topic": m["topic"], "summary": m["summary"]}
                           for m in insights["misconceptions"][:12]],
        "mastered": [{"id": m["id"], "topic": m["topic"], "summary": m["summary"]} for m in insights["mastered"][:12]],
        "threads": [{"id": t["id"], "title": t["title"], "status": t["status"], "summary": clip(t["summary"], 300)}
                    for t in insights["threads"][:12]],
        "known_nodes": _known(insights),
    }
    return [{"role": "system", "content": PROMPT}, {"role": "user", "content": json.dumps(payload, ensure_ascii=False)}]


def _cached(store: ChatStore, student_id: str, subject_id: str, fingerprint: str) -> dict | None:
    with store.connection() as db:
        row = db.execute(
            "SELECT fingerprint, payload_json FROM subject_concept_graphs WHERE student_id = ? AND subject_id = ?",
            (student_id, subject_id),
        ).fetchone()
    if row is None or row["fingerprint"] != fingerprint:
        return None
    return json.loads(row["payload_json"])


def _save(store: ChatStore, student_id: str, subject_id: str, fingerprint: str, graph: dict) -> None:
    with store.connection() as db:
        db.execute(
            "INSERT INTO subject_concept_graphs(student_id, subject_id, fingerprint, payload_json, created_at) "
            "VALUES (?, ?, ?, ?, ?) ON CONFLICT(student_id, subject_id) DO UPDATE SET "
            "fingerprint = excluded.fingerprint, payload_json = excluded.payload_json, created_at = excluded.created_at",
            (student_id, subject_id, fingerprint, json.dumps(graph, ensure_ascii=False), now()),
        )


async def build_concept_graph(store: ChatStore, service, student_id: str, subject_id: str, *,
                              force: bool = False) -> dict | None:
    """None when the space is not this student's. Never raises for model problems."""
    insights = subject_insights(store, student_id, subject_id)
    if insights is None:
        return None
    ensure_table(store)
    outlines = material_outlines(store, student_id, subject_id)
    fingerprint = _fingerprint(insights, outlines)
    if not force and (hit := _cached(store, student_id, subject_id, fingerprint)) is not None:
        return {**hit, "cached": True}

    nodes: list[dict] = []
    notice, degraded, model_name = None, False, None
    try:
        if service is None:
            raise RuntimeError("chat service unavailable")
        model = service.model()
        model_name = getattr(getattr(model, "settings", None), "llm_model", None)
        raw = await asyncio.wait_for(
            service._complete_json(model, model_input(insights, outlines),
                                   insights["subject"]["main_conversation_id"], None, "concept-graph"),
            MODEL_TIMEOUT_SECONDS,
        )
        nodes = validate(raw, _known(insights))
        if not nodes:
            notice = NOTICE_EMPTY
    except (TimeoutError, asyncio.TimeoutError):
        logger.warning("concept graph model timed out for %s", subject_id)
        notice, degraded = NOTICE_TIMEOUT, True
    except Exception:
        logger.warning("concept graph model failed for %s", subject_id, exc_info=True)
        notice, degraded = NOTICE_UNAVAILABLE, True

    graph = {
        "subject_id": subject_id,
        "generated_at": now(),
        "cached": False,
        "degraded": degraded,
        "notice": notice,
        "model": model_name,
        "nodes": nodes,
    }
    if not degraded:
        _save(store, student_id, subject_id, fingerprint, graph)
    return graph

import json
import re
import sqlite3
import threading
from typing import Protocol, TypedDict

from app.agent_tools.guard import ToolError
from app.services.materials import MaterialStore

TOOL_NAME = "search_materials"
DEFAULT_LIMIT = 5
MAX_LIMIT = 10
MAX_QUERY_CHARS = 200
MAX_EXCERPT_CHARS = 300
_LABEL = re.compile(r"^(\D+)(\d+)$")
_SOURCES_LOCK = threading.Lock()

DEFINITION = {
    "type": "function",
    "function": {
        "name": TOOL_NAME,
        "description": (
            "按关键词检索当前对话可见的资料库，可多次更换关键词补充检索；范围由当前对话决定。"
            "结果只是资料片段，不是全文。需要原文时调用 read_document，file_id 填结果中的 document_id，"
            "再用 start/limit 按页读取。"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "去除首尾空白后 1～200 个字符的检索关键词"},
                "limit": {"type": "integer", "description": "返回条数，默认 5，最小 1，大于 10 时按 10 处理"},
            },
            "required": ["query"],
            "additionalProperties": False,
        },
    },
}


class MaterialSearchContext(Protocol):
    student_id: str
    subject_id: str | None
    library: MaterialStore | None


class MaterialSearchResult(TypedDict):
    label: str
    document_id: str
    title: str
    page: int | None
    excerpt: str


class MaterialSearchResponse(TypedDict):
    results: list[MaterialSearchResult]


def run(arguments: dict[str, object], ctx: MaterialSearchContext) -> str:
    if set(arguments) - {"query", "limit"}:
        raise ToolError("search_materials 仅接受 query 和 limit，不能改选学习者或资料范围。")
    raw_query = arguments.get("query")
    if not isinstance(raw_query, str):
        raise ToolError("query 必须是字符串关键词。")
    query = raw_query.strip()
    if not query:
        raise ToolError("检索关键词不能为空。")
    if len(query) > MAX_QUERY_CHARS:
        raise ToolError("检索关键词去除首尾空白后不能超过 200 字。")
    limit = arguments.get("limit", DEFAULT_LIMIT)
    if isinstance(limit, bool) or not isinstance(limit, int) or limit < 1:
        raise ToolError("limit 必须是大于等于 1 的整数。")
    limit = min(limit, MAX_LIMIT)
    library = getattr(ctx, "library", None)
    if library is None:
        raise ToolError("当前环境不能检索资料。")
    try:
        sources = library.search_scoped(
            ctx.student_id, query, limit, getattr(ctx, "subject_id", None),
        )
    except sqlite3.Error as exc:
        raise ToolError("资料检索暂时不可用，请稍后重试。") from exc
    sources = _merge_turn_sources(sources, getattr(ctx, "sources", None))
    response: MaterialSearchResponse = {"results": [
        {
            "label": source.label,
            "document_id": source.document_id,
            "title": source.title,
            "page": source.page,
            "excerpt": source.excerpt[:MAX_EXCERPT_CHARS],
        }
        for source in sources
    ]}
    return json.dumps(response, ensure_ascii=False)

def _merge_turn_sources(found: list, turn_sources: list | None) -> list:
    """Give tool hits labels that don't collide with this turn's automatic ones and record them for citations.

    A chunk already in the turn keeps its label; a new chunk continues its family's numbering
    (资料6 / 空间资料3 / 通用资料2), so [资料N] in the reply always points at one document.
    """
    if not isinstance(turn_sources, list):
        return found
    with _SOURCES_LOCK:
        known = {source.id: source for source in turn_sources}
        merged = []
        for source in found:
            if source.id in known:
                merged.append(known[source.id])
                continue
            match = _LABEL.match(source.label)
            prefix = match.group(1) if match else source.label
            taken = [int(m.group(2)) for m in (_LABEL.match(s.label) for s in turn_sources)
                     if m and m.group(1) == prefix]
            labelled = source.model_copy(update={"label": f"{prefix}{max(taken, default=0) + 1}"})
            turn_sources.append(labelled)
            known[labelled.id] = labelled
            merged.append(labelled)
        return merged

"""create_document / edit_document / read_document：让 AI 直接给学生一份可下载的 Word、PPT、Excel、PDF。"""

import json
import re

from app.agent_tools.guard import ToolError
from app.services import office_writers as writers
from app.services.file_store import safe_filename, public

MAX_CONTENT = 120_000
MAX_OPERATIONS = 50
KINDS = ("docx", "pptx", "xlsx", "pdf", "md")
NAMES = {"create_document", "edit_document", "read_document"}

DEFINITIONS = [
    {
        "type": "function",
        "function": {
            "name": "create_document",
            "description": (
                "生成一份学生可以直接下载的文件：Word(.docx)、PPT(.pptx)、Excel(.xlsx)、PDF(.pdf) 或 Markdown(.md)。"
                "学生说「帮我写一份……文档/报告/总结/笔记」「做成 PPT」「整理成表格」「导出成 PDF」时使用，"
                "不要只把全文贴在聊天里。内容用 Markdown 写：# 一级标题、## 二级标题、- 列表、1. 编号、"
                "| 表格 |、```代码块```、> 引用、**加粗**。"
                "pptx：每个 `## 页标题` 是一页，页内用 - 列表写要点（每页 3~6 条，短句），`备注：` 开头的段落是演讲者备注，`# 标题` 是整份演示的标题。"
                "xlsx：每个 `## 工作表名` 后面跟一张 Markdown 表格，第一行是表头；以 = 开头的单元格是公式，如 =SUM(B2:B9)。"
                "文件生成后学生在对话里就能下载，回复里只需用一两句话说明做了什么，不要再把全文重复一遍。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "kind": {"type": "string", "enum": list(KINDS)},
                    "filename": {"type": "string", "description": "文件名，不含扩展名也可以，如「栈与队列复习提纲」"},
                    "content": {"type": "string", "description": "Markdown 正文"},
                    "subtitle": {"type": "string", "description": "仅 pptx：封面副标题，如课程名和日期"},
                },
                "required": ["kind", "filename", "content"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "edit_document",
            "description": (
                "在学生上传的文件或你之前生成的文件上做修改，原文件不动，修改后另存为新文件。支持 .docx / .pptx / .xlsx（旧版 .doc/.ppt/.xls 和 PDF 不能原地修改，"
                "改用 create_document 生成新文件）。file_id 是附件或生成文件的 id。修改前如果不确定原文，先用 read_document 读一遍，find 必须与原文逐字一致。"
                "operations 按顺序执行。docx：{op:'replace',find,replace,all?} / {op:'append',markdown} / {op:'insert_after',after,markdown} / {op:'delete',find}（删除包含 find 的段落）。"
                "pptx：{op:'replace',find,replace} / {op:'append_slides',markdown} / {op:'delete_slide',slide} / {op:'set_notes',slide,text}。"
                "xlsx：{op:'set_cell',sheet?,cell,value} / {op:'append_rows',sheet?,rows} / {op:'replace',find,replace}。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "file_id": {"type": "string"},
                    "operations": {"type": "array", "items": {"type": "object"}},
                    "filename": {"type": "string", "description": "另存的文件名；不填则在原名后加「（修改版）」"},
                },
                "required": ["file_id", "operations"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_document",
            "description": "读取学生上传的文件或你生成的文件的文字内容（按页/幻灯片/工作表分段，带页码），用来在修改前核对原文，或对长文件按页继续读。",
            "parameters": {
                "type": "object",
                "properties": {
                    "file_id": {"type": "string"},
                    "start": {"type": "integer", "description": "从第几页/张/个表开始，1 起算，默认 1"},
                    "limit": {"type": "integer", "description": "最多读几页，默认 5，最大 20"},
                },
                "required": ["file_id"],
                "additionalProperties": False,
            },
        },
    },
]

_EXTENSION = re.compile(r"\.([a-z0-9]+)$", re.I)


def _require(ctx):
    files = getattr(ctx, "files", None)
    if files is None:
        raise ToolError("当前环境不能生成文件。")
    return files


def _emit(ctx, record: dict) -> None:
    getattr(ctx, "generated", []).append(public(record))
    if getattr(ctx, "on_file", None):
        ctx.on_file(public(record))


def _size_text(size: int) -> str:
    return f"{size / 1024:.0f} KB" if size >= 1024 else f"{size} B"


def create_document(arguments: dict, ctx) -> str:
    files = _require(ctx)
    kind = str(arguments.get("kind") or "").lower().lstrip(".")
    content = str(arguments.get("content") or "")
    if kind not in KINDS:
        raise ToolError(f"kind 只能是 {' / '.join(KINDS)}。")
    if not content.strip():
        raise ToolError("content 是空的：请把文档的完整 Markdown 内容放进来。")
    if len(content) > MAX_CONTENT:
        raise ToolError("内容太长，请拆成几份文件，或精简后再生成。")
    title = str(arguments.get("filename") or "").strip() or "文档"
    title_text = _EXTENSION.sub("", title).strip() or "文档"
    try:
        if kind == "md":
            data = content.encode("utf-8")
        elif kind == "pptx":
            data = writers.build_pptx(title_text, content, str(arguments.get("subtitle") or ""))
        else:
            data = writers.BUILDERS[kind](title_text, content)
    except writers.DocumentError as exc:
        raise ToolError(str(exc)) from exc
    except Exception as exc:  # 排版库对畸形输入可能抛各种异常，不要让整轮回复失败
        raise ToolError(f"生成 {kind} 失败：{exc}。请检查 Markdown 格式后重试。") from exc
    record = files.save_generated(ctx.student_id, ctx.conversation_id, safe_filename(title_text, kind), kind, data)
    _emit(ctx, record)
    return (f"已生成「{record['name']}」（{_size_text(record['size'])}），file_id={record['id']}。"
            "学生可以在对话里直接下载；如需再改，用 edit_document 或重新生成。")


def _resolve(files, ctx, file_id: str):
    found = files.get(str(file_id or ""), ctx.student_id)
    if found is None:
        raise ToolError("找不到这个文件（id 不对，或不属于当前学生）。")
    return found


def edit_document(arguments: dict, ctx) -> str:
    files = _require(ctx)
    operations = arguments.get("operations")
    if not isinstance(operations, list) or not operations or not all(isinstance(item, dict) for item in operations):
        raise ToolError("operations 必须是非空的操作数组。")
    if len(operations) > MAX_OPERATIONS:
        raise ToolError(f"一次最多 {MAX_OPERATIONS} 项操作。")
    record, data = _resolve(files, ctx, arguments.get("file_id"))
    name, kind = record["name"], record["kind"]
    if re.search(r"\.(doc|ppt|xls)$", name, re.I):
        raise ToolError("旧版 Office 文件（.doc / .ppt / .xls）不能原地修改；请用 read_document 读出内容，再用 create_document 生成新文件。")
    editor = writers.EDITORS.get(kind)
    if editor is None:
        raise ToolError("PDF 和文本文件不能原地修改；请用 read_document 读出内容，再用 create_document 生成修改后的新文件。")
    try:
        edited, log = editor(data, operations)
    except writers.DocumentError as exc:
        raise ToolError(str(exc)) from exc
    except Exception as exc:
        raise ToolError(f"修改失败：{exc}。文件没有被改动。") from exc
    stem = _EXTENSION.sub("", name)
    title = str(arguments.get("filename") or "").strip() or f"{stem}（修改版）"
    saved = files.save_generated(ctx.student_id, ctx.conversation_id, safe_filename(title, kind), kind, edited, source_id=record["id"])
    _emit(ctx, saved)
    return (f"已另存为「{saved['name']}」，file_id={saved['id']}；原文件没有改动。做了：" + "；".join(log) + "。")


def read_document(arguments: dict, ctx) -> str:
    from app.services.materials import extract_document

    files = _require(ctx)
    record, data = _resolve(files, ctx, arguments.get("file_id"))
    try:
        _, reading = extract_document(record["name"], data)
    except Exception as exc:
        raise ToolError(f"这个文件读不出文字：{getattr(exc, 'detail', exc)}") from exc
    pages = reading.pages
    start = max(1, int(arguments.get("start") or 1))
    limit = min(max(1, int(arguments.get("limit") or 5)), 20)
    chunk = pages[start - 1:start - 1 + limit]
    if not chunk:
        raise ToolError(f"没有第 {start} 页（共 {len(pages)} 页/张/个表）。")
    body = "\n\n".join(f"【第 {start + index} 页】\n{text}" for index, (_, text) in enumerate(chunk))
    note = f"\n\n（共 {len(pages)} 页/张/个表，已读第 {start}–{start + len(chunk) - 1}。）"
    if reading.notes:
        note += "\n没读到的内容：" + "；".join(reading.notes)
    return body + note


def run(name: str, arguments: dict, ctx) -> str:
    handler = {"create_document": create_document, "edit_document": edit_document, "read_document": read_document}[name]
    return handler(arguments, ctx)

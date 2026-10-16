"""Pi-style file tools plus memory tools, all returning plain text for the model."""

import asyncio
import json
from pathlib import Path

from app.agent_tools import bash as bash_tool
from app.agent_tools import files
from app.agent_tools.guard import ToolError

MAX_RESULT = 8000

DEFINITIONS = [
    {
        "type": "function",
        "function": {
            "name": "exercise_reference",
            "description": "获取当前练习经程序校验的结论、操作过程和判据。仅在本轮用户作答、要提示或要求解答当前题目时调用；打招呼或换话题时不要调用。",
            "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "dispatch_thread",
            "description": "主对话将具体学习任务交给 Thread 并立即执行。相关补充传已有 thread_id，新任务省略 thread_id。每次只交办一件事，不要只创建空对话。",
            "parameters": {"type": "object", "properties": {
                "title": {"type": "string", "description": "60 字以内的具体任务标题"},
                "task": {"type": "string", "description": "任务范围、目标和本轮需要做的事，保持用户原意"},
                "thread_id": {"type": "string", "description": "续接时填 conversation_role.threads 中的 id；新建时省略"},
            }, "required": ["title", "task"], "additionalProperties": False},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "report_progress",
            "description": "Thread 向主对话回报重要进展或本轮结果。summary 简明写明实际进展、结论或阻塞；需要用户作答、补充或决策时 needs_user=true。",
            "parameters": {"type": "object", "properties": {
                "summary": {"type": "string", "description": "600 字以内的进展或结果"},
                "needs_user": {"type": "boolean"},
            }, "required": ["summary"], "additionalProperties": False},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read",
            "description": "读取工作区内的文本文件，返回带行号的内容。大文件用 offset 和 limit 分段读。",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "相对工作区的路径，或工作区内的绝对路径"},
                    "offset": {"type": "integer", "description": "从第几行开始，1 起算，默认 1"},
                    "limit": {"type": "integer", "description": "最多读取的行数，默认 2000"},
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "write",
            "description": "创建或覆盖工作区内的文件。父目录不存在时会创建。需要用户批准。",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "content": {"type": "string", "description": "写入的完整内容"},
                },
                "required": ["path", "content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "edit",
            "description": "把文件中唯一一处 old_text 精确替换成 new_text。old_text 必须与文件内容逐字一致且只出现一次。需要用户批准。",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "old_text": {"type": "string"},
                    "new_text": {"type": "string"},
                },
                "required": ["path", "old_text", "new_text"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "bash",
            "description": "以工作区为起始目录用 PowerShell 执行命令，可以访问工作区外的文件，每次都需要用户批准。不要用它读写可以用 read/write/edit 完成的文件。",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {"type": "string"},
                    "timeout": {"type": "integer", "description": "秒，默认 30，最大 120"},
                },
                "required": ["command"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "memory",
            "description": "维护两块长期笔记，没有 read，内容已在系统提示的快照里。target=user 只记用户是谁、沟通方式和长期目标；target=memory 只记环境事实（路径、约定、资料位置、工具坑）。知识点的误区、掌握和学习偏好不要写到这里。action=add 追加一条，patch 用 content 替换唯一一条 old_text，remove 删掉那一条。完全相同的条目会被丢掉。超限直接失败，必须在这一轮里先 remove 再写。已保存或批准的写入会在下一轮进入系统提示。",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": ["add", "patch", "remove"]},
                    "target": {"type": "string", "enum": ["user", "memory"]},
                    "content": {"type": "string", "description": "add 或 patch 的新条目"},
                    "old_text": {"type": "string", "description": "patch 和 remove 要精确匹配的那一条"},
                },
                "required": ["action", "target"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "session_search",
            "description": "搜索这个用户所有对话的原文，包括当前对话较早的消息。返回原文，不经过摘要。笔记里放每次都要知道的，这里查以前聊过什么。",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "limit": {"type": "integer", "description": "条数，默认 5，最大 8"},
                },
                "required": ["query"],
            },
        },
    },
]

NEEDS_APPROVAL = {"write", "edit", "bash"}


def parse_arguments(raw: str) -> dict:
    if not raw or not raw.strip():
        return {}
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise ToolError("工具参数必须是 JSON 对象。")
    return value


def _clip(text: str) -> str:
    if len(text) <= MAX_RESULT:
        return text
    return text[:MAX_RESULT] + "\n…（输出已截断）"


async def run(name: str, arguments: dict, ctx) -> str:
    try:
        if name == "exercise_reference":
            from app.services.problems import reference_for

            exercise = getattr(ctx, "exercise", None)
            if exercise is None or arguments:
                raise ToolError("当前没有可查询的练习，且此工具不接受参数。")
            text = json.dumps({"problem_id": exercise.id, **reference_for(exercise)}, ensure_ascii=False)
        elif name == "dispatch_thread":
            if not getattr(ctx, "dispatch_thread", None):
                raise ToolError("当前对话不能分派 Thread。")
            text = ctx.dispatch_thread(arguments)
        elif name == "report_progress":
            if not getattr(ctx, "report_progress", None):
                raise ToolError("当前对话不是 Thread。")
            text = ctx.report_progress(arguments)
        elif name == "read":
            text = await asyncio.to_thread(files.read_file, ctx.workspace, arguments)
        elif name == "write":
            text = await asyncio.to_thread(files.write_file, ctx.workspace, arguments)
        elif name == "edit":
            text = await asyncio.to_thread(files.edit_file, ctx.workspace, arguments)
        elif name == "bash":
            text = await bash_tool.run(ctx.workspace, arguments)
        elif name == "memory":
            text = ctx.store.apply_agent_memory(
                ctx.student_id,
                str(arguments.get("action") or ""),
                str(arguments.get("target") or ""),
                arguments.get("content"),
                arguments.get("old_text"),
                approve=bool(getattr(ctx, "approve_memory", False)),
            )
        elif name == "session_search":
            limit = arguments.get("limit", 5)
            text = ctx.store.search_messages(
                ctx.student_id, str(arguments.get("query") or ""), limit if isinstance(limit, int) else 5,
            )
        else:
            text = f"未知工具：{name}"
    except json.JSONDecodeError:
        return "工具参数不是有效的 JSON。"
    except OSError as exc:
        return f"文件操作失败：{exc.strerror or exc}"
    return _clip(text)


def workspace_of(settings_holder) -> Path | None:
    if settings_holder is None:
        return None
    raw = (settings_holder.agent_config().get("workspace") or "").strip()
    if not raw:
        return None
    path = Path(raw)
    return path if path.is_dir() else None

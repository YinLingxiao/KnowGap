"""Pi-style file tools plus memory tools, all returning plain text for the model."""

import asyncio
import json
from pathlib import Path

from app.agent_tools import agenda as agenda_tools
from app.agent_tools import bash as bash_tool
from app.agent_tools import documents as document_tools
from app.agent_tools import files
from app.agent_tools import problem_search
from app.agent_tools.guard import (
    ToolError, check_content_security_blacklist, check_security_blacklist, enforce_security_blacklist,
)
from app.chat.skills import problem_drill_skill

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
            "description": "主线开始具体讲解、练习或研究时必须使用，用户无需提到支线。也用于「可以/开始吧」接受上轮具体任务。用户要求接着已有支线时必须填其真实 thread_id，下一道练习也续接。独立新任务才省略 thread_id。交办后立即执行。",
            "parameters": {"type": "object", "properties": {
                "title": {"type": "string", "description": "60 字以内的具体任务标题"},
                "task": {"type": "string", "description": "自包含的任务说明：主题、目标、必要的前文/练习背景和下一步，保持用户原意；不能只写「可以」「继续」"},
                "thread_id": {"type": "string", "description": "用户要继续已有支线或补充相关任务时必须填 conversation_role.threads 对应项的真实 id；省略会新建，只有独立新任务才省略"},
                "skill": {
                    "type": "string",
                    "enum": ["deep_explain", "socratic_practice", "study_note_builder", "general"],
                    "description": "推荐挂载给支线的教学技能：原理精讲用 deep_explain，做题带练用 socratic_practice，整理讲义/实验用 study_note_builder",
                },
            }, "required": ["title", "task"], "additionalProperties": False},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "propose_threads",
            "description": "仅在尚未选定任务、比较学习路线或只要建议时展示候选支线，不立即执行。用户已明确要讲解或练习，或已接受上轮任务时，使用 dispatch_thread 直接执行。",
            "parameters": {"type": "object", "properties": {
                "proposals": {"type": "array", "minItems": 1, "maxItems": 4, "items": {
                    "type": "object",
                    "properties": {
                        "title": {"type": "string", "description": "60 字以内的具体任务标题"},
                        "task": {"type": "string", "description": "任务范围、目标和预期结果"},
                        "reason": {"type": "string", "description": "为什么建议这个任务，对学习目标的帮助"},
                    },
                    "required": ["title", "task", "reason"],
                    "additionalProperties": False,
                }},
            }, "required": ["proposals"], "additionalProperties": False},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "report_progress",
            "description": "记录本轮重要进展或结果，只保存在这条回复里，供支线状态和协调者的支线列表使用，不写回主线。summary 简明写明实际进展、结论或阻塞；需要用户作答、补充或决策时 needs_user=true。",
            "parameters": {"type": "object", "properties": {
                "summary": {"type": "string", "description": "600 字以内的进展或结果"},
                "needs_user": {"type": "boolean"},
            }, "required": ["summary"], "additionalProperties": False},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "stay_silent",
            "description": "系统事件回合专用：本轮不打扰学习者。默认调用它；只有失败、学习计划变化或明确的下一步才发言。",
            "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "update_plan",
            "description": "创建或整份更新本对话学习计划（1~8 步）。保留已有步骤 id；讲完不等于学会，需要作答时设 awaiting_learner 并在 note 写问题，学习者答对后才设 done。返回归一化计划及被拒绝的改动。",
            "parameters": {
                "type": "object",
                "properties": {
                    "steps": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": 8,
                        "items": {
                            "type": "object",
                            "properties": {
                                "id": {"type": "string"},
                                "title": {"type": "string", "minLength": 1, "maxLength": 60},
                                "status": {"type": "string", "enum": ["pending", "in_progress", "awaiting_learner", "done", "skipped"]},
                                "note": {"type": "string", "maxLength": 120},
                                "thread_id": {"type": "string"},
                            },
                            "required": ["title", "status"],
                            "additionalProperties": False,
                        },
                    },
                },
                "required": ["steps"],
                "additionalProperties": False,
            },
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
            "description": "维护两块长期笔记，内容已在系统提示快照里。target=user 记录用户身份、长期目标及明确确认的长期学习/沟通偏好（统一前缀：讲解偏好：或互动偏好：），用户明确自述已学过的技能用先验技能：前缀记录，不能当作经诊断的掌握结论；target=memory 只记环境事实。知识点误区和掌握不要写入。临时要求不写入；空间专属要求不要写入全局 USER。action=add 追加，patch 精确替换唯一 old_text，remove 删除；修改同维度偏好优先 patch 而非追加。返回待确认、拒绝或失败不等于已保存。超限请先精简，已保存或批准的修改下一轮生效。",
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
    problem_search.DEFINITION,
    problem_drill_skill.VERIFY_DEFINITION,
]

NEEDS_APPROVAL = {"write", "edit", "bash"}


DEFINITIONS += agenda_tools.DEFINITIONS
DEFINITIONS += document_tools.DEFINITIONS


def _without_trailing_commas(raw: str) -> str:
    """Repair JSON punctuation only; commas/quotes inside string values are data."""
    result = []
    in_string = escaped = False
    for index, char in enumerate(raw):
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
        elif char == '"':
            in_string = True
        elif char == ",":
            following = index + 1
            while following < len(raw) and raw[following].isspace():
                following += 1
            if following < len(raw) and raw[following] in "}]":
                continue
        result.append(char)
    return "".join(result)


INVALID_ARGUMENTS = "工具参数不是有效的 JSON 对象，请检查括号与引号闭合后重试。"


def _container(raw: str, opening: str) -> str | None:
    start = raw.find("{") if opening == "{" else next((i for i, char in enumerate(raw) if char in "{["), -1)
    if start < 0:
        return None
    end = raw.rfind("}" if raw[start] == "{" else "]")
    return raw[start:end + 1] if end >= start else None


def parse_arguments(raw: str) -> dict:
    if not raw or not raw.strip():
        return {}
    try:
        value = json.loads(raw)
    except json.JSONDecodeError:
        # Isolate the outer JSON container from fences, BOMs and stray model text.
        # Keep arrays intact so the object-only contract cannot be bypassed; only when the
        # first container is not JSON (e.g. a "[见下]" note) fall back to the object block.
        for opening in ("first", "{"):
            cleaned = _container(raw, opening)
            if cleaned is None:
                continue
            try:
                value = json.loads(_without_trailing_commas(cleaned))
                break
            except json.JSONDecodeError:
                continue
        else:
            raise ToolError(INVALID_ARGUMENTS) from None
    if not isinstance(value, dict):
        raise ToolError("工具参数必须是 JSON 对象。")
    return value


def preflight_blacklist(name: str, raw_args: str) -> str | None:
    """Blacklist verdict for a pending call, so a doomed call never reaches the approval card."""
    try:
        arguments = parse_arguments(raw_args)
    except ToolError:
        return None  # Malformed arguments are reported by the normal execution path.
    reason = None
    if name == "bash":
        reason = check_security_blacklist(str(arguments.get("command") or ""))
    elif name in {"read", "write", "edit"}:
        reason = check_security_blacklist(str(arguments.get("path") or ""))
    if not reason and name in {"write", "edit"}:
        reason = check_content_security_blacklist(arguments.get("content" if name == "write" else "new_text"))
    return f"安全防线拦截：{reason}" if reason else None


def _clip(text: str) -> str:
    if len(text) <= MAX_RESULT:
        return text
    return text[:MAX_RESULT] + "\n…（输出已截断）"


async def run(name: str, arguments: dict, ctx) -> str:
    # Mandatory preflight before accessing context or delegating to any executor.
    if name == "bash":
        enforce_security_blacklist(str(arguments.get("command") or ""))
    elif name in {"read", "write", "edit"}:
        enforce_security_blacklist(str(arguments.get("path") or ""))
    try:
        if name == "exercise_reference":
            from app.services.problems import reference_for

            exercise = getattr(ctx, "exercise", None)
            if exercise is None or arguments:
                raise ToolError("当前没有可查询的练习，且此工具不接受参数。")
            text = json.dumps({"problem_id": exercise.id, **reference_for(exercise)}, ensure_ascii=False)
        elif name == "dispatch_thread":
            if not getattr(ctx, "dispatch_thread", None):
                raise ToolError("当前对话不能分派支线。")
            text = ctx.dispatch_thread(arguments)
        elif name == "propose_threads":
            if not getattr(ctx, "propose_threads", None):
                raise ToolError("当前对话不能建议支线。")
            text = ctx.propose_threads(arguments)
        elif name == "report_progress":
            if not getattr(ctx, "report_progress", None):
                raise ToolError("当前对话不是支线。")
            text = ctx.report_progress(arguments)
        elif name == "stay_silent":
            if not getattr(ctx, "stay_silent", None):
                raise ToolError("当前回合不能保持沉默。")
            text = ctx.stay_silent(arguments)
        elif name == "update_plan":
            from app.chat.plan import PlanStore

            try:
                result = PlanStore(ctx.store).update(
                    ctx.conversation_id, ctx.student_id, arguments.get("steps"),
                    getattr(ctx, "assistant_message_id", None), getattr(ctx, "user_message_id", None),
                )
            except (LookupError, ValueError) as exc:
                raise ToolError(str(exc)) from exc
            if result["plan_changes"] or result["plan"]["version"] != getattr(ctx, "plan_version", 0):
                if getattr(ctx, "on_plan", None):
                    ctx.on_plan(result["plan"])
            ctx.plan_version = result["plan"]["version"]
            text = json.dumps(result, ensure_ascii=False)
        elif name == "plan_steps":
            steps = arguments.get("steps")
            if not isinstance(steps, list) or not steps:
                raise ToolError("steps 必须是非空步骤列表。")
            cleaned = []
            for item in steps[:5]:
                if not isinstance(item, dict) or not str(item.get("title") or "").strip():
                    raise ToolError("每个步骤必须包含 title。")
                status = str(item.get("status") or "pending")
                if status not in {"pending", "in_progress", "completed"}:
                    status = "pending"
                cleaned.append({"title": str(item["title"]).strip()[:80], "status": status})
            text = json.dumps({"steps": cleaned}, ensure_ascii=False)
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
        elif name == problem_search.TOOL_NAME:
            # 两个工具内部兜住所有异常、自己控制输出长度，永远返回 JSON 文本
            text = await problem_search.run(arguments, ctx)
        elif name == problem_drill_skill.VERIFY_TOOL:
            text = await problem_drill_skill.run_verify(arguments, ctx)
        elif name in document_tools.NAMES:
            text = await asyncio.to_thread(document_tools.run, name, arguments, ctx)
        elif name in agenda_tools.NAMES:
            text = await asyncio.to_thread(agenda_tools.run, name, arguments, ctx)
        elif name == "session_search":
            limit = arguments.get("limit", 5)
            text = ctx.store.search_messages(
                ctx.student_id, str(arguments.get("query") or ""), limit if isinstance(limit, int) else 5,
            )
        else:
            text = f"未知工具：{name}"
    except json.JSONDecodeError:
        return INVALID_ARGUMENTS
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

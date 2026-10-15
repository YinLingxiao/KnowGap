import difflib
from pathlib import Path

from app.agent_tools.guard import ToolError, resolve_inside

MAX_LINES = 2000
MAX_BYTES = 50_000
MAX_WRITE = 1_000_000


def read_file(root: Path | None, arguments: dict) -> str:
    path = resolve_inside(root, str(arguments.get("path") or ""))
    if not path.is_file():
        raise ToolError("文件不存在。")
    offset = arguments.get("offset", 1)
    limit = arguments.get("limit", MAX_LINES)
    if not isinstance(offset, int) or offset < 1:
        offset = 1
    if not isinstance(limit, int) or limit < 1:
        limit = MAX_LINES
    limit = min(limit, MAX_LINES)
    data = path.read_bytes()
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        raise ToolError("不是 UTF-8 文本文件。") from None
    lines = text.splitlines()
    chosen = lines[offset - 1:offset - 1 + limit]
    body = "\n".join(f"{offset + index}|{line}" for index, line in enumerate(chosen))
    if len(body.encode("utf-8")) > MAX_BYTES:
        body = body.encode("utf-8")[:MAX_BYTES].decode("utf-8", "ignore")
        body += "\n…（已截断）"
    total = len(lines)
    end = min(total, offset - 1 + len(chosen))
    return f"{path.name} 第 {offset}-{end} 行，共 {total} 行\n{body}"


def write_file(root: Path | None, arguments: dict) -> str:
    path = resolve_inside(root, str(arguments.get("path") or ""))
    content = arguments.get("content")
    if not isinstance(content, str):
        raise ToolError("content 必须是字符串。")
    if len(content.encode("utf-8")) > MAX_WRITE:
        raise ToolError("内容超过 1MB。")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8", newline="\n")
    return f"已写入 {path.name}，{content.count(chr(10)) + (0 if content.endswith(chr(10)) or not content else 1)} 行。"


def edit_file(root: Path | None, arguments: dict) -> str:
    path = resolve_inside(root, str(arguments.get("path") or ""))
    if not path.is_file():
        raise ToolError("文件不存在。")
    old = arguments.get("old_text")
    new = arguments.get("new_text")
    if not isinstance(old, str) or not old:
        raise ToolError("old_text 不能为空。")
    if not isinstance(new, str):
        raise ToolError("new_text 必须是字符串。")
    text = path.read_text(encoding="utf-8")
    count = text.count(old)
    if count == 0:
        raise ToolError("没有找到 old_text。")
    if count > 1:
        raise ToolError(f"old_text 出现了 {count} 次，需要唯一匹配。")
    updated = text.replace(old, new, 1)
    if len(updated.encode("utf-8")) > MAX_WRITE:
        raise ToolError("替换后的内容超过 1MB。")
    path.write_text(updated, encoding="utf-8", newline="\n")
    diff = "".join(difflib.unified_diff(
        old.splitlines(keepends=True), new.splitlines(keepends=True), n=2,
    ))
    return f"已修改 {path.name}\n{diff or '（内容已替换）'}"

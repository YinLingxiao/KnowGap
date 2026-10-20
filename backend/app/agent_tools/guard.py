from pathlib import Path


class ToolError(Exception):
    pass


def resolve_inside(root: Path | None, raw: str) -> Path:
    if root is None or not root.is_dir():
        raise ToolError("还没有工作区。请先在设置里选择一个文件夹。")
    if not isinstance(raw, str) or not raw.strip():
        raise ToolError("缺少路径。")
    base = root.resolve()
    candidate = Path(raw.strip())
    if not candidate.is_absolute():
        candidate = base / candidate
    try:
        path = candidate.resolve()
    except OSError as exc:
        raise ToolError(f"路径无效：{exc.strerror or exc}") from None
    if path != base and base not in path.parents:
        raise ToolError("路径超出工作区。")
    return path


# 17 条安全黑名单的实现放在 code_sandbox 里；这里再导出，方便其他工具统一从 guard 引用。
# blacklist.py 只依赖标准库和 code_sandbox.schemas，不会形成循环导入。
from app.code_sandbox.blacklist import DEFAULT_SECURITY_BLACKLIST, check_security_blacklist  # noqa: E402,F401

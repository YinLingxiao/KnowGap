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

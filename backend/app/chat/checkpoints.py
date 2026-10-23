"""Conservative resume policy. External effects and SQLite cannot commit atomically."""

# Only these tools are safe to repeat when a crash left their result uncertain.
READ_ONLY_TOOLS = {"read", "session_search", "exercise_reference"}
MAX_TOOL_ROUNDS = 16


def resume_state(checkpoint, status: str) -> tuple[bool, str | None]:
    if status != "failed" or not isinstance(checkpoint, dict) or checkpoint.get("version") != 1:
        return False, None
    if checkpoint.get("role") != "thread":
        return False, None
    if checkpoint.get("phase") not in {"model", "tools"}:
        return False, None
    if checkpoint.get("in_flight"):
        pending = checkpoint.get("pending", [])
        index = checkpoint.get("next_call", 0)
        name = pending[index].get("name") if 0 <= index < len(pending) else None
        if name not in READ_ONLY_TOOLS:
            return False, f"中断时 {name or '工具'} 的执行结果尚未保存，可能已经产生修改。请先核查文件或外部系统，不会自动重放。"
    if checkpoint.get("rounds", 0) >= MAX_TOOL_ROUNDS and checkpoint.get("phase") == "model":
        return False, "已达到本轮工具调用上限，请缩小任务后重新提问。"
    return True, None

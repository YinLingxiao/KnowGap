"""Short validation feedback for learner-facing forms, without rejected input."""

from fastapi.exceptions import RequestValidationError


_LABELS = {
    "q": "搜索内容", "limit": "结果数量", "name": "学习空间名称",
    "description": "学习空间描述", "instructions": "学习要求", "goal": "学习目标",
    "deadline": "截止日期", "deadline_date": "截止日期", "scheduled_date": "计划日期",
    "scheduled_start_at": "开始时间", "today": "当前日期", "title": "任务标题",
    "duration_minutes": "预计时长（分钟）", "reminder_minutes": "提醒时间（分钟）",
    "priority": "优先级", "labels": "标签", "children": "子任务",
}
_DATES = {"deadline", "deadline_date", "scheduled_date", "today"}


def validation_detail(exc: RequestValidationError) -> str:
    error = exc.errors()[0]
    field = next((part for part in reversed(error["loc"]) if part in _LABELS), None)
    label = _LABELS.get(field, "请求参数")
    kind = error["type"]
    bounds = error.get("ctx", {})
    if kind == "missing":
        return f"请填写{label}。"
    if field in _DATES:
        return f"{label}必须是有效日期（YYYY-MM-DD）。"
    if field == "scheduled_start_at":
        return "开始时间必须是有效日期和时间（YYYY-MM-DDTHH:MM）。"
    if kind == "string_too_short":
        return f"{label}不能为空。" if bounds["min_length"] == 1 else f"{label}至少需要 {bounds['min_length']} 个字符。"
    if kind == "string_too_long":
        return f"{label}不能超过 {bounds['max_length']} 个字符。"
    if kind == "greater_than_equal":
        return f"{label}不能小于 {bounds['ge']}。"
    if kind == "less_than_equal":
        return f"{label}不能大于 {bounds['le']}。"
    if kind in {"int_type", "int_parsing"}:
        return f"{label}必须是整数。"
    # Never forward Pydantic's msg/input: both may contain English or user data.
    return f"{label}格式无效，请检查后重试。"

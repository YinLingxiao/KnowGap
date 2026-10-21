"""回复结束后最多两个下一步。没有把握就空着。"""

PRACTICE_WORDS = ("练习", "做题", "考考", "小题", "自测", "演练", "测验")
ALLOWED = ("quiz", "schedule", "save_note", "weak_points")


def explained(reply: str) -> bool:
    text = " ".join((reply or "").split())
    if len(text) < 80:
        return False
    if text.count("？") + text.count("?") >= 3 and len(text) < 180:
        return False
    return True


def next_needs_practice(plan: dict | None) -> bool:
    if not plan or plan.get("completed_at"):
        return False
    for step in plan.get("steps") or []:
        if step.get("status") in {"done", "skipped"}:
            continue
        if step.get("status") == "awaiting_learner":
            return True
        blob = f"{step.get('title') or ''}{step.get('note') or ''}"
        return any(word in blob for word in PRACTICE_WORDS)
    return False


def just_completed(started: dict | None, after: dict | None) -> bool:
    if not isinstance(started, dict) or not after or not after.get("steps") or not after.get("completed_at"):
        return False
    return not started.get("completed_at")


def choose(*, reply: str, started: dict | None, after: dict | None, repeated: bool) -> list[str]:
    actions: list[str] = []
    if repeated:
        actions.append("weak_points")
    if explained(reply) and next_needs_practice(after) and len(actions) < 2:
        actions.append("quiz")
    if just_completed(started, after) and not actions:
        return ["schedule", "save_note"]
    return [item for item in actions if item in ALLOWED][:2]

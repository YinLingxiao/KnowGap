import asyncio
import json

from app.learning.schemas import DiagnoseOutput, PlanOutput, PlannedTaskCandidate, ReviewResult
from app.services.prompt.manager import get_prompt_manager, prompt_text

MODEL_TIMEOUT_SECONDS = 60


async def _complete_json(model, stage: str, payload: dict):
    prompts = get_prompt_manager().load_prompts("learning", stage, "zh")
    return await asyncio.wait_for(model.complete_json([
        {"role": "system", "content": prompt_text(prompts)},
        {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
    ]), timeout=MODEL_TIMEOUT_SECONDS)


async def diagnose(model, payload: dict) -> DiagnoseOutput:
    raw = await _complete_json(model, "diagnose", payload)
    if not isinstance(raw, dict) or not isinstance(raw.get("weak_points"), list):
        raise ValueError("invalid diagnose response")
    return DiagnoseOutput.model_validate(raw)


async def plan(model, payload: dict) -> PlanOutput:
    raw = await _complete_json(model, "plan", payload)
    if not isinstance(raw, dict) or not isinstance(raw.get("tasks"), list):
        raise ValueError("invalid plan response")
    candidates = []
    orders = set()
    for item in raw["tasks"]:
        if not isinstance(item, dict):
            raise ValueError("invalid planned task")
        order = item.get("order")
        if type(order) is not int or order < 1 or order in orders:
            raise ValueError("invalid planned task order")
        orders.add(order)
        candidates.append(PlannedTaskCandidate(
            draft_task_id="",
            title=item.get("title"),
            memory_id=item.get("memory_id"),
            evidence=item.get("evidence"),
            duration_minutes=item.get("duration_minutes"),
            scheduled_date=item.get("scheduled_date"),
            order=order,
        ))
    return PlanOutput(tasks=candidates)


async def review(model, payload: dict, candidates: list[PlannedTaskCandidate]) -> ReviewResult:
    raw = await _complete_json(model, "review", payload)
    if not isinstance(raw, dict):
        raise ValueError("invalid review response")
    result = ReviewResult.model_validate(raw)
    by_id = {candidate.draft_task_id: candidate for candidate in candidates}
    approved = result.approved
    rejected_ids = [item.draft_task_id for item in result.rejected]
    if len(approved) != len(set(approved)) or len(rejected_ids) != len(set(rejected_ids)):
        raise ValueError("duplicate review task id")
    if set(approved) & set(rejected_ids):
        raise ValueError("review task id appears in approved and rejected")
    if any(task_id not in by_id for task_id in [*approved, *rejected_ids]):
        raise ValueError("unknown review task id")
    total_minutes = 0
    for task_id in approved:
        duration = by_id[task_id].duration_minutes
        if type(duration) is not int:
            raise ValueError("invalid approved task duration")
        total_minutes += duration
    if result.total_minutes != total_minutes:
        raise ValueError("inconsistent review total_minutes")
    return result
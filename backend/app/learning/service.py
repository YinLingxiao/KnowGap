import asyncio
import json
import logging
from datetime import date, datetime, timezone

from fastapi import HTTPException

from app.agenda import store as agenda_store
from app.learning import agents
from app.learning.schemas import (
    DiagnoseAgentRun,
    DiagnoseOutput,
    LearningAgendaTask,
    LearningContextSnapshot,
    LearningDraftTask,
    LearningPlanConfirmRequest,
    LearningPlanConfirmResponse,
    LearningPlanDraftRequest,
    LearningPlanDraftResponse,
    LearningSkippedTask,
    MemoryEvidenceSnapshot,
    MemorySnapshot,
    PlanAgentRun,
    PlanOutput,
    PlannedTaskCandidate,
    RejectedTask,
    ReviewAgentRun,
    ReviewResult,
    WeakPoint,
)
from app.memory.store import new_id, now

logger = logging.getLogger(__name__)


def ensure(store):
    with store.connection() as db:
        db.executescript("""
            CREATE TABLE IF NOT EXISTS learning_plan_drafts (
                draft_id TEXT PRIMARY KEY,
                student_id TEXT NOT NULL,
                subject_id TEXT NOT NULL,
                today TEXT NOT NULL,
                deadline TEXT NOT NULL,
                budget_minutes INTEGER NOT NULL,
                agents_json TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS learning_plan_drafts_student
                ON learning_plan_drafts(student_id, created_at);
            CREATE TABLE IF NOT EXISTS learning_plan_draft_tasks (
                draft_id TEXT NOT NULL REFERENCES learning_plan_drafts(draft_id) ON DELETE CASCADE,
                draft_task_id TEXT NOT NULL,
                title TEXT NOT NULL,
                memory_id TEXT NOT NULL,
                evidence TEXT NOT NULL,
                duration_minutes INTEGER NOT NULL,
                scheduled_date TEXT NOT NULL,
                task_order INTEGER NOT NULL,
                confirmed_task_id TEXT,
                PRIMARY KEY(draft_id, draft_task_id),
                UNIQUE(draft_id, task_order)
            );
        """)


def read_snapshot(store, student: str, body: LearningPlanDraftRequest) -> LearningContextSnapshot:
    with store.connection() as db:
        subject = db.execute(
            "SELECT s.id AS subject_id, s.name AS subject_name FROM subjects s "
            "WHERE s.id=? AND s.student_id=?",
            (body.subject_id, student),
        ).fetchone()
        if subject is None:
            raise HTTPException(422, "subject_id 不属于当前学生")
        rows = db.execute("""
            SELECT m.id AS memory_id, m.topic AS memory_topic, m.summary AS memory_summary,
                   m.status AS memory_status, m.updated_at AS memory_updated_at,
                   e.id AS evidence_id, e.quote AS evidence_quote, e.reason AS evidence_reason,
                   e.signal AS evidence_signal, e.source AS evidence_source,
                   e.created_at AS evidence_created_at
            FROM learner_memories m
            LEFT JOIN learner_memory_evidence e ON e.memory_id=m.id
            WHERE m.student_id=? AND m.subject_id=? AND m.kind='misconception' AND m.status!='resolved'
            ORDER BY m.updated_at DESC, m.id, e.id
        """, (student, body.subject_id)).fetchall()
    memories = {}
    for row in rows:
        memory_id = row["memory_id"]
        if memory_id not in memories:
            memories[memory_id] = MemorySnapshot(
                memory_id=memory_id,
                topic=row["memory_topic"],
                summary=row["memory_summary"],
                status=row["memory_status"],
            )
        if row["evidence_id"] is not None:
            memories[memory_id].evidence.append(MemoryEvidenceSnapshot(
                quote=row["evidence_quote"],
                reason=row["evidence_reason"],
                signal=row["evidence_signal"],
                source=row["evidence_source"] or "message_quote",
                created_at=row["evidence_created_at"],
            ))
    return LearningContextSnapshot(
        student_id=student,
        subject_id=subject["subject_id"],
        subject_name=subject["subject_name"],
        today=date.today().isoformat(),
        deadline=body.deadline,
        budget_minutes=body.budget_minutes,
        memories=list(memories.values()),
    )


def _log(agent: str, event: str, status: str, draft_id: str, error_type: str | None = None):
    suffix = f" error_type={error_type}" if error_type else ""
    logger.info(
        "learning_plan agent=%s event=%s status=%s draft_id=%s%s",
        agent, event, status, draft_id, suffix,
    )


async def _run_stage(agent: str, draft_id: str, operation, fallback=None):
    started_at = datetime.now(timezone.utc)
    _log(agent, "start", "running", draft_id)
    try:
        output = await operation()
    except Exception as exc:
        if fallback is None:
            _log(agent, "end", "failed", draft_id, type(exc).__name__)
            raise
        output = fallback()
        finished_at = datetime.now(timezone.utc)
        _log(agent, "end", "rule_fallback", draft_id, type(exc).__name__)
        return output, started_at, finished_at
    except BaseException as exc:
        _log(agent, "end", "failed", draft_id, type(exc).__name__)
        raise
    finished_at = datetime.now(timezone.utc)
    _log(agent, "end", "success", draft_id)
    return output, started_at, finished_at


def _normalize_diagnosis(output: DiagnoseOutput, snapshot: LearningContextSnapshot) -> DiagnoseOutput:
    by_id = {memory.memory_id: memory for memory in snapshot.memories}
    seen = set()
    weak_points = []
    for item in output.weak_points:
        memory = by_id.get(item.memory_id)
        if memory is None:
            raise ValueError("diagnose references unknown memory")
        if item.due is not None and not snapshot.today <= item.due <= snapshot.deadline:
            raise ValueError("diagnose due out of range")
        if item.memory_id in seen:
            continue
        seen.add(item.memory_id)
        weak_points.append(WeakPoint(
            memory_id=item.memory_id,
            topic=memory.topic,
            summary=memory.summary,
            due=item.due,
            priority=item.priority,
        ))
    return DiagnoseOutput(weak_points=weak_points)


def _normalize_plan(output: PlanOutput, diagnosed: DiagnoseOutput) -> PlanOutput:
    weak_by_id = {item.memory_id: item for item in diagnosed.weak_points}
    identified = []
    for candidate in output.tasks:
        weak_point = weak_by_id.get(candidate.memory_id) if isinstance(candidate.memory_id, str) else None
        identified.append((candidate.model_copy(update={"draft_task_id": new_id("learning-task")}), weak_point))
    identified.sort(key=lambda pair: (
        pair[1] is None or pair[1].due is None,
        pair[1].due if pair[1] is not None and pair[1].due is not None else "",
        pair[1].priority if pair[1] is not None else 4,
        pair[0].order,
        pair[0].draft_task_id,
    ))
    return PlanOutput(tasks=[
        candidate.model_copy(update={"order": order})
        for order, (candidate, _) in enumerate(identified, start=1)
    ])


def _evidence_valid(candidate: PlannedTaskCandidate, selected_ids: set[str]) -> bool:
    memory_id = candidate.memory_id
    evidence = candidate.evidence
    if not isinstance(memory_id, str) or not memory_id.strip() or memory_id not in selected_ids:
        return False
    if not isinstance(evidence, str) or not evidence.strip():
        return False
    marker = f"memory_id={memory_id}"
    marker_at = evidence.find(marker)
    if marker_at < 0:
        return False
    tail = evidence[marker_at + len(marker):]
    if tail and tail[0] not in "；;：: \t\r\n":
        return False
    return bool(tail.strip().lstrip("；;：:").strip())


def review_by_rules(
    snapshot: LearningContextSnapshot,
    diagnosed: DiagnoseOutput,
    planned: PlanOutput,
) -> tuple[ReviewResult, list[LearningDraftTask]]:
    rejected = []
    eligible = []
    selected_ids = {item.memory_id for item in diagnosed.weak_points}

    def reject(candidate, code, message):
        rejected.append(RejectedTask(draft_task_id=candidate.draft_task_id, code=code, message=message))

    for candidate in sorted(planned.tasks, key=lambda item: item.order):
        if not _evidence_valid(candidate, selected_ids):
            reject(candidate, "missing_evidence", "任务缺少可追溯的误区依据")
            continue
        if not isinstance(candidate.title, str) or not candidate.title.strip() or len(candidate.title) > 200:
            reject(candidate, "invalid_task", "任务标题无效")
            continue
        if type(candidate.duration_minutes) is not int or not 5 <= candidate.duration_minutes <= 120:
            reject(candidate, "invalid_duration", "任务时长必须为 5 至 120 分钟的整数")
            continue
        eligible.append(candidate)

    unique = []
    seen = set()
    for candidate in eligible:
        if candidate.memory_id in seen:
            reject(candidate, "duplicate", "同一误区只保留最靠前的复习任务")
        else:
            seen.add(candidate.memory_id)
            unique.append(candidate)

    dated = []
    for candidate in unique:
        value = candidate.scheduled_date
        try:
            parsed = date.fromisoformat(value) if isinstance(value, str) else None
        except ValueError:
            parsed = None
        if parsed is None or parsed.isoformat() != value or not snapshot.today <= value <= snapshot.deadline:
            reject(candidate, "date_out_of_range", "任务日期必须在今天与截止日期之间")
        else:
            dated.append(candidate)

    approved_tasks = []
    total_minutes = 0
    over_budget = False
    for candidate in dated:
        if over_budget or total_minutes + candidate.duration_minutes > min(snapshot.budget_minutes, 120):
            reject(candidate, "over_budget", "任务超出本次复习总时长预算")
            over_budget = True
            continue
        task = LearningDraftTask(
            draft_task_id=candidate.draft_task_id,
            title=candidate.title,
            memory_id=candidate.memory_id,
            evidence=candidate.evidence,
            duration_minutes=candidate.duration_minutes,
            scheduled_date=candidate.scheduled_date,
            order=candidate.order,
        )
        approved_tasks.append(task)
        total_minutes += task.duration_minutes
    result = ReviewResult(
        approved=[task.draft_task_id for task in approved_tasks],
        rejected=rejected,
        total_minutes=total_minutes,
    )
    return result, approved_tasks


def _merge_review(rule_result: ReviewResult, rule_tasks: list[LearningDraftTask], suggestion: ReviewResult):
    rejected_by_id = {item.draft_task_id: item for item in suggestion.rejected}
    approved_ids = {task_id for task_id in rule_result.approved if task_id not in rejected_by_id}
    tasks = [task for task in rule_tasks if task.draft_task_id in approved_ids]
    additional = [rejected_by_id[task.draft_task_id] for task in rule_tasks if task.draft_task_id not in approved_ids]
    return ReviewResult(
        approved=[task.draft_task_id for task in tasks],
        rejected=[*rule_result.rejected, *additional],
        total_minutes=sum(task.duration_minutes for task in tasks),
    ), tasks


async def build_draft(model, snapshot: LearningContextSnapshot, draft_id: str) -> LearningPlanDraftResponse:
    memory_payload = [memory.model_dump() for memory in snapshot.memories]
    request_payload = {
        "subject": {"subject_id": snapshot.subject_id, "name": snapshot.subject_name},
        "today": snapshot.today,
        "deadline": snapshot.deadline,
        "budget_minutes": snapshot.budget_minutes,
    }

    async def run_diagnose():
        output = await agents.diagnose(model, {**request_payload, "memories": memory_payload})
        return _normalize_diagnosis(output, snapshot)

    try:
        diagnosed, diagnose_started, diagnose_finished = await _run_stage("diagnose", draft_id, run_diagnose)
    except Exception as exc:
        raise HTTPException(503, "AI 复习诊断暂不可用或响应无效，请稍后重试。") from exc

    selected_ids = {item.memory_id for item in diagnosed.weak_points}
    plan_payload = {
        **request_payload,
        "weak_points": [item.model_dump() for item in diagnosed.weak_points],
        "memories": [memory.model_dump() for memory in snapshot.memories if memory.memory_id in selected_ids],
    }

    async def run_plan():
        output = await agents.plan(model, plan_payload)
        return _normalize_plan(output, diagnosed)

    try:
        planned, plan_started, plan_finished = await _run_stage("plan", draft_id, run_plan)
    except Exception as exc:
        raise HTTPException(503, "AI 复习规划暂不可用或响应无效，请稍后重试。") from exc

    rule_result, rule_tasks = review_by_rules(snapshot, diagnosed, planned)
    review_payload = {
        **request_payload,
        "tasks": [item.model_dump() for item in planned.tasks],
        "rule_result": rule_result.model_dump(),
    }

    async def run_review():
        suggestion = await agents.review(model, review_payload, planned.tasks)
        return _merge_review(rule_result, rule_tasks, suggestion)

    merged, review_started, review_finished = await _run_stage(
        "review", draft_id, run_review, fallback=lambda: (rule_result, rule_tasks),
    )
    review_result, tasks = merged
    return LearningPlanDraftResponse(
        draft_id=draft_id,
        tasks=tasks,
        agents=[
            DiagnoseAgentRun(started_at=diagnose_started, finished_at=diagnose_finished, output=diagnosed),
            PlanAgentRun(started_at=plan_started, finished_at=plan_finished, output=planned),
            ReviewAgentRun(started_at=review_started, finished_at=review_finished, output=review_result),
        ],
    )


def save_draft(store, snapshot: LearningContextSnapshot, response: LearningPlanDraftResponse):
    agents_json = json.dumps(
        [run.model_dump(mode="json") for run in response.agents], ensure_ascii=False,
    )
    with store.connection() as db:
        db.execute("BEGIN IMMEDIATE")
        db.execute(
            "INSERT INTO learning_plan_drafts "
            "(draft_id,student_id,subject_id,today,deadline,budget_minutes,agents_json,created_at) "
            "VALUES (?,?,?,?,?,?,?,?)",
            (
                response.draft_id, snapshot.student_id, snapshot.subject_id, snapshot.today,
                snapshot.deadline, snapshot.budget_minutes, agents_json, now(),
            ),
        )
        for task in response.tasks:
            db.execute(
                "INSERT INTO learning_plan_draft_tasks "
                "(draft_id,draft_task_id,title,memory_id,evidence,duration_minutes,scheduled_date,task_order) "
                "VALUES (?,?,?,?,?,?,?,?)",
                (
                    response.draft_id, task.draft_task_id, task.title, task.memory_id, task.evidence,
                    task.duration_minutes, task.scheduled_date, task.order,
                ),
            )


def confirm_draft(
    store,
    student: str,
    draft_id: str,
    body: LearningPlanConfirmRequest,
) -> LearningPlanConfirmResponse:
    ensure(store)
    agenda_store.ensure(store)
    with store.connection() as db:
        db.execute("BEGIN IMMEDIATE")
        draft = db.execute(
            "SELECT d.draft_id AS draft_id, d.subject_id AS subject_id "
            "FROM learning_plan_drafts d WHERE d.draft_id=? AND d.student_id=?",
            (draft_id, student),
        ).fetchone()
        if draft is None:
            raise HTTPException(404, "复习计划草稿不存在")
        rows = db.execute("""
            SELECT t.draft_task_id AS draft_task_id, t.title AS title,
                   t.memory_id AS memory_id, t.evidence AS evidence,
                   t.duration_minutes AS duration_minutes, t.scheduled_date AS scheduled_date,
                   t.task_order AS task_order, t.confirmed_task_id AS confirmed_task_id
            FROM learning_plan_draft_tasks t WHERE t.draft_id=? ORDER BY t.task_order
        """, (draft_id,)).fetchall()
        by_id = {row["draft_task_id"]: row for row in rows}
        selected = list(dict.fromkeys(body.task_ids))
        if any(task_id in by_id and by_id[task_id]["confirmed_task_id"] is None for task_id in selected):
            agenda_store.references(db, student, {"subject_id": draft["subject_id"]})
        created_with_order = []
        skipped = []
        for task_id in selected:
            row = by_id.get(task_id)
            if row is None:
                skipped.append(LearningSkippedTask(
                    draft_task_id=task_id, code="not_approved", message="该任务不在可确认的草稿任务中",
                ))
                continue
            if row["confirmed_task_id"] is not None:
                skipped.append(LearningSkippedTask(
                    draft_task_id=task_id, code="already_confirmed", message="该任务已经写入日程",
                ))
                continue
            created = agenda_store.insert(db, student, {
                "title": row["title"],
                "notes": row["evidence"],
                "subject_id": draft["subject_id"],
                "scheduled_date": row["scheduled_date"],
                "duration_minutes": row["duration_minutes"],
                "memory_id": row["memory_id"],
                "source": "learning_agent",
                "review_step": None,
            })
            db.execute(
                "UPDATE learning_plan_draft_tasks SET confirmed_task_id=? "
                "WHERE draft_id=? AND draft_task_id=?",
                (created["id"], draft_id, task_id),
            )
            public_task = {key: created[key] for key in LearningAgendaTask.model_fields}
            created_with_order.append((row["task_order"], LearningAgendaTask.model_validate(public_task)))
    return LearningPlanConfirmResponse(
        created=[task for _, task in sorted(created_with_order, key=lambda item: item[0])],
        skipped=skipped,
    )
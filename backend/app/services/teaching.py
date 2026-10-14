"""Coordinates curated references, relevant memory and model-backed teaching."""

from fastapi import HTTPException

from app.agents.llm import Tutor, validate_evidence
from app.memory.store import Store
from app.models.schemas import DiagnosisRequest, Session, TeachingResponse
from app.services.problems import PROBLEMS, reference_for
from app.services.reference_guard import validate_initial_conclusion

MAX_TURNS = 40


async def teach(
    store: Store, tutor: Tutor, request: DiagnosisRequest, session: Session | None = None,
) -> TeachingResponse:
    problem = PROBLEMS.get(request.problem_id)
    if problem is None:
        raise HTTPException(404, "题目不存在，请重新选择。")
    if session and session.turn >= MAX_TURNS:
        raise HTTPException(409, "当前演示会话已达到 40 轮，请开启新会话。")
    relevant = store.memories(request.student_id, problem.topic_key)[:3]
    reference = reference_for(problem)
    context = {
        "phase": "tutoring" if session else "initial",
        "turn": (session.turn if session else 0) + 1,
        "problem": problem.model_dump(), "reference": reference,
        "current_answer": request.answer,
        "history": [m.model_dump(include={"role", "content"}) for m in session.messages[-12:]] if session else [],
        "related_memories": [
            {**m.model_dump(exclude={"evidence_refs", "student_id"}),
             "evidence_refs": [e.model_dump() for e in m.evidence_refs[-3:]]}
            for m in relevant
        ],
    }
    result = await tutor.generate(context)
    validate_evidence(result, request.answer)
    if session is None:
        validate_initial_conclusion(result, request.answer, reference["possible"])
    return store.save_turn(
        student_id=request.student_id, problem_id=problem.id, topic_key=problem.topic_key,
        answer=request.answer, result=result, used_memory_ids=[m.id for m in relevant], session=session,
    )

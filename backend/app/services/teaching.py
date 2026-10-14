"""Coordinates curated references, relevant memory and model-backed teaching."""

import re

from fastapi import HTTPException

from app.agents.llm import Tutor, validate_evidence
from app.memory.store import Store
from app.models.schemas import DiagnosisRequest, Session, TeachingResponse
from app.services.problems import PROBLEMS, reference_for
from app.services.reference_guard import validate_initial_conclusion
from app.services.materials import MaterialStore
from app.agents.llm import ProviderError

MAX_TURNS = 40


async def teach(
    store: Store, tutor: Tutor, request: DiagnosisRequest, session: Session | None = None,
    library: MaterialStore | None = None,
) -> TeachingResponse:
    problem = PROBLEMS.get(request.problem_id)
    if problem is None:
        raise HTTPException(404, "题目不存在，请重新选择。")
    if session and session.turn >= MAX_TURNS:
        raise HTTPException(409, "当前演示会话已达到 40 轮，请开启新会话。")
    relevant = store.memories(request.student_id, problem.topic_key)[:3]
    reference = reference_for(problem)
    sources = library.search(request.student_id, '栈 LIFO 后进先出', 3) if library else []
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
        "course_sources": [source.model_dump() for source in sources],
    }
    result = await tutor.generate(context)
    validate_evidence(result, request.answer)
    by_id = {source.id: source for source in sources}
    if any(source_id not in by_id for source_id in result.citation_ids):
        raise ProviderError(502, '模型引用了不存在的资料，请重试；本次作答尚未保存。')
    cited = [by_id[source_id] for source_id in dict.fromkeys(result.citation_ids)]
    mentioned = set(re.findall(r'\[(资料\d+)\]', result.reply))
    if not mentioned.issubset({source.label for source in cited}):
        raise ProviderError(502, '模型引用标注与资料不一致，请重试；本次作答尚未保存。')
    if session is None:
        validate_initial_conclusion(result, request.answer, reference["possible"])
    return store.save_turn(
        student_id=request.student_id, problem_id=problem.id, topic_key=problem.topic_key,
        answer=request.answer, result=result, used_memory_ids=[m.id for m in relevant], session=session, sources=cited,
    )

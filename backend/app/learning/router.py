from fastapi import APIRouter

from app.auth.deps import current_student
from app.learning.schemas import (
    LearningPlanConfirmRequest,
    LearningPlanConfirmResponse,
    LearningPlanDraftRequest,
    LearningPlanDraftResponse,
)
from app.learning.service import build_draft, confirm_draft, ensure, read_snapshot, save_draft
from app.memory.store import new_id


def learning_router(chat_store, model):
    router = APIRouter(prefix="/api/learning", tags=["learning"])

    @router.post("/plans/draft", response_model=LearningPlanDraftResponse)
    async def create_draft(body: LearningPlanDraftRequest):
        student = current_student()
        ensure(chat_store)
        snapshot = read_snapshot(chat_store, student, body)
        response = await build_draft(model, snapshot, new_id("learning-draft"))
        save_draft(chat_store, snapshot, response)
        return response

    @router.post("/plans/{draft_id}/confirm", response_model=LearningPlanConfirmResponse)
    def confirm(draft_id: str, body: LearningPlanConfirmRequest):
        return confirm_draft(chat_store, current_student(), draft_id, body)

    return router
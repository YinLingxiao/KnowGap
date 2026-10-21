"""Learner-operated plan endpoints. Edits remain available during generation."""

from typing import Literal

from fastapi import APIRouter, HTTPException

from app.auth.deps import current_student
from app.chat.plan import PlanStore
from app.chat.schemas import StrictModel, Title


class AddStep(StrictModel):
    title: Title


class PatchStep(StrictModel):
    title: Title | None = None
    status: Literal["done", "skipped", "pending"] | None = None


def plan_router(store):
    router = APIRouter(prefix="/api/conversations", tags=["学习计划"])
    plans = PlanStore(store)

    def call(operation, *args, **kwargs):
        try:
            return operation(*args, **kwargs)
        except LookupError as exc:
            raise HTTPException(404, str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc

    @router.get("/{conversation_id}/plan")
    def get_plan(conversation_id: str):
        return call(plans.read, conversation_id, current_student())

    @router.post("/{conversation_id}/plan/steps")
    def add_step(conversation_id: str, body: AddStep):
        return call(plans.user_action, conversation_id, current_student(), "add", title=body.title)

    @router.patch("/{conversation_id}/plan/steps/{step_id}")
    def patch_step(conversation_id: str, step_id: str, body: PatchStep):
        return call(plans.user_action, conversation_id, current_student(), "patch", step_id,
                    title=body.title, status=body.status)

    @router.delete("/{conversation_id}/plan/steps/{step_id}")
    def delete_step(conversation_id: str, step_id: str):
        return call(plans.user_action, conversation_id, current_student(), "delete", step_id)

    @router.delete("/{conversation_id}/plan")
    def clear_plan(conversation_id: str):
        return call(plans.user_action, conversation_id, current_student(), "clear")

    return router

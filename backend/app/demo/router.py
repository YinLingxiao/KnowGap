"""当前学生的演示数据导入与清除。"""

from fastapi import APIRouter, HTTPException

from app.auth.deps import current_student
from app.chat.store import ChatStore
from app.demo.seed import DS_NAME, reset_store, seed_store


def demo_router(store: ChatStore) -> APIRouter:
    router = APIRouter(prefix="/api/demo", tags=["演示数据"])

    @router.post("/seed")
    def seed_demo():
        student_id = current_student()
        seed_store(store, student_id)
        subject = next((item for item in store.subjects(student_id) if item.name == DS_NAME), None)
        if subject is None:
            raise HTTPException(500, "演示空间没有写好。")
        return {
            "subject_id": subject.id,
            "conversation_id": subject.main_conversation_id,
            "name": subject.name,
        }

    @router.delete("/seed")
    def clear_demo():
        reset_store(store, current_student())
        return {"status": "reset"}

    return router

from fastapi.testclient import TestClient

from app.agenda.store import ensure as ensure_agenda
from app.demo.seed import seed_store
from app.main import create_app
from app.models.schemas import DEMO_STUDENT
from tests.test_acceptance_support import isolated_settings
from tests.test_chat import FakeChat


def test_checklist_uses_real_records_and_ignores_other_students(tmp_path):
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=FakeChat())) as client:
        assert client.get("/api/onboarding/checklist").json() == {
            "space": False, "explained": False, "answered": False, "scheduled": False,
        }
        store = client.app.state.chat_service.store
        conversation = client.post("/api/conversations", json={}).json()
        user_id = store.add_user_message(conversation["id"], "讲一下栈", "req-check-1")
        reply_id = store.start_reply(conversation["id"], user_id, [])
        store.finish_reply(reply_id, content="栈是后进先出。" * 20, status="complete")
        assert client.get("/api/onboarding/checklist").json()["explained"] is True
        store.merge_meta(user_id, {"attempt": {"assessment": "correct", "problem_id": "p", "evidence": "后进先出"}})
        assert client.get("/api/onboarding/checklist").json()["answered"] is True
        ensure_agenda(store)
        with store.connection() as db:
            db.execute(
                "INSERT INTO agenda_tasks(id, student_id, title, source, created_at, updated_at) VALUES (?, ?, ?, 'ai_breakdown', 't', 't')",
                ("task-check", DEMO_STUDENT, "复习"),
            )
            db.execute(
                "INSERT INTO agenda_tasks(id, student_id, title, source, created_at, updated_at) VALUES (?, ?, ?, 'ai_breakdown', 't', 't')",
                ("task-other", "other-student", "别人的复习"),
            )
        body = client.get("/api/onboarding/checklist").json()
        assert body["scheduled"] is True and "focused" not in body
        with store.connection() as db:
            db.execute("DELETE FROM agenda_tasks WHERE student_id = ?", (DEMO_STUDENT,))
        cleared = client.get("/api/onboarding/checklist").json()
        assert cleared["scheduled"] is False


def test_checklist_ignores_seeded_demo_data_but_counts_real_work_in_it(tmp_path):
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=FakeChat())) as client:
        store = client.app.state.chat_service.store
        seed_store(store, DEMO_STUDENT)
        assert client.get("/api/onboarding/checklist").json() == {
            "space": False, "explained": False, "answered": False, "scheduled": False,
        }
        # 在演示空间里真实发生的一轮讲解算学生自己的
        demo_space = store.subjects(DEMO_STUDENT)[0]
        user_id = store.add_user_message(demo_space.main_conversation_id, "再讲一遍循环队列", "req-own-1")
        reply_id = store.start_reply(demo_space.main_conversation_id, user_id, [])
        store.finish_reply(reply_id, content="循环队列用取模让队尾绕回数组开头。" * 8, status="complete")
        body = client.get("/api/onboarding/checklist").json()
        assert body["explained"] is True and body["space"] is False
        created = client.post("/api/subjects", json={"name": "线性代数"})
        assert created.status_code in (200, 201)
        assert client.get("/api/onboarding/checklist").json()["space"] is True

from fastapi.testclient import TestClient

from app.agenda.store import ensure as ensure_agenda
from app.focus.store import FocusStore
from app.main import create_app
from app.models.schemas import DEMO_STUDENT
from tests.test_acceptance_support import isolated_settings
from tests.test_chat import FakeChat


def test_checklist_uses_real_records_and_ignores_other_students(tmp_path):
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=FakeChat())) as client:
        assert client.get("/api/onboarding/checklist").json() == {
            "explained": False, "answered": False, "scheduled": False, "focused": False,
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
        FocusStore(store.store).ensure()
        with store.connection() as db:
            db.execute(
                "INSERT INTO agenda_tasks(id, student_id, title, source, created_at, updated_at) VALUES (?, ?, ?, 'ai_breakdown', 't', 't')",
                ("task-check", DEMO_STUDENT, "复习"),
            )
            db.execute(
                "INSERT INTO agenda_tasks(id, student_id, title, source, created_at, updated_at) VALUES (?, ?, ?, 'ai_breakdown', 't', 't')",
                ("task-other", "other-student", "别人的复习"),
            )
            db.execute(
                "INSERT INTO focus_sessions(id, student_id, title, planned_minutes, started_at, status) "
                "VALUES ('focus-check', ?, '专注', 25, 't', 'completed')",
                (DEMO_STUDENT,),
            )
        body = client.get("/api/onboarding/checklist").json()
        assert body["scheduled"] is True and body["focused"] is True
        with store.connection() as db:
            db.execute("DELETE FROM agenda_tasks WHERE student_id = ?", (DEMO_STUDENT,))
            db.execute("DELETE FROM focus_sessions WHERE student_id = ?", (DEMO_STUDENT,))
        cleared = client.get("/api/onboarding/checklist").json()
        assert cleared["scheduled"] is False and cleared["focused"] is False

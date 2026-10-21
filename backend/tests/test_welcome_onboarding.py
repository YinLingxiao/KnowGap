from fastapi.testclient import TestClient

from app.main import create_app
from tests.test_acceptance_support import isolated_settings
from tests.test_chat import FakeChat


def test_welcome_falls_back_to_the_original_words_when_the_model_is_useless(tmp_path):
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=FakeChat())) as client:
        assert client.get("/api/onboarding").json()["status"] == "not_started"
        body = client.post("/api/onboarding/welcome", json={"text": "数据结构 · 期末"}).json()
        assert body["name"] == "数据结构 · 期末"
        assert body["goal"] == "数据结构 · 期末"
        assert body["opener"] == "我在学数据结构 · 期末，先用一个具体例子带我入门第一个概念"
        assert client.get("/api/onboarding").json()["status"] == "completed"
        subjects = client.get("/api/subjects").json()
        assert subjects[0]["id"] == body["subject_id"]
        assert subjects[0]["main_conversation_id"] == body["conversation_id"]


def test_welcome_keeps_a_name_only_when_it_is_a_span_of_the_answer(tmp_path):
    model = FakeChat(analyses=[{"name": "数据结构", "goal": "期末考过栈和队列"},
                               {"name": "量子场论", "goal": "编出来的"}])
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=model)) as client:
        kept = client.post("/api/onboarding/welcome", json={"text": "数据结构 · 期末"}).json()
        assert kept["name"] == "数据结构" and kept["goal"] == "期末考过栈和队列"
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=FakeChat(
        analyses=[{"name": "量子场论", "goal": "编出来的"}],
    ))) as client:
        rejected = client.post("/api/onboarding/welcome", json={"text": "电路原理"}).json()
        assert rejected["name"] == "电路原理"
        assert "量子场论" not in rejected["goal"]


def test_welcome_survives_a_model_failure(tmp_path):
    class Down(FakeChat):
        async def complete_json(self, messages):
            raise RuntimeError("offline")
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=Down())) as client:
        body = client.post("/api/onboarding/welcome", json={"text": "考研数学"}).json()
        assert body["name"] == "考研数学"
        assert client.get("/api/onboarding").json()["onboarded"] is True


def test_skip_and_preferences_do_not_require_the_interview(tmp_path):
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=FakeChat())) as client:
        assert client.post("/api/onboarding/skip").json()["status"] == "skipped"
        client.put("/api/agent-memory", json={"target": "user", "content": "已有背景"})
        saved = client.put("/api/onboarding/preferences", json={
            "background": "准备期末", "explanation": "先看例子", "interaction": "",
        }).json()
        assert saved == {"background": "准备期末", "explanation": "先看例子", "interaction": ""}
        notes = client.get("/api/agent-memory").json()["user"]
        assert "已有背景" in notes and "讲解偏好：先看例子" in notes and "互动偏好" not in notes
        assert client.get("/api/onboarding").json()["status"] == "skipped"


def test_ack_marks_completed_without_a_draft(tmp_path):
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=FakeChat())) as client:
        assert client.post("/api/onboarding/ack").json()["status"] == "completed"
        assert client.post("/api/onboarding/ack").json()["status"] == "completed"


def test_demo_seed_api_only_touches_the_current_student(tmp_path):
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=FakeChat())) as client:
        store = client.app.state.chat_service.store
        other = store.create_subject("other-student", "别人的课", "不要动", "")
        seeded = client.post("/api/demo/seed").json()
        assert seeded["name"] == "数据结构（演示）"
        names = [item["name"] for item in client.get("/api/subjects").json()]
        assert "数据结构（演示）" in names and "电路原理（演示）" in names
        assert store.subject(other.id, "other-student") is not None
        assert client.delete("/api/demo/seed").json()["status"] == "reset"
        names = [item["name"] for item in client.get("/api/subjects").json()]
        assert "数据结构（演示）" not in names and "电路原理（演示）" not in names
        assert store.subject(other.id, "other-student").name == "别人的课"

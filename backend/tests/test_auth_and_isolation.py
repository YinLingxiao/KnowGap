"""Single-user local binding and store-level student isolation tests."""

from fastapi.testclient import TestClient

from app.chat.store import ChatStore
from app.main import create_app
from tests.test_acceptance_support import isolated_settings
from tests.test_chat import FakeChat


def test_local_app_binds_without_login_and_isolates_foreign_student_records(tmp_path):
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=FakeChat(["回复A"]))) as client:
        store = ChatStore(client.app.state.store)
        foreign_space = store.create_subject("other-student", "别人微积分", "", "")
        foreign_conv = store.create_conversation("other-student", title="别人的对话", problem=None, client_request_id=None)
        store.save_agent_note("other-student", "user", "讲解偏好：仅属于别人")

        own_space = client.post("/api/subjects", json={"name": "我的微积分"}).json()
        own_conv = client.post("/api/conversations", json={"title": "我的对话"}).json()
        client.put("/api/agent-memory", json={"target": "user", "content": "讲解偏好：喜欢图像"})

        assert [s["id"] for s in client.get("/api/subjects").json()] == [own_space["id"]]
        assert [c["id"] for c in client.get("/api/conversations").json()] == [own_conv["id"]]
        assert "喜欢图像" in client.get("/api/agent-memory").json()["user"]
        assert "仅属于别人" not in client.get("/api/agent-memory").json()["user"]
        assert client.get(f"/api/conversations/{foreign_conv}").status_code == 404
        assert client.get(f"/api/subjects/{foreign_space.id}").status_code == 404

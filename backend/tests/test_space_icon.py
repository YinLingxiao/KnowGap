"""学习空间图标持久化、校验与默认值回退测试。"""

from fastapi.testclient import TestClient

from app.main import create_app
from tests.test_acceptance_support import isolated_settings
from tests.test_chat import FakeChat


def test_subject_icon_defaults_updates_and_validates(tmp_path):
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=FakeChat())) as client:
        default_space = client.post("/api/subjects", json={"name": "操作系统"}).json()
        assert default_space["icon"] == "graduation-cap"

        coded = client.post("/api/subjects", json={"name": "汇编语言", "icon": "code", "color": "#2e8a5c"}).json()
        assert coded["icon"] == "code" and coded["color"] == "#2e8a5c"

        patched = client.patch(f"/api/subjects/{coded['id']}", json={"icon": "cpu"}).json()
        assert patched["icon"] == "cpu"
        assert client.get(f"/api/subjects/{coded['id']}").json()["icon"] == "cpu"

        assert client.post("/api/subjects", json={"name": "非法图标", "icon": "not-an-icon"}).status_code == 422
        assert client.patch(f"/api/subjects/{coded['id']}", json={"icon": "bad"}).status_code == 422

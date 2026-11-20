"""本机单用户档案、头像上传校验、称呼同步 USER 与旧账号数据兼容迁移测试。"""

from fastapi.testclient import TestClient

from app.chat.store import ChatStore
from app.main import create_app
from app.memory.store import Store
from app.models.schemas import DEMO_STUDENT
from tests.test_acceptance_support import isolated_settings
from tests.test_chat import FakeChat

TINY_PNG = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
    b"\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\rIDATx\x9cc`\x00\x00"
    b"\x00\x02\x00\x01\xe2!\xbc3\x00\x00\x00\x00IEND\xaeB`\x82"
)


def test_local_profile_name_syncs_user_note_and_avatar_lifecycle(tmp_path):
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=FakeChat())) as client:
        res = client.get("/api/profile")
        assert res.status_code == 200
        body = res.json()
        assert body["user"]["id"] == DEMO_STUDENT
        assert body["user"]["display_name"] == "学习者"
        assert body["user"]["avatar_url"] == ""
        assert body["onboarding"]["status"] == "not_started"
        assert client.get("/api/profile/avatar").status_code == 404

        patched = client.patch("/api/profile", json={"display_name": "小陈"})
        assert patched.status_code == 200
        assert patched.json()["user"]["display_name"] == "小陈"
        assert patched.json()["user"]["avatar_text"] == "小"
        notes = client.get("/api/agent-memory").json()["user"]
        assert "[Identity] 称呼：小陈" in notes

        # 再次改名覆盖旧称呼，不重复追加
        patched2 = client.patch("/api/profile", json={"display_name": "陈同学"})
        assert patched2.status_code == 200
        notes2 = client.get("/api/agent-memory").json()["user"]
        assert "[Identity] 称呼：陈同学" in notes2
        assert "小陈" not in notes2

        # 拒绝非图片与超大文件
        assert client.post("/api/profile/avatar", files={"file": ("bad.txt", b"not-an-image")}).status_code == 422
        assert client.post("/api/profile/avatar", files={"file": ("big.png", TINY_PNG + b"0" * (2 * 1024 * 1024))}).status_code == 413

        # 上传有效头像并读取
        up = client.post("/api/profile/avatar", files={"file": ("me.png", TINY_PNG)})
        assert up.status_code == 200
        avatar_url = up.json()["user"]["avatar_url"]
        assert avatar_url.startswith("/api/profile/avatar?v=av-")
        got = client.get(avatar_url)
        assert got.status_code == 200 and got.headers["content-type"] == "image/png" and got.content == TINY_PNG

        # 清除头像
        cleared = client.delete("/api/profile/avatar")
        assert cleared.status_code == 200 and cleared.json()["user"]["avatar_url"] == ""
        assert client.get("/api/profile/avatar").status_code == 404


def test_legacy_registered_user_is_preserved_when_demo_has_no_data(tmp_path):
    settings = isolated_settings(tmp_path)
    store = Store(settings.resolved_database_path())
    store.initialize()
    chat_store = ChatStore(store)
    chat_store.initialize()
    with store.connection() as db:
        db.execute("""
            CREATE TABLE users (
                id TEXT PRIMARY KEY, username TEXT NOT NULL, display_name TEXT NOT NULL,
                password_hash TEXT NOT NULL, avatar_text TEXT NOT NULL DEFAULT '',
                provider TEXT NOT NULL DEFAULT 'email', provider_user_id TEXT NOT NULL DEFAULT '',
                avatar_url TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
            )
        """)
        db.execute(
            "INSERT INTO users VALUES ('usr_legacy', 'old@school.edu', '老用户', 'h', '老', 'email', '', '', '2026-01-01', '2026-01-02')"
        )
    conv_id = chat_store.create_conversation("usr_legacy", title="旧对话", problem=None, client_request_id=None)

    with TestClient(create_app(settings, chat_model=FakeChat())) as client:
        profile = client.get("/api/profile").json()["user"]
        assert profile["id"] == "usr_legacy"
        assert profile["display_name"] == "老用户"
        convs = client.get("/api/conversations").json()
        assert [c["id"] for c in convs] == [conv_id]


def test_name_changed_in_user_memory_flows_back_to_the_profile(tmp_path):
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=FakeChat())) as client:
        client.patch("/api/profile", json={"display_name": "小陈"})
        client.put("/api/agent-memory", json={"target": "user", "content": "[Identity] 称呼：阿林\n§\n讲解偏好：先举例"})
        user = client.get("/api/profile").json()["user"]
        assert user["display_name"] == "阿林" and user["avatar_text"] == "阿"
        # 记忆里删掉称呼不会清空档案名
        client.put("/api/agent-memory", json={"target": "user", "content": "讲解偏好：先举例"})
        assert client.get("/api/profile").json()["user"]["display_name"] == "阿林"

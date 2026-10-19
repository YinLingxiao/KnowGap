"""Email verification code, password authentication, session lifecycle, and multi-user isolation tests."""

from fastapi.testclient import TestClient

from app.main import create_app
from tests.test_acceptance_support import isolated_settings
from tests.test_chat import FakeChat


def auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_email_verification_code_register_and_login_flow(tmp_path):
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=FakeChat())) as client:
        # Invalid email format rejected with 422
        assert client.post("/api/auth/send-code", json={"email": "not-an-email", "purpose": "register"}).status_code == 422

        # Send registration verification code
        code_res = client.post("/api/auth/send-code", json={"email": "alice@example.com", "purpose": "register"})
        assert code_res.status_code == 200
        demo_code = code_res.json()["demo_code"]
        assert len(demo_code) == 6 and demo_code.isdigit()

        # Wrong verification code is rejected with 400
        wrong_code = "000000" if demo_code != "000000" else "999999"
        bad_reg = client.post(
            "/api/auth/register",
            json={"email": "alice@example.com", "password": "password123", "code": wrong_code, "display_name": "爱丽丝"},
        )
        assert bad_reg.status_code == 400

        # Correct verification code succeeds
        reg = client.post(
            "/api/auth/register",
            json={"email": "alice@example.com", "password": "password123", "code": demo_code, "display_name": "爱丽丝"},
        )
        assert reg.status_code == 201
        data = reg.json()
        token = data["token"]
        assert data["user"]["username"] == "alice@example.com"
        assert data["user"]["display_name"] == "爱丽丝"
        assert data["user"]["provider"] == "email"

        # Sending a register code for an already-registered email returns 409
        assert client.post("/api/auth/send-code", json={"email": "ALICE@EXAMPLE.COM", "purpose": "register"}).status_code == 409

        # Login with password works
        assert client.post("/api/auth/login", json={"email": "alice@example.com", "password": "password123"}).status_code == 200

        # Login with email verification code also works
        login_code = client.post("/api/auth/send-code", json={"email": "alice@example.com", "purpose": "login"}).json()["demo_code"]
        code_login = client.post("/api/auth/login", json={"email": "alice@example.com", "code": login_code})
        assert code_login.status_code == 200
        token2 = code_login.json()["token"]

        # One-time login code cannot be reused
        assert client.post("/api/auth/login", json={"email": "alice@example.com", "code": login_code}).status_code == 400

        # Update display name and password
        patched = client.patch(
            "/api/auth/me",
            headers=auth_headers(token2),
            json={"display_name": "Alice W", "current_password": "password123", "new_password": "newpassword456"},
        )
        assert patched.status_code == 200
        assert patched.json()["user"]["display_name"] == "Alice W"

        # Logout revokes the token
        assert client.post("/api/auth/logout", headers=auth_headers(token)).status_code == 204
        assert client.get("/api/auth/me", headers=auth_headers(token)).status_code == 401


def test_multi_user_isolation_across_conversations_spaces_and_memories(tmp_path):
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=FakeChat(["回复A", "回复B"]))) as client:
        c_alice = client.post("/api/auth/send-code", json={"email": "alice@school.edu", "purpose": "register"}).json()["demo_code"]
        c_bob = client.post("/api/auth/send-code", json={"email": "bob@school.edu", "purpose": "register"}).json()["demo_code"]
        alice = client.post(
            "/api/auth/register",
            json={"email": "alice@school.edu", "password": "password123", "code": c_alice, "display_name": "Alice"},
        ).json()
        bob = client.post(
            "/api/auth/register",
            json={"email": "bob@school.edu", "password": "password123", "code": c_bob, "display_name": "Bob"},
        ).json()
        h_alice = auth_headers(alice["token"])
        h_bob = auth_headers(bob["token"])

        # Alice creates a space, conversation, and USER note
        space_a = client.post("/api/subjects", headers=h_alice, json={"name": "Alice微积分"}).json()
        conv_a = client.post("/api/conversations", headers=h_alice, json={"title": "Alice的对话"}).json()
        client.put("/api/agent-memory", headers=h_alice, json={"target": "user", "content": "讲解偏好：Alice喜欢图像"})

        # Bob sees none of Alice's spaces, conversations, or USER notes
        assert client.get("/api/subjects", headers=h_bob).json() == []
        assert client.get("/api/conversations", headers=h_bob).json() == []
        assert client.get("/api/agent-memory", headers=h_bob).json()["user"] == ""
        assert client.get(f"/api/conversations/{conv_a['id']}", headers=h_bob).status_code == 404
        assert client.get(f"/api/subjects/{space_a['id']}", headers=h_bob).status_code == 404

        # Alice still sees all her own data
        assert len(client.get("/api/subjects", headers=h_alice).json()) == 1
        assert len(client.get("/api/conversations", headers=h_alice).json()) == 1
        assert "Alice喜欢图像" in client.get("/api/agent-memory", headers=h_alice).json()["user"]

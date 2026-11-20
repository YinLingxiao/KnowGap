"""自然语言改记忆接口与 updated_at 时间戳返回测试。"""

from fastapi.testclient import TestClient

from app.main import create_app
from tests.test_acceptance_support import isolated_settings
from tests.test_chat import FakeChat


def test_instruct_memory_adds_patches_and_removes_entries(tmp_path):
    model = FakeChat(analyses=[
        {
            "summary": "已记住你下周五考计组，且喜欢先看结论。",
            "ops": [
                {"action": "add", "target": "user", "content": "[Context] 阶段目标：下周五考计算机组成原理"},
                {"action": "add", "target": "user", "content": "[Preference] 讲解偏好：先给结论再展开例子"},
            ],
        },
        {
            "summary": "已将计组考试时间改到下周日，并记下资料目录。",
            "ops": [
                {
                    "action": "patch",
                    "target": "user",
                    "old_text": "[Context] 阶段目标：下周五考计算机组成原理",
                    "content": "[Context] 阶段目标：下周日考计算机组成原理",
                },
                {"action": "add", "target": "memory", "content": "资料位置：D:\\Notes\\CO"},
            ],
        },
        {
            "summary": "已忘掉这条讲解偏好。",
            "ops": [
                {
                    "action": "remove",
                    "target": "user",
                    "old_text": "[Preference] 讲解偏好：先给结论再展开例子",
                },
            ],
        },
    ])
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=model)) as client:
        first = client.post("/api/agent-memory/instruct", json={"instruction": "我下周五考计组，以后先给结论再举例子"})
        assert first.status_code == 200
        body = first.json()
        assert body["applied"] == 2
        assert "下周五考计组" in body["summary"]
        assert "下周五考计算机组成原理" in body["user"]
        assert body["updated_at"]["user"] is not None

        second = client.post("/api/agent-memory/instruct", json={"instruction": "考试改到下周日了，课件在 D:\\Notes\\CO"})
        assert second.status_code == 200
        body2 = second.json()
        assert body2["applied"] == 2
        assert "下周日考计算机组成原理" in body2["user"] and "下周五" not in body2["user"]
        assert "D:\\Notes\\CO" in body2["memory"]
        assert body2["updated_at"]["memory"] is not None

        third = client.post("/api/agent-memory/instruct", json={"instruction": "忘掉我先看结论的偏好"})
        assert third.status_code == 200
        assert "先给结论" not in third.json()["user"]

        assert client.post("/api/agent-memory/instruct", json={"instruction": "   "}).status_code == 422


def test_instruct_feedback_reports_what_actually_happened(tmp_path):
    model = FakeChat(analyses=[
        {
            "summary": "已帮你忘掉这条偏好。",
            "ops": [{"action": "remove", "target": "user", "old_text": "[Preference] 讲解偏好：根本不存在的条目"}],
        },
        {
            "summary": "已记住并删掉旧的。",
            "ops": [
                {"action": "add", "target": "user", "content": "[Context] 阶段目标：月底考操作系统"},
                {"action": "remove", "target": "user", "old_text": "不存在"},
            ],
        },
    ])
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=model)) as client:
        none = client.post("/api/agent-memory/instruct", json={"instruction": "忘掉我的讲解偏好"}).json()
        assert none["applied"] == 0 and none["changes"] == []
        assert "已帮你忘掉" not in none["summary"] and "没改成" in none["summary"]

        partial = client.post("/api/agent-memory/instruct", json={"instruction": "月底考操作系统，删掉旧目标"}).json()
        assert partial["applied"] == 1 and len(partial["failed"]) == 1
        assert partial["changes"] == [{"action": "add", "target": "user", "text": "[Context] 阶段目标：月底考操作系统"}]
        assert partial["summary"].startswith("已添加 1 条；有 1 条没改成")

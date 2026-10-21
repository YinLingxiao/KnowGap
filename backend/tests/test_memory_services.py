"""Background memory services: topic naming, profile notes and context compression."""

from fastapi.testclient import TestClient

from app.main import create_app
from tests.test_acceptance_support import isolated_settings
from tests.test_chat import FakeChat, context_of, send, transcript_of


def test_topic_title_is_set_once_and_respects_manual_names(tmp_path):
    model = FakeChat(analyses=[{"topic_title": "栈与队列的区别"}, {"topic_title": "完全不同的标题"},
                               {"topic_title": "又一个标题"}])
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=model)) as client:
        conversation = client.post("/api/conversations", json={}).json()
        send(client, conversation["id"], "我分不清栈和队列", "req-00000001")
        assert client.get(f"/api/conversations/{conversation['id']}").json()["title"] == "栈与队列的区别"
        send(client, conversation["id"], "再举个例子", "req-00000002")
        assert client.get(f"/api/conversations/{conversation['id']}").json()["title"] == "栈与队列的区别"

        renamed = client.post("/api/conversations", json={}).json()
        client.patch(f"/api/conversations/{renamed['id']}", json={"title": "我的命名"})
        send(client, renamed["id"], "继续", "req-00000003")
        assert client.get(f"/api/conversations/{renamed['id']}").json()["title"] == "我的命名"


def test_profile_notes_skip_rewordings_and_later_turns(tmp_path):
    analyses = [
        {"profile_ops": [{"layer": "Identity", "content": "大二计算机专业学生"}]},
        {"profile_ops": [{"layer": "Identity", "content": "大二计算机专业学生，正在学数据结构"},
                         {"layer": "Preference", "content": "喜欢先看例子"}]},
        {"profile_ops": [{"layer": "Context", "content": "下周考试"}]},
        {"profile_ops": [{"layer": "Context", "content": "第四轮不该写入"}]},
    ]
    model = FakeChat(analyses=analyses)
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=model)) as client:
        conversation = client.post("/api/conversations", json={}).json()
        for index in range(4):
            send(client, conversation["id"], f"第{index + 1}轮", f"req-0000000{index + 1}")
        note = client.get("/api/agent-memory").json()["user"]
    assert note.count("大二计算机专业学生") == 1
    assert "[Preference] 喜欢先看例子" in note and "[Context] 下周考试" in note
    assert "第四轮不该写入" not in note


def test_compression_replaces_early_turns_in_the_prompt(tmp_path):
    analyses = [{}, {}, {}, {}, {"summary": "早期讨论了栈的 LIFO。"}, {}]
    model = FakeChat(replies=[f"回复{i}" for i in range(1, 6)], analyses=analyses)
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=model)) as client:
        conversation = client.post("/api/conversations", json={}).json()
        for index in range(4):
            send(client, conversation["id"], f"问题{index + 1}", f"req-0000000{index + 1}")

        result = client.post(f"/api/conversations/{conversation['id']}/compress").json()
        assert result["summary"] == "早期讨论了栈的 LIFO。" and result["compressed_turns"] == 4

        send(client, conversation["id"], "问题5", "req-00000005")
    last = model.calls[-1]
    texts = [m["content"] for m in transcript_of(last)]
    assert not any("问题1" in t or "问题2" in t for t in texts)
    assert any("问题3" in t for t in texts) and any("问题4" in t for t in texts)
    assert context_of(last)["compressed_session_history"] == "早期讨论了栈的 LIFO。"


def test_compression_needs_three_user_turns(tmp_path):
    model = FakeChat()
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=model)) as client:
        conversation = client.post("/api/conversations", json={}).json()
        send(client, conversation["id"], "只有一轮", "req-00000001")
        result = client.post(f"/api/conversations/{conversation['id']}/compress").json()
    assert result["compressed_turns"] == 0 and result["summary"] == ""

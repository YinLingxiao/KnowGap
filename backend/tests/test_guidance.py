from fastapi.testclient import TestClient

from app.chat.next_actions import choose
from app.chat.plan import PlanStore
from app.main import create_app
from app.models.schemas import DEMO_STUDENT
from tests.test_acceptance_support import isolated_settings
from tests.test_chat import FakeChat, send

LONG = "栈像一摞盘子，后放上去的先拿走，这就是后进先出。" * 4


def test_next_action_enum_stays_inside_two_and_skips_uncertain_cases():
    practice = {"steps": [{"title": "做一道练习", "status": "pending", "note": ""}], "completed_at": None}
    explain = {"steps": [{"title": "讲解定义", "status": "pending", "note": ""}], "completed_at": None}
    waiting = {"steps": [{"title": "说说栈", "status": "awaiting_learner", "note": ""}], "completed_at": None}
    done = {"steps": [{"title": "做一道练习", "status": "done", "note": ""}], "completed_at": "t"}
    assert choose(reply=LONG, started=practice, after=practice, repeated=False) == ["quiz"]
    assert choose(reply=LONG, started=explain, after=waiting, repeated=False) == ["quiz"]
    assert choose(reply="好的。", started=practice, after=practice, repeated=False) == []
    assert choose(reply=LONG, started=explain, after=explain, repeated=False) == []
    assert choose(reply=LONG, started=practice, after=done, repeated=False) == ["schedule", "save_note"]
    assert choose(reply=LONG, started=done, after=done, repeated=False) == []
    assert choose(reply=LONG, started=practice, after=practice, repeated=True) == ["weak_points", "quiz"]
    assert choose(reply="短", started=practice, after=done, repeated=True) == ["weak_points"]
    assert choose(reply=LONG, started=None, after=done, repeated=False) == []


def test_quiz_and_weak_points_come_from_the_live_turn(tmp_path):
    model = FakeChat(replies=[LONG, "好。", "好。"], analyses=[
        {},
        {"observations": [{"kind": "misconception", "topic": "栈的顺序", "summary": "记成先进先出",
                           "evidence": "先进先出", "reason": "原话", "effect": "reinforces"}]},
        {"observations": [{"kind": "misconception", "topic": "栈的顺序", "summary": "还是记反",
                           "evidence": "还是先进先出", "reason": "原话", "effect": "reinforces"}]},
    ])
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=model)) as client:
        conversation = client.post("/api/conversations", json={}).json()
        PlanStore(client.app.state.chat_service.store).update(conversation["id"], DEMO_STUDENT, [
            {"title": "做一道练习", "status": "pending", "note": ""},
        ])
        send(client, conversation["id"], "讲一下栈", "req-00000001")
        send(client, conversation["id"], "我认为栈是先进先出", "req-00000002")
        send(client, conversation["id"], "我还是先进先出", "req-00000003")
        assistants = [item for item in client.get(f"/api/conversations/{conversation['id']}").json()["messages"]
                      if item["role"] == "assistant"]
    assert assistants[0]["next_actions"] == ["quiz"]
    assert assistants[1]["next_actions"] == []
    assert assistants[2]["next_actions"] == ["weak_points"]


def test_preference_waits_for_a_yes_and_a_no_is_not_asked_again(tmp_path):
    analyses = [
        {"profile_ops": [{"layer": "Preference", "content": "喜欢先看例子"},
                         {"layer": "Identity", "content": "计算机专业"}]},
        {"profile_ops": [{"layer": "Preference", "content": "喜欢先看例子"}]},
        {"profile_ops": [{"layer": "Preference", "content": "喜欢先看推导"}]},
    ]
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=FakeChat(analyses=analyses))) as client:
        first = client.post("/api/conversations", json={}).json()
        send(client, first["id"], "我喜欢先看例子", "req-00000001")
        notes = client.get("/api/agent-memory").json()["user"]
        assert "[Identity] 计算机专业" in notes and "喜欢先看例子" not in notes
        prompt = next(item["preference_prompt"] for item in client.get(f"/api/conversations/{first['id']}").json()["messages"]
                      if item.get("preference_prompt"))
        assert prompt["text"] == "看起来你喜欢先看例子，要记住吗？"
        assert len(prompt["text"]) <= 20
        assert client.post(f"/api/preferences/{prompt['id']}", json={"allow": False}).json()["status"] == "declined"
        assert "喜欢先看例子" not in client.get("/api/agent-memory").json()["user"]
        assert client.post(f"/api/preferences/{prompt['id']}", json={"allow": True}).status_code == 404
        second = client.post("/api/conversations", json={}).json()
        send(client, second["id"], "还是喜欢先看例子", "req-00000002")
        assert not any(item.get("preference_prompt") for item in client.get(f"/api/conversations/{second['id']}").json()["messages"])
        third = client.post("/api/conversations", json={}).json()
        send(client, third["id"], "我喜欢先看推导", "req-00000003")
        kept = next(item["preference_prompt"] for item in client.get(f"/api/conversations/{third['id']}").json()["messages"]
                    if item.get("preference_prompt"))
        assert client.post(f"/api/preferences/{kept['id']}", json={"allow": True}).json()["status"] == "accepted"
        assert "[Preference] 喜欢先看推导" in client.get("/api/agent-memory").json()["user"]
        assert not any(item.get("preference_prompt") for item in client.get(f"/api/conversations/{third['id']}").json()["messages"])

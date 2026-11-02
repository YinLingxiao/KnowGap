"""micro_quiz 封存、判分接口、幂等与重新生成后的保留。"""

import json

from fastapi.testclient import TestClient

from app.chat.quizzes import seal_quizzes
from app.chat.store import ChatStore
from app.main import create_app
from tests.test_acceptance_support import isolated_settings
from tests.test_auth_and_isolation import auth_headers
from tests.test_chat import FakeChat

QUIZ = {"type": "micro_quiz", "question": "栈的出栈顺序？", "options": ["先进先出", "后进先出", "随机"],
        "answerIndex": 1, "explanation": "栈是后进先出。", "meta": {"source": "own"}}


def block(widget) -> str:
    return "```knowgap-widget\n" + json.dumps(widget, ensure_ascii=False) + "\n```"


def widgets(text: str) -> list[dict]:
    from app.chat.skills.problem_drill_skill import WIDGET_RE
    return [json.loads(m.group(1)) for m in WIDGET_RE.finditer(text)]


def register(client, email):
    code = client.post("/api/auth/send-code", json={"email": email, "purpose": "register"}).json()["demo_code"]
    token = client.post("/api/auth/register", json={
        "email": email, "password": "password123", "code": code, "display_name": email.split("@")[0],
    }).json()["token"]
    return auth_headers(token)


def setup(client):
    """Alice 的会话里有一条助手回复，含两道题和一个坏块。"""
    alice = register(client, "alice@school.edu")
    conversation = client.post("/api/conversations", headers=alice, json={"title": "栈"}).json()["id"]
    store = ChatStore(client.app.state.store)
    user = store.add_user_message(conversation, "出题", "req-quiz-001")
    reply = store.start_reply(conversation, user, [])
    second = {**QUIZ, "question": "第二题", "answerIndex": 0}
    text = f"先看题：\n{block(QUIZ)}\n坏块：\n```knowgap-widget\n{{oops\n```\n再来：\n{block(second)}\n"
    sealed = seal_quizzes(text, reply, conversation, store)
    store.finish_reply(reply, content=sealed, status="complete")
    return alice, conversation, store, user, reply, sealed


def attempt(client, headers, quiz_id, action_id, option):
    return client.post(f"/api/quizzes/{quiz_id}/attempts", headers=headers,
                       json={"action_id": action_id, "option_index": option})


def test_seal_hides_answers_and_assigns_ids(tmp_path):
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=FakeChat([]))) as client:
        _, _, _, _, reply, sealed = setup(client)
    assert "answerIndex" not in sealed and "栈是后进先出" not in sealed
    assert "{oops" in sealed  # 解析不了的块原样保留
    quizzes = [w for w in widgets(sealed.replace("{oops", '{"type": "text"}')) if w["type"] == "micro_quiz"]
    assert [q["quizId"] for q in quizzes] == [f"{reply}:0", f"{reply}:1"]
    assert quizzes[0]["meta"] == {"source": "own"} and quizzes[0]["options"] == QUIZ["options"]


def test_old_and_invalid_quizzes_are_left_alone(tmp_path):
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=FakeChat([]))) as client:
        _, conversation, store, *_ = setup(client)
        bad = block({**QUIZ, "answerIndex": 9})
        assert seal_quizzes(bad, "m1", conversation, store) == bad
        assert seal_quizzes("没有题", "m1", conversation, store) == "没有题"


def test_attempt_grading_idempotency_and_first_attempt_only(tmp_path):
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=FakeChat([]))) as client:
        alice, conversation, _, _, reply, _ = setup(client)
        quiz_id = f"{reply}:0"
        first = attempt(client, alice, quiz_id, "act-1", 0)
        assert first.status_code == 200
        body = first.json()
        assert body["correct"] is False and body["answer_index"] == 1 and body["explanation"] == "栈是后进先出。"
        assert body["quiz_id"] == quiz_id and body["option_index"] == 0 and "repeated" not in body
        assert attempt(client, alice, quiz_id, "act-1", 0).json() == body  # 同 payload 重发
        assert attempt(client, alice, quiz_id, "act-1", 1).status_code == 409
        again = attempt(client, alice, quiz_id, "act-2", 1).json()
        assert again["repeated"] is True and again["attempt_id"] == body["attempt_id"] and again["correct"] is False
        right = attempt(client, alice, f"{reply}:1", "act-3", 0).json()
        assert right["correct"] is True
        listed = client.get(f"/api/conversations/{conversation}/quiz-attempts", headers=alice).json()
        assert set(listed) == {quiz_id, f"{reply}:1"} and listed[quiz_id] == body


def test_out_of_range_missing_and_foreign_quiz(tmp_path):
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=FakeChat([]))) as client:
        alice, conversation, _, _, reply, _ = setup(client)
        bob = register(client, "bob@school.edu")
        quiz_id = f"{reply}:0"
        assert attempt(client, alice, quiz_id, "act-1", 3).status_code == 422
        assert attempt(client, alice, quiz_id, "act-1", -1).status_code == 422
        assert attempt(client, alice, "nope:0", "act-1", 0).status_code == 404
        assert attempt(client, bob, quiz_id, "act-b", 0).status_code == 404
        assert client.get(f"/api/conversations/{conversation}/quiz-attempts", headers=bob).status_code == 404
        assert client.get(f"/api/conversations/{conversation}/quiz-attempts", headers=alice).json() == {}


def test_regenerate_keeps_attempts_and_marks_quiz_superseded(tmp_path):
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=FakeChat([]))) as client:
        alice, conversation, store, user, reply, _ = setup(client)
        quiz_id = f"{reply}:0"
        attempt(client, alice, quiz_id, "act-1", 1)
        store.start_reply(conversation, user, [reply])
        with store.connection() as db:
            assert db.execute("SELECT COUNT(*) FROM conversation_messages WHERE id = ?", (reply,)).fetchone()[0] == 0
            rows = db.execute("SELECT quiz_id, superseded FROM quiz_items ORDER BY quiz_id").fetchall()
        assert [(r["quiz_id"], r["superseded"]) for r in rows] == [(quiz_id, 1), (f"{reply}:1", 1)]
        restored = client.get(f"/api/conversations/{conversation}/quiz-attempts", headers=alice).json()
        assert restored[quiz_id]["correct"] is True
        assert attempt(client, alice, quiz_id, "act-1", 1).json()["attempt_id"] == restored[quiz_id]["attempt_id"]

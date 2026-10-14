from fastapi.testclient import TestClient

from app.main import create_app
from app.models.schemas import DEMO_STUDENT
from tests.test_acceptance_support import RubricDouble, isolated_settings, problem_case, step_from_answer


def post_diagnosis(client, problem_id, answer):
    return client.post("/api/diagnosis", json={
        "student_id": DEMO_STUDENT,
        "problem_id": problem_id,
        "answer": answer,
    })


def test_scripted_judgements_are_stored_without_inventing_issues(tmp_path):
    first = problem_case("stack-sequence-001")
    legal = problem_case("stack-sequence-003")
    tutor = RubricDouble([
        step_from_answer(legal["answers"]["correct"], "你的操作里，每次弹出的是不是当时的栈顶？"),
        step_from_answer(first["answers"]["insufficient"], "结论先放一边，弹出3之后栈顶是哪一个数？"),
        step_from_answer(first["answers"]["incorrect"], "要先弹出3，栈里从底到顶依次是什么？"),
    ])
    with TestClient(create_app(isolated_settings(tmp_path), tutor)) as client:
        right = post_diagnosis(client, legal["id"], legal["answers"]["correct"]["text"])
        assert right.status_code == 200
        assert right.json()["diagnosis"]["assessment"] == "correct"
        assert right.json()["diagnosis"]["issue"] is None
        assert right.json()["memory_changes"] == []

        thin = post_diagnosis(client, first["id"], first["answers"]["insufficient"]["text"])
        assert thin.status_code == 200
        assert thin.json()["diagnosis"]["assessment"] == "uncertain"
        assert thin.json()["diagnosis"]["issue"] is None
        assert thin.json()["memory_changes"] == []
        assert client.get("/api/memories").json() == []

        wrong = post_diagnosis(client, first["id"], first["answers"]["incorrect"]["text"])
        assert wrong.status_code == 200
        body = wrong.json()
        assert body["turn"] == 1
        assert body["diagnosis"]["assessment"] == "incorrect"
        assert body["diagnosis"]["issue"] == first["answers"]["incorrect"]["issue"]
        assert body["diagnosis"]["evidence"] in first["answers"]["incorrect"]["text"]
        assert body["diagnosis"]["topic_key"] == "stack.lifo"
        assert body["memory_changes"][0]["action"] == "created"
        assert body["memory_changes"][0]["memory"]["status"] == "suspected"
        assert body["used_memory_ids"] == []
        memories = client.get("/api/memories").json()
        assert len(memories) == 1
        assert memories[0]["evidence_count"] == 1


def test_three_turns_advance_and_hinted_success_does_not_resolve(tmp_path):
    case = problem_case("stack-sequence-001")
    turns = case["guided_turns"]
    tutor = RubricDouble([
        step_from_answer(case["answers"]["incorrect"], "要先弹出3，1和2哪个更靠近栈顶？"),
        step_from_answer(turns[0], turns[0]["tutor_should_ask"]),
        step_from_answer(turns[1], turns[1]["tutor_should_ask"]),
        step_from_answer(turns[2], turns[2]["tutor_should_ask"]),
    ])
    settings = isolated_settings(tmp_path)
    with TestClient(create_app(settings, tutor)) as client:
        first = post_diagnosis(client, case["id"], case["answers"]["incorrect"]["text"])
        assert first.status_code == 200
        session_id = first.json()["session_id"]
        replies = [first.json()["reply"]]
        turn_numbers = [first.json()["turn"]]
        statuses = [first.json()["memory_changes"][0]["memory"]["status"]]
        for turn in turns:
            response = client.post(
                f"/api/sessions/{session_id}/messages",
                json={"content": turn["student"]},
            )
            assert response.status_code == 200
            payload = response.json()
            replies.append(payload["reply"])
            turn_numbers.append(payload["turn"])
            statuses.append(payload["memory_changes"][0]["memory"]["status"])
        assert replies == [
            "要先弹出3，1和2哪个更靠近栈顶？",
            turns[0]["tutor_should_ask"],
            turns[1]["tutor_should_ask"],
            turns[2]["tutor_should_ask"],
        ]
        assert len(set(replies)) == 4
        assert turn_numbers == [1, 2, 3, 4]
        session = client.get(f"/api/sessions/{session_id}").json()
        assert session["turn"] == 4
        user_messages = [item["content"] for item in session["messages"] if item["role"] == "user"]
        assert user_messages[1:] == [turn["student"] for turn in turns]
        assert statuses == ["suspected", "needs_review", "improving", "improving"]
        assert "resolved" not in statuses
        history = tutor.contexts[-1]["history"]
        assert [item["content"] for item in history if item["role"] == "user"] == user_messages[:-1]

    with TestClient(create_app(settings, tutor)) as client:
        restored = client.get("/api/memories").json()
        assert len(restored) == 1
        assert restored[0]["status"] == "improving"
        assert restored[0]["evidence_count"] == 4
        assert restored[0]["evidence_refs"][0]["quote"] in case["answers"]["incorrect"]["text"]


def test_new_session_receives_memory_and_independent_success_can_resolve(tmp_path):
    first = problem_case("stack-sequence-001")
    second = problem_case("stack-sequence-002")
    third = problem_case("stack-sequence-003")
    memory_reply = "你上次没有核对弹出后的栈顶。这道题先回答：弹出4之后栈顶是哪一个数？"
    tutor = RubricDouble([
        step_from_answer(first["answers"]["incorrect"], "弹出3之后，栈顶是哪一个数？"),
        step_from_answer(
            second["answers"]["correct"],
            "请列出弹出4之前的栈。",
            reply_with_memory=memory_reply,
        ),
        step_from_answer(third["answers"]["correct"], "请指出每一次弹出时的栈顶。"),
    ])
    settings = isolated_settings(tmp_path)
    with TestClient(create_app(settings, tutor)) as client:
        opened = post_diagnosis(client, first["id"], first["answers"]["incorrect"]["text"])
        memory_id = opened.json()["memory_changes"][0]["memory"]["id"]

    with TestClient(create_app(settings, tutor)) as client:
        revisited = post_diagnosis(client, second["id"], second["answers"]["correct"]["text"])
        assert revisited.status_code == 200
        body = revisited.json()
        assert body["used_memory_ids"] == [memory_id]
        assert body["reply"] == memory_reply
        assert body["reply"] != opened.json()["reply"]
        assert tutor.contexts[-1]["related_memories"][0]["id"] == memory_id
        assert body["memory_changes"][0]["memory"]["status"] == "improving"
        listed = client.get("/api/memories").json()
        assert listed[0]["id"] == memory_id
        assert any(item["quote"] in second["answers"]["correct"]["text"] for item in listed[0]["evidence_refs"])

        resolved = post_diagnosis(client, third["id"], third["answers"]["correct"]["text"])
        assert resolved.json()["memory_changes"][0]["memory"]["status"] == "resolved"
        assert client.get("/api/memories").json()[0]["status"] == "resolved"


def test_view_and_delete_memory_keep_session(tmp_path):
    case = problem_case("stack-sequence-001")
    tutor = RubricDouble([
        step_from_answer(case["answers"]["incorrect"], "弹出3之后栈顶是谁？"),
        step_from_answer(case["answers"]["correct"], "这次弹出3之后栈顶是谁？"),
    ])
    with TestClient(create_app(isolated_settings(tmp_path), tutor)) as client:
        opened = post_diagnosis(client, case["id"], case["answers"]["incorrect"]["text"])
        memory_id = opened.json()["memory_changes"][0]["memory"]["id"]
        session_id = opened.json()["session_id"]
        listed = client.get("/api/memories")
        assert listed.status_code == 200
        assert listed.json()[0]["summary"]
        deleted = client.delete(f"/api/memories/{memory_id}")
        assert deleted.status_code == 204
        assert deleted.content == b""
        assert client.get("/api/memories").json() == []
        assert client.get(f"/api/sessions/{session_id}").status_code == 200
        assert client.delete(f"/api/memories/{memory_id}").status_code == 404
        again = post_diagnosis(client, case["id"], case["answers"]["correct"]["text"])
        assert again.json()["used_memory_ids"] == []
        assert again.json()["memory_changes"] == []

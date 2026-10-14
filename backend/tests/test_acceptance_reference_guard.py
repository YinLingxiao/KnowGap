import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.models.schemas import DEMO_STUDENT, TutorOutput
from tests.test_acceptance_support import isolated_settings, problem_case


class FixedTutor:
    def __init__(self, assessment):
        self.assessment = assessment

    async def generate(self, context):
        return TutorOutput(
            assessment=self.assessment,
            issue="未按栈顶约束判断" if self.assessment == "incorrect" else None,
            confidence=0.8,
            evidence=context["current_answer"],
            reply="请只回答当前栈顶是哪一个数。",
        )


def submit(client, problem_id, answer):
    return client.post("/api/diagnosis", json={
        "student_id": DEMO_STUDENT,
        "problem_id": problem_id,
        "answer": answer,
    })


@pytest.mark.parametrize("problem_id", ["stack-sequence-001", "stack-sequence-002", "stack-sequence-003"])
def test_demo_wrong_conclusion_marked_correct_is_rejected(tmp_path, problem_id):
    case = problem_case(problem_id)
    with TestClient(create_app(isolated_settings(tmp_path), FixedTutor("correct"))) as client:
        response = submit(client, problem_id, case["answers"]["incorrect"]["text"])
        assert response.status_code == 502
        assert response.json()["detail"] == "模型判断与题目参考校验冲突，请重试；本次作答尚未保存。"
        assert client.get("/api/memories").json() == []
        assert client.get("/api/sessions/missing-session").status_code == 404


@pytest.mark.parametrize("problem_id", ["stack-sequence-001", "stack-sequence-002", "stack-sequence-003"])
def test_demo_right_conclusion_marked_correct_is_kept(tmp_path, problem_id):
    case = problem_case(problem_id)
    with TestClient(create_app(isolated_settings(tmp_path), FixedTutor("correct"))) as client:
        response = submit(client, problem_id, case["answers"]["correct"]["text"])
        assert response.status_code == 200
        assert response.json()["diagnosis"]["assessment"] == "correct"
        assert response.json()["diagnosis"]["issue"] is None
        assert response.json()["memory_changes"] == []


def test_bare_matching_conclusion_is_not_rewritten_to_uncertain(tmp_path):
    case = problem_case("stack-sequence-001")
    with TestClient(create_app(isolated_settings(tmp_path), FixedTutor("correct"))) as client:
        response = submit(client, case["id"], case["answers"]["insufficient"]["text"])
        assert response.status_code == 200
        assert response.json()["diagnosis"]["assessment"] == "correct"
        assert response.json()["memory_changes"] == []


@pytest.mark.parametrize("answer", [
    "这个序列没问题，数字都能出去。",
    "合法。不合法。",
])
def test_unrecognized_or_conflicting_claim_is_not_vetoed(tmp_path, answer):
    with TestClient(create_app(isolated_settings(tmp_path), FixedTutor("correct"))) as client:
        response = submit(client, "stack-sequence-001", answer)
        assert response.status_code == 200
        assert response.json()["diagnosis"]["assessment"] == "correct"
        assert response.json()["memory_changes"] == []


def test_unparsed_second_sentence_does_not_cancel_a_clear_claim(tmp_path):
    answer = "我认为该序列合法。我又认为该序列不合法。"
    with TestClient(create_app(isolated_settings(tmp_path), FixedTutor("correct"))) as client:
        response = submit(client, "stack-sequence-001", answer)
        assert response.status_code == 502
        assert client.get("/api/memories").json() == []

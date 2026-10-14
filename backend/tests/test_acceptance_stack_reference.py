from fastapi.testclient import TestClient

from app.main import create_app
from app.services.problems import simulate_stack
from tests.test_acceptance_support import CASES, isolated_settings, problem_case


def test_hand_traces_match_stack_simulator():
    seen = []
    for case in CASES["problems"]:
        possible, trace = simulate_stack(case["input_sequence"], case["output_sequence"])
        assert possible is case["possible"]
        assert trace == case["trace"]
        seen.append(case["possible"])
    assert seen == [False, False, True]


def test_problem_api_matches_cases_and_hides_reference(tmp_path):
    with TestClient(create_app(isolated_settings(tmp_path))) as client:
        response = client.get("/api/problems")
    assert response.status_code == 200
    payload = response.json()
    assert [item["id"] for item in payload] == [case["id"] for case in CASES["problems"]]
    for item in payload:
        case = problem_case(item["id"])
        assert item["topic_key"] == "stack.lifo"
        assert item["input_sequence"] == case["input_sequence"]
        assert item["output_sequence"] == case["output_sequence"]
        assert str(case["output_sequence"]) in item["prompt"]
        assert "reference" not in item
        assert "possible" not in item
        assert "trace" not in item

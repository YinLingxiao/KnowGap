"""GPT-owned regression checks; no network calls or development database access.

These verify state/transport contracts, not real model teaching quality.
"""

import asyncio
import itertools
import json

import httpx
import pytest
from fastapi.testclient import TestClient

from app.agents.llm import ChatCompletionsTutor, ProviderError
from app.config import Settings
from app.main import create_app
from app.memory.store import StateConflict, Store
from app.models.schemas import DEMO_STUDENT, TutorOutput
from app.services.problems import PROBLEMS, reference_for, simulate_stack


def config(tmp_path, **kwargs):
    return Settings(
        _env_file=None, database_path=tmp_path / "isolated.sqlite3",
        llm_api_key="", llm_base_url="", llm_model="", **kwargs,
    )


def test_catalogue_reference_and_no_answer_leak(tmp_path):
    with TestClient(create_app(config(tmp_path))) as client:
        response = client.get("/api/problems")
        assert response.status_code == 200
        assert len(response.json()) == 3
        assert all("reference" not in p and "possible" not in p for p in response.json())
        assert [reference_for(p)["possible"] for p in PROBLEMS.values()] == [False, False, True]


def test_stack_simulator_against_independent_operation_enumeration():
    def enumerate_outputs(remaining, stack, output):
        if not remaining and not stack:
            return {tuple(output)}
        results = set()
        if remaining:
            results |= enumerate_outputs(remaining[1:], stack + remaining[:1], output)
        if stack:
            results |= enumerate_outputs(remaining, stack[:-1], output + stack[-1:])
        return results

    inputs = [1, 2, 3, 4]
    oracle = enumerate_outputs(inputs, [], [])
    assert len(oracle) == 14
    for output in itertools.permutations(inputs):
        assert simulate_stack(inputs, list(output))[0] == (output in oracle)


def seeded_store(tmp_path):
    """A store holding one incorrect first-turn session, written the way the first-generation flow did."""
    store = Store(config(tmp_path).resolved_database_path())
    store.initialize()
    first = store.save_turn(
        student_id=DEMO_STUDENT, problem_id="stack-sequence-001", topic_key="stack.lifo",
        answer="所有数字相同，所以合法。", result=TutorOutput(assessment="incorrect", issue="未检查实际栈顶",
            confidence=0.7, evidence="所有数字相同", reply="问题"),
        used_memory_ids=[], session=None,
    )
    return store, first


def test_stale_turn_rejected_atomically(tmp_path):
    store, first = seeded_store(tmp_path)
    snapshot = store.session(first.session_id, DEMO_STUDENT)
    kwargs = dict(
        student_id=DEMO_STUDENT, problem_id=snapshot.problem_id, topic_key="stack.lifo",
        answer="当前栈顶是2", result=TutorOutput(assessment="correct", issue=None,
            confidence=0.8, evidence="栈顶是2", reply="下一步呢？"),
        used_memory_ids=[], session=snapshot,
    )
    store.save_turn(**kwargs)
    with pytest.raises(StateConflict):
        store.save_turn(**kwargs)
    saved = store.session(snapshot.id, DEMO_STUDENT)
    assert saved.turn == 2 and len(saved.messages) == 4
    assert store.memories(DEMO_STUDENT)[0].evidence_count == 2


def test_deleted_memory_in_flight_rejected(tmp_path):
    store, first = seeded_store(tmp_path)
    memory_id = first.memory_changes[0].memory.id
    store.delete_memory(memory_id, DEMO_STUDENT)
    with pytest.raises(StateConflict):
        store.save_turn(
            student_id=DEMO_STUDENT, problem_id="stack-sequence-002", topic_key="stack.lifo",
            answer="回答", result=TutorOutput(assessment="incorrect", issue="问题",
                confidence=0.7, evidence="回答", reply="追问"),
            used_memory_ids=[memory_id], session=None,
        )
    with store.connection() as db:
        assert db.execute("SELECT count(*) FROM learning_sessions").fetchone()[0] == 1
    assert store.memories(DEMO_STUDENT) == []


def test_cors_allows_only_configured_origins(tmp_path):
    with TestClient(create_app(config(tmp_path))) as client:
        headers = {"Origin": "http://localhost:3000", "Access-Control-Request-Method": "POST",
                   "Access-Control-Request-Headers": "content-type"}
        assert client.options("/api/conversations", headers=headers).headers["access-control-allow-origin"] == headers["Origin"]
        headers["Origin"] = "https://untrusted.example"
        assert client.options("/api/conversations", headers=headers).status_code == 400


def provider_settings(tmp_path):
    return Settings(_env_file=None, database_path=tmp_path / "provider.sqlite3",
                    llm_api_key="test-only-key", llm_base_url="https://model.example/v1", llm_model="test-model")


def envelope(content, finish_reason="stop"):
    return {"choices": [{"finish_reason": finish_reason, "message": {"content": content}}]}


def test_real_adapter_request_format_with_mock_transport(tmp_path):
    result = TutorOutput(assessment="correct", issue=None, confidence=0.8, evidence="栈顶是2", reply="接下来呢？")

    def handler(request):
        assert str(request.url) == "https://model.example/v1/chat/completions"
        assert request.headers["Authorization"] == "Bearer test-only-key"
        payload = json.loads(request.content)
        assert payload["model"] == "test-model"
        assert payload["response_format"] == {"type": "json_object"}
        assert payload["messages"][0]["role"] == "system"
        return httpx.Response(200, json=envelope(result.model_dump_json()))

    adapter = ChatCompletionsTutor(provider_settings(tmp_path), httpx.MockTransport(handler))
    assert asyncio.run(adapter.generate({"current_answer": "当前栈顶是2。"})) == result


@pytest.mark.parametrize("status, expected", [(401, 503), (403, 503), (429, 503), (500, 502)])
def test_adapter_sanitizes_provider_error_bodies(tmp_path, status, expected):
    adapter = ChatCompletionsTutor(provider_settings(tmp_path), httpx.MockTransport(
        lambda request: httpx.Response(status, text="private provider response with secret")))
    with pytest.raises(ProviderError) as error:
        asyncio.run(adapter.generate({"current_answer": "回答"}))
    assert error.value.status_code == expected
    assert "private" not in error.value.detail and "secret" not in error.value.detail


@pytest.mark.parametrize("body", [
    {}, {"choices": []}, {"choices": [None]},
    envelope("not json"), envelope('{"assessment":"correct"}'),
    envelope('{"assessment":"correct","issue":"错误标签","confidence":0.8,"evidence":"回答","reply":"问题"}'),
    envelope('{"assessment":"uncertain","issue":null,"confidence":1.8,"evidence":"回答","reply":"问题"}'),
    envelope('{"assessment":"correct","issue":null,"confidence":0.8,"evidence":"回答","reply":"问题"}', "length"),
])
def test_adapter_rejects_invalid_or_truncated_output(tmp_path, body):
    adapter = ChatCompletionsTutor(provider_settings(tmp_path), httpx.MockTransport(
        lambda request: httpx.Response(200, json=body)))
    with pytest.raises(ProviderError) as error:
        asyncio.run(adapter.generate({"current_answer": "回答"}))
    assert error.value.status_code == 502


@pytest.mark.parametrize("exception, expected", [(httpx.ReadTimeout, 504), (httpx.ConnectError, 502)])
def test_adapter_timeout_and_connection_failure(tmp_path, exception, expected):
    def handler(request):
        raise exception("private transport diagnostics", request=request)

    adapter = ChatCompletionsTutor(provider_settings(tmp_path), httpx.MockTransport(handler))
    with pytest.raises(ProviderError) as error:
        asyncio.run(adapter.generate({"current_answer": "回答"}))
    assert error.value.status_code == expected
    assert "private" not in error.value.detail

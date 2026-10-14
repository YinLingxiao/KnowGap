"""GPT-owned regression checks; no network calls or development database access.

These verify state/transport contracts, not real model teaching quality.
Cursor owns the separate tests/test_acceptance_* suite.
"""

import asyncio
import itertools
import json
import sqlite3

import httpx
import pytest
from fastapi.testclient import TestClient

from app.agents.llm import ChatCompletionsTutor, ProviderError
from app.config import Settings
from app.main import create_app
from app.memory.store import StateConflict
from app.models.schemas import DEMO_STUDENT, TutorOutput
from app.services.problems import PROBLEMS, reference_for, simulate_stack


class ScriptedTutor:
    """A deliberately labelled TEST DOUBLE, not a model or diagnosis algorithm."""

    def __init__(self, observations):
        self.observations = iter(observations)
        self.contexts = []

    async def generate(self, context):
        self.contexts.append(context)
        assessment = next(self.observations)
        return TutorOutput(
            assessment=assessment, issue="未检查实际栈顶" if assessment == "incorrect" else None,
            confidence=0.7, evidence=context["current_answer"],
            reply=f"测试替身第 {context['turn']} 轮问题，历史记忆数 {len(context['related_memories'])}",
        )


def config(tmp_path, **kwargs):
    return Settings(
        _env_file=None, database_path=tmp_path / "isolated.sqlite3",
        llm_api_key="", llm_base_url="", llm_model="", **kwargs,
    )


def start(client, answer="所有数字相同，所以合法。", problem="stack-sequence-001"):
    return client.post("/api/diagnosis", json={
        "student_id": DEMO_STUDENT, "problem_id": problem, "answer": answer,
    })


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


def test_learning_loop_restart_retrieval_and_resolution(tmp_path):
    settings = config(tmp_path)
    tutor = ScriptedTutor(["incorrect", "incorrect", "correct", "correct", "correct", "correct"])
    with TestClient(create_app(settings, tutor)) as client:
        first = start(client).json()
        assert first["turn"] == 1 and first["used_memory_ids"] == []
        memory_id = first["memory_changes"][0]["memory"]["id"]
        session_id = first["session_id"]
        assert first["memory_changes"][0]["memory"]["status"] == "suspected"
        statuses = []
        for answer in ["弹出3后可以直接拿1。", "栈顶其实是2。", "因此不能绕过2弹出1。"]:
            response = client.post(f"/api/sessions/{session_id}/messages", json={"content": answer})
            assert response.status_code == 200
            statuses.append(response.json()["memory_changes"][0]["memory"]["status"])
        assert statuses == ["needs_review", "improving", "improving"]
        saved = client.get(f"/api/sessions/{session_id}").json()
        assert saved["turn"] == 4 and len(saved["messages"]) == 8
        assert len(tutor.contexts[3]["history"]) == 6
        assert tutor.contexts[1]["related_memories"][0]["id"] == memory_id

    # A new application/connection opens the SAME temp file, simulating restart.
    with TestClient(create_app(settings, tutor)) as client:
        restored = client.get("/api/memories").json()
        assert len(restored) == 1 and restored[0]["evidence_count"] == 4
        second = start(client, "不合法：弹出4后栈顶为3，不能弹出1。", "stack-sequence-002").json()
        assert second["used_memory_ids"] == [memory_id]
        assert second["memory_changes"][0]["memory"]["status"] == "improving"
        third = start(client, "合法：push1 push2 pop2 pop1 push3 push4 pop4 pop3。", "stack-sequence-003").json()
        assert third["memory_changes"][0]["memory"]["status"] == "resolved"
        assert len(client.get("/api/memories").json()) == 1


def test_repeated_same_problem_does_not_resolve(tmp_path):
    with TestClient(create_app(config(tmp_path), ScriptedTutor(["incorrect", "correct", "correct"]))) as client:
        start(client)
        start(client, "栈顶是2，不能跳过。")
        result = start(client, "仍不能跳过2。").json()
        assert result["memory_changes"][0]["memory"]["status"] == "improving"


@pytest.mark.parametrize("assessment", ["correct", "uncertain"])
def test_no_invented_memory_for_correct_or_uncertain(tmp_path, assessment):
    with TestClient(create_app(config(tmp_path), ScriptedTutor([assessment]))) as client:
        result = start(client, "不合法，因为弹出3后栈顶是2。").json()
        assert result["diagnosis"]["issue"] is None
        assert result["memory_changes"] == []
        assert client.get("/api/memories").json() == []


def test_uncertain_observation_does_not_mutate_existing_memory(tmp_path):
    with TestClient(create_app(config(tmp_path), ScriptedTutor(["incorrect", "uncertain"]))) as client:
        first = start(client).json()
        before = client.get("/api/memories").json()
        response = client.post(f"/api/sessions/{first['session_id']}/messages", json={"content": "我不确定。"})
        assert response.json()["memory_changes"] == []
        assert client.get("/api/memories").json() == before


def test_delete_memory_retains_session_and_drops_retrieval(tmp_path):
    with TestClient(create_app(config(tmp_path), ScriptedTutor(["incorrect", "correct"]))) as client:
        first = start(client).json()
        memory_id = first["memory_changes"][0]["memory"]["id"]
        response = client.delete(f"/api/memories/{memory_id}")
        assert response.status_code == 204 and response.content == b""
        assert client.get("/api/memories").json() == []
        assert client.get(f"/api/sessions/{first['session_id']}").status_code == 200
        assert client.delete(f"/api/memories/{memory_id}").status_code == 404
        assert start(client, "不合法，因为2在1上方。").json()["used_memory_ids"] == []


@pytest.mark.parametrize("answer", ["", "   ", "x" * 6001])
def test_invalid_answer_rejected_before_model(tmp_path, answer):
    tutor = ScriptedTutor([])
    with TestClient(create_app(config(tmp_path), tutor)) as client:
        assert start(client, answer).status_code == 422
        assert tutor.contexts == []


def test_invalid_identity_problem_session_and_extra_fields(tmp_path):
    with TestClient(create_app(config(tmp_path), ScriptedTutor([]))) as client:
        assert start(client, problem="unknown").status_code == 404
        assert client.get("/api/sessions/missing").status_code == 404
        assert client.post("/api/sessions/missing/messages", json={"content": "回答"}).status_code == 404
        assert client.get("/api/memories?student_id=someone-else").status_code == 422
        assert client.post("/api/diagnosis", json={
            "student_id": "someone-else", "problem_id": "stack-sequence-001", "answer": "回答",
        }).status_code == 422
        assert client.post("/api/diagnosis", json={
            "problem_id": "stack-sequence-001", "answer": "回答", "api_key": "invalid-extra",
        }).status_code == 422


def test_unconfigured_provider_fails_without_writes(tmp_path):
    app = create_app(config(tmp_path))
    with TestClient(app) as client:
        assert client.get("/health").json() == {"status": "ok"}
        assert start(client).status_code == 503
        with app.state.store.connection() as db:
            assert db.execute("SELECT count(*) FROM learning_sessions").fetchone()[0] == 0
            assert db.execute("SELECT count(*) FROM messages").fetchone()[0] == 0


def test_invented_evidence_fails_without_writes(tmp_path):
    class InventedTutor:
        async def generate(self, context):
            return TutorOutput(assessment="incorrect", issue="误区", confidence=0.8,
                               evidence="学生从未说过这句话", reply="问题")

    with TestClient(create_app(config(tmp_path), InventedTutor())) as client:
        assert start(client).status_code == 502
        assert client.get("/api/memories").json() == []


def test_failed_followup_preserves_entire_previous_turn(tmp_path):
    class FailsAfterFirst(ScriptedTutor):
        async def generate(self, context):
            if self.contexts:
                raise ProviderError(504, "测试模拟超时")
            return await super().generate(context)

    with TestClient(create_app(config(tmp_path), FailsAfterFirst(["incorrect"]))) as client:
        first = start(client).json()
        url = f"/api/sessions/{first['session_id']}"
        before = client.get(url).json()
        before_memory = client.get("/api/memories").json()
        assert client.post(f"{url}/messages", json={"content": "新回答"}).status_code == 504
        assert client.get(url).json() == before
        assert client.get("/api/memories").json() == before_memory


def test_storage_failure_rolls_back_session_messages_and_memory(tmp_path, monkeypatch):
    app = create_app(config(tmp_path), ScriptedTutor(["incorrect"]))

    def fail(*args, **kwargs):
        raise sqlite3.OperationalError("simulated write failure")

    with TestClient(app) as client:
        monkeypatch.setattr(app.state.store, "_update_memory", fail)
        assert start(client).status_code == 503
        with app.state.store.connection() as db:
            for table in ["learning_sessions", "messages", "learning_memories"]:
                assert db.execute(f"SELECT count(*) FROM {table}").fetchone()[0] == 0


def test_stale_turn_rejected_atomically(tmp_path):
    app = create_app(config(tmp_path), ScriptedTutor(["incorrect"]))
    with TestClient(app) as client:
        first = start(client).json()
        store = app.state.store
        snapshot = store.session(first["session_id"], DEMO_STUDENT)
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
    app = create_app(config(tmp_path), ScriptedTutor(["incorrect"]))
    with TestClient(app) as client:
        first = start(client).json()
        store = app.state.store
        memory_id = first["memory_changes"][0]["memory"]["id"]
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


def test_turn_limit_and_cors(tmp_path):
    app = create_app(config(tmp_path), ScriptedTutor(["incorrect"]))
    with TestClient(app) as client:
        first = start(client).json()
        with app.state.store.connection() as db:
            db.execute("UPDATE learning_sessions SET turn = 40 WHERE id = ?", (first["session_id"],))
        assert client.post(f"/api/sessions/{first['session_id']}/messages", json={"content": "回答"}).status_code == 409
        headers = {"Origin": "http://localhost:3000", "Access-Control-Request-Method": "POST",
                   "Access-Control-Request-Headers": "content-type"}
        assert client.options("/api/diagnosis", headers=headers).headers["access-control-allow-origin"] == headers["Origin"]
        headers["Origin"] = "https://untrusted.example"
        assert client.options("/api/diagnosis", headers=headers).status_code == 400


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

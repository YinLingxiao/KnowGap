"""Learning plan persistence, normalization, learner controls and streamed integration."""

import json

import pytest
from fastapi.testclient import TestClient

from app.agent_tools import DEFINITIONS
from app.chat.agent import validate_analysis
from app.chat.plan import PlanStore, brief
from app.chat.service import Generation
from app.main import create_app
from tests.test_acceptance_support import isolated_settings
from tests.test_agenda_tools import STUDENT, call, ctx_for
from tests.test_chat import FakeChat, context_of, send


def step(title, status="pending", **kwargs):
    return {"title": title, "status": status, **kwargs}


def test_replace_matches_ids_and_exact_titles_and_preserves_version_on_noop(tmp_path):
    ctx, store = ctx_for(tmp_path)
    plans = PlanStore(store)
    assert plans.read(ctx.conversation_id, STUDENT) == {
        "conversation_id": ctx.conversation_id, "version": 0, "steps": [],
        "completed_at": None, "updated_at": None,
    }
    first = call("update_plan", {"steps": [step("例子"), step("自测")]}, ctx)["plan"]
    a, b = first["steps"]
    second = call("update_plan", {"steps": [step("改名", id=a["id"]), step("自测"), step("变式")]}, ctx)["plan"]
    assert [s["id"] for s in second["steps"]][:2] == [a["id"], b["id"]]
    assert second["version"] == 2
    no_op = call("update_plan", {"steps": [step(s["title"], id=s["id"]) for s in second["steps"]]}, ctx)["plan"]
    assert no_op == second
    replaced = call("update_plan", {"steps": [step("独立主题")]}, ctx)["plan"]
    assert len(replaced["steps"]) == 1 and replaced["steps"][0]["id"] not in {a["id"], b["id"]}
    # A new instance reads durable data; no internal sequence marker leaks to clients.
    assert PlanStore(store).read(ctx.conversation_id, STUDENT) == replaced


def test_normalization_and_completion_metadata(tmp_path):
    ctx, store = ctx_for(tmp_path)
    user = store.add_user_message(ctx.conversation_id, "开始", "req-start-01")
    assistant = store.start_reply(ctx.conversation_id, user, [])
    ctx.user_message_id, ctx.assistant_message_id = user, assistant
    result = call("update_plan", {"steps": [step("A", "in_progress"), step("B", "in_progress")]}, ctx)
    assert [s["status"] for s in result["plan"]["steps"]] == ["in_progress", "pending"]
    assert result["rejected_changes"]
    done = call("update_plan", {"steps": [step("A", "done"), step("B", "skipped")]}, ctx)["plan"]
    assert done["completed_at"] and done["steps"][0]["completed_message_id"] == assistant
    assert store.message(assistant, STUDENT).plan_changes
    refused = call("update_plan", {"steps": [step("A", "pending"), step("B", "skipped")]}, ctx)
    assert refused["plan"]["steps"][0]["status"] == "done" and refused["rejected_changes"]
    assert refused["plan"]["completed_at"] == done["completed_at"]
    reopened = PlanStore(store).user_action(ctx.conversation_id, STUDENT, "add", title="C")
    assert reopened["completed_at"] is None
    assert brief(done)["progress"] == "2/2"


def test_waiting_requires_new_user_after_entry_not_another_tool_call(tmp_path):
    ctx, store = ctx_for(tmp_path)
    first = store.add_user_message(ctx.conversation_id, "开始", "req-wait-01")
    ctx.user_message_id = first
    waiting = call("update_plan", {"steps": [step("自测", "awaiting_learner", note="先进还是后进？")]}, ctx)
    assert "_awaiting_seq" not in waiting["plan"]["steps"][0]
    blocked = call("update_plan", {"steps": [step("自测", "done")]}, ctx)
    assert blocked["plan"]["steps"][0]["status"] == "awaiting_learner"
    assert blocked["rejected_changes"]
    second = store.add_user_message(ctx.conversation_id, "后进先出", "req-wait-02")
    # Later queued input cannot unlock a tool call belonging to an earlier user turn.
    assert call("update_plan", {"steps": [step("自测", "done")]}, ctx)["rejected_changes"]
    ctx.user_message_id = second
    assert call("update_plan", {"steps": [step("自测", "done")]}, ctx)["plan"]["steps"][0]["status"] == "done"


@pytest.mark.parametrize("items", [[], [step("x")] * 9, [step("")], [step("x" * 61)],
                                  [step("x", "completed")], [step("x", note="x" * 121)],
                                  [step("x", thread_id={})]])
def test_invalid_tool_parameters_are_rejected(tmp_path, items):
    ctx, store = ctx_for(tmp_path)
    with pytest.raises(ValueError):
        PlanStore(store).update(ctx.conversation_id, STUDENT, items)
    assert PlanStore(store).read(ctx.conversation_id, STUDENT)["version"] == 0


def test_thread_id_scope_validation_and_resolved_sync(tmp_path):
    ctx, store = ctx_for(tmp_path)
    subject = store.conversation_subject(ctx.conversation_id)
    other = store.create_subject("someone-else", "other", "", "")
    elsewhere = store.create_subject(STUDENT, "different", "", "")

    def thread(student, space, request):
        return store.create_thread(student, space.id, title="练习", anchor_message_id=None, client_request_id=request)

    good = thread(STUDENT, subject, "thread-good")
    foreign = thread("someone-else", other, "thread-foreign")
    wrong_space = thread(STUDENT, elsewhere, "thread-space")
    result = call("update_plan", {"steps": [step("A", thread_id=good), step("B", thread_id=foreign),
                                           step("C", thread_id=wrong_space), step("D", thread_id=ctx.conversation_id)]}, ctx)
    assert [s["thread_id"] for s in result["plan"]["steps"]] == [good, None, None, None]
    assert len(result["rejected_changes"]) == 3
    resolution = store.resolve_thread(good, STUDENT, "解决", "已完成。通过自测。", [])
    synced = PlanStore(store).read(ctx.conversation_id, STUDENT)
    assert synced["steps"][0]["status"] == "done"
    assert synced["steps"][0]["completed_message_id"] == resolution["message_id"]
    assert synced["version"] == result["plan"]["version"] + 1
    assert PlanStore(store).read(ctx.conversation_id, STUDENT) == synced
    # A one-time resolution sync must not undo a later explicit learner reset.
    PlanStore(store).user_action(ctx.conversation_id, STUDENT, "patch", synced["steps"][0]["id"], status="pending")
    assert PlanStore(store).read(ctx.conversation_id, STUDENT)["steps"][0]["status"] == "pending"
    with pytest.raises(LookupError):
        PlanStore(store).read(ctx.conversation_id, "someone-else")


def test_rest_user_controls_while_busy_and_once_only_context_events(tmp_path):
    model = FakeChat()
    app = create_app(isolated_settings(tmp_path), chat_model=model)
    with TestClient(app) as client:
        cid = client.post("/api/conversations", json={}).json()["id"]
        root = f"/api/conversations/{cid}/plan"
        assert client.get(root).json()["version"] == 0
        service = app.state.chat_service
        service.active[cid] = Generation(cid, "user", "assistant")
        added = client.post(root + "/steps", json={"title": "自测"}).json()
        sid = added["steps"][0]["id"]
        for status in ("done", "pending", "skipped"):
            response = client.patch(root + f"/steps/{sid}", json={"status": status, "title": "练习"})
            assert response.status_code == 200
            assert response.json()["steps"][0]["status"] == status
        assert response.json()["completed_at"]
        assert client.patch(root + f"/steps/{sid}", json={"status": "in_progress"}).status_code == 422
        assert client.patch(root + "/steps/missing", json={"status": "done"}).status_code == 404
        del service.active[cid]
        send(client, cid, "继续", "req-events-01")
        first = context_of(model.calls[0])
        assert first["learning_plan"]["steps"][0]["status"] == "skipped"
        assert len(first["plan_user_events"]) == 4
        # Reads must not consume learner events; subsequent model turns consume exactly once.
        send(client, cid, "继续", "req-events-02")
        assert "plan_user_events" not in context_of(model.calls[1])
        assert client.delete(root + f"/steps/{sid}").json()["steps"] == []
        assert client.delete(root + f"/steps/{sid}").status_code == 404
        client.post(root + "/steps", json={"title": "变式"})
        cleared = client.delete(root).json()
        assert cleared["steps"] == [] and cleared["completed_at"] is None and cleared["version"] > added["version"]
        send(client, cid, "新话题", "req-events-03")
        assert "learning_plan" not in context_of(model.calls[2])
        assert "清空" in context_of(model.calls[2])["plan_user_events"][-1]

        foreign = service.store.create_conversation("other", title=None, problem=None, client_request_id=None)
        for target in (foreign, "missing"):
            path = f"/api/conversations/{target}/plan"
            for method, suffix, body in [("GET", "", None), ("POST", "/steps", {"title": "x"}),
                                         ("PATCH", "/steps/x", {"status": "done"}),
                                         ("DELETE", "/steps/x", None), ("DELETE", "", None)]:
                assert client.request(method, path + suffix, json=body).status_code == 404


class PlanningChat(FakeChat):
    async def stream(self, messages, tools=None):
        self.calls.append(messages)
        self.tool_names = {t["function"]["name"] for t in tools or []}
        if len(self.calls) == 1:
            yield "tool_calls", [{"id": "plan-tool", "name": "update_plan", "arguments": json.dumps(
                {"steps": [step("理解栈", "awaiting_learner", note="栈的出入顺序是什么？"), step("变式练习")]}, ensure_ascii=False)}]
            yield "finish", "tool_calls"
        else:
            yield "text", "栈的出入顺序是什么？"
            yield "finish", "stop"


def test_tool_sse_message_metadata_and_next_turn_volatile_context(tmp_path):
    model = PlanningChat()
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=model)) as client:
        cid = client.post("/api/conversations", json={}).json()["id"]
        events = send(client, cid, "解释栈", "req-plan-01")
        plan_events = [p for name, p in events if name == "plan"]
        assert len(plan_events) == 1 and plan_events[0]["version"] == 1
        done = next(p["message"] for name, p in events if name == "done")
        assert done["plan_changes"][0]["to"] == "awaiting_learner"
        stored = client.get(f"/api/conversations/{cid}").json()["messages"][-1]
        assert stored["plan_changes"] == done["plan_changes"]
        assert client.get(f"/api/conversations/{cid}/plan").json() == plan_events[0]
        send(client, cid, "后进先出", "req-plan-02")
        assert context_of(model.calls[2])["learning_plan"]["progress"] == "0/2"
        assert model.calls[0][:2] == model.calls[2][:2]  # stable prefix unchanged
        volatile = [json.loads(m["content"])["turn_context"] for m in model.calls[2]
                    if m["role"] == "system" and m["content"].startswith('{"turn_context"')]
        assert volatile[0]["learning_plan"]["steps"][0]["id"] == plan_events[0]["steps"][0]["id"]
    assert "update_plan" in model.tool_names and "plan_steps" not in model.tool_names
    assert "plan_steps" not in {t["function"]["name"] for t in DEFINITIONS}


def test_analysis_validates_exact_evidence_and_only_waiting_steps(tmp_path):
    plan = {"steps": [{"id": "a", "status": "awaiting_learner"}, {"id": "b", "status": "pending"}]}
    raw = {"plan_updates": [{"id": "a", "status": "done", "evidence": "后进先出"},
                            {"id": "a", "status": "done", "evidence": "先进先出"},
                            {"id": "b", "status": "done", "evidence": "后进先出"},
                            {"id": "a", "status": "pending", "evidence": "后进先出"}]}
    assert validate_analysis(raw, "栈是后进先出", None, [], plan)["plan_updates"] == raw["plan_updates"][:1]
    assert validate_analysis({"plan_updates": [{"id": "a", "status": "done", "evidence": "A B"}]},
                             "A  B", None, [], plan)["plan_updates"] == []


def test_analysis_fallback_emits_plan_and_persists_assistant_changes(tmp_path):
    model = FakeChat()
    app = create_app(isolated_settings(tmp_path), chat_model=model)
    with TestClient(app) as client:
        cid = client.post("/api/conversations", json={}).json()["id"]
        plans = PlanStore(app.state.chat_service.store)
        waiting = plans.update(cid, STUDENT, [step("自测", "awaiting_learner"), step("下一步")])["plan"]
        sid = waiting["steps"][0]["id"]
        model.analyses = [{"plan_updates": [{"id": sid, "status": "done", "evidence": "编造答案"}]}]
        refused = send(client, cid, "后进先出", "req-analysis-01")
        assert not any(name == "plan" for name, _ in refused)
        model.analyses = [{"plan_updates": [{"id": sid, "status": "done", "evidence": "后进先出"}]}]
        events = send(client, cid, "栈是后进先出", "req-analysis-02")
        updated = next(data for name, data in events if name == "plan")
        analyzed = next(data for name, data in events if name == "analysis")
        message = analyzed["assistant_message"]
        assert updated["steps"][0]["status"] == "done" and updated["steps"][1]["status"] == "pending"
        assert updated["steps"][0]["completed_message_id"] == message["id"]
        assert message["plan_changes"] == [{"step_id": sid, "title": "自测", "from": "awaiting_learner", "to": "done"}]
        assert model.analysis_calls[-1]["learning_plan"]["steps"][0]["status"] == "awaiting_learner"
        assert client.get(f"/api/conversations/{cid}").json()["messages"][-1]["plan_changes"] == message["plan_changes"]

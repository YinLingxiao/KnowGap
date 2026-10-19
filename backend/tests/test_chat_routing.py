"""Role/prompt integration contracts. Real semantic routing is evaluated separately."""

import json

import pytest
from fastapi.testclient import TestClient

from app.chat.agent import CHAT_PROMPT, ROLE_PROMPTS
from app.main import create_app
from tests.test_acceptance_support import isolated_settings
from tests.test_chat import FakeChat, context_of, send, transcript_of


@pytest.mark.parametrize("role", ["main", "thread", "chat"])
def test_role_policy_and_coordinator_tools_match_the_actual_conversation(tmp_path, role):
    class Capture(FakeChat):
        async def stream(self, messages, tools=None):
            self.calls.append((messages, {tool["function"]["name"] for tool in tools}))
            yield "text", "测试回复。"
            yield "finish", "stop"

    model = Capture()
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=model)) as client:
        if role == "chat":
            cid = client.post("/api/conversations", json={}).json()["id"]
        else:
            space = client.post("/api/subjects", json={"name": "角色测试"}).json()
            cid = space["main_conversation_id"] if role == "main" else client.post(
                f"/api/subjects/{space['id']}/threads", json={"client_request_id": "routing-test-thread"},
            ).json()["id"]
        send(client, cid, "你好", "routing-role-message")

    messages, names = model.calls[0]
    assert context_of(messages)["conversation_role"]["role"] == role
    assert messages[0]["content"].startswith(ROLE_PROMPTS[role] + "\n\n" + CHAT_PROMPT)
    assert all(policy not in messages[0]["content"] for other, policy in ROLE_PROMPTS.items() if other != role)
    assert (names & {"dispatch_thread", "propose_threads"}) == (
        {"dispatch_thread", "propose_threads"} if role == "main" else set())
    assert ("report_progress" in names) == (role == "thread")
    assert ("plan_steps" in names) == (role in {"thread", "chat"})
    if role == "main":
        assert not names & {"read", "write", "edit", "bash", "plan_steps"}


def test_main_short_acceptance_keeps_the_offer_and_existing_thread_context(tmp_path):
    model = FakeChat(["测试回复。"])
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=model)) as client:
        space = client.post("/api/subjects", json={"name": "链表"}).json()
        cid = space["main_conversation_id"]
        store = client.app.state.chat_service.store
        source = store.add_user_message(cid, "我想练链表", "routing-offer-source")
        reply = store.start_reply(cid, source, [])
        offer = "要不要在当前链表 Thread 练一下头插法？"
        store.finish_reply(reply, content=offer, status="complete")
        thread = store.create_thread("demo-student-001", space["id"], title="链表练习",
                                     anchor_message_id=source, client_request_id="routing-existing-thread")
        send(client, cid, "可以", "routing-short-acceptance")
    messages = model.calls[0]
    assert transcript_of(messages)[-3:] == [
        {"role": "user", "content": "我想练链表"},
        {"role": "assistant", "content": offer},
        {"role": "user", "content": "可以"},
    ]
    context = context_of(messages)
    assert context["latest_user_message"] == "可以"
    assert context["conversation_role"]["threads"][0]["id"] == thread


def test_main_role_policy_does_not_change_the_history_prefix_between_turns(tmp_path):
    model = FakeChat(["A1", "A2", "A3"])
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=model)) as client:
        space = client.post("/api/subjects", json={"name": "前缀"}).json()
        for index in range(3):
            send(client, space["main_conversation_id"], f"第{index}问", f"routing-prefix-{index}")
    second, third = model.calls[1:]
    turn_at = next(i for i, message in enumerate(second)
                   if message["role"] == "system" and '"turn_context"' in message["content"])
    assert third[:turn_at] == second[:turn_at]
    assert third[-1] == {"role": "user", "content": "第2问"}


@pytest.mark.parametrize("calls,text,expected", [
    ([], "想先学数组还是链表？", True),
    ([{"name": "propose_threads", "arguments": json.dumps({"proposals": [
        {"title": "数组入门", "task": "学习数组的访问与遍历", "reason": "候选路线，等待选择"},
    ]})}], "", True),
    ([{"name": "dispatch_thread", "arguments": '{"title":"数组","task":"开始学习数组"}'}], "", False),
    ([{"name": "propose_threads", "arguments": "{}"}], "", False),
    ([], "", False),
])
def test_live_routing_check_allows_selection_cards_but_rejects_premature_execution(calls, text, expected):
    from checks.evaluate_live_thread_routing import CASES, judge
    case = next(case for case in CASES if case["name"] == "ambiguous_acceptance")
    assert judge(case, calls, text, None) is expected


def test_conversational_onboarding_populates_user_profile_and_marks_onboarded(tmp_path):
    class Interview(FakeChat):
        async def complete_json(self, messages):
            payload = json.loads(messages[-1]["content"])
            return {"answers": [{"field": payload["stage"], "value": payload["answer"],
                                 "quote": payload["answer"], "declined": False}]}
    model = Interview()
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=model)) as client:
        status0 = client.get("/api/onboarding").json()
        assert status0["onboarded"] is False

        conv = client.post("/api/onboarding/start").json()
        assert conv["messages"][0]["role"] == "assistant"
        assert "最近你最想" in conv["messages"][0]["content"]
        # Calling start again is idempotent and returns the same conversation
        assert client.post("/api/onboarding/start").json()["id"] == conv["id"]

        send(client, conv["id"], "我是在校学生，最近在学计算机组成原理", "onboard-ans-1")
        assert client.get("/api/onboarding").json()["status"] == "in_progress"
        assert client.get("/api/agent-memory").json()["user"] == ""
        send(client, conv["id"], "先给我具体的数字小例子再讲定义", "onboard-ans-2")
        send(client, conv["id"], "做题时先给小步提示让我自己思考", "onboard-ans-3")

        status1 = client.get("/api/onboarding").json()
        assert status1["onboarded"] is False
        assert status1["ready"] is True
        assert client.post('/api/onboarding/complete', json={"version": status1['version'] - 1, "entries": {}}).status_code == 409
        entries = {key: value['value'] for key, value in status1['draft'].items()}
        assert client.post('/api/onboarding/complete', json={"version": status1['version'], "entries": entries}).status_code == 200
        assert client.get('/api/onboarding').json()['onboarded'] is True

        notes = client.get("/api/agent-memory").json()
        assert "计算机组成原理" in notes["user"]
        assert "数字小例子" in notes["user"]
        assert "小步提示" in notes["user"]

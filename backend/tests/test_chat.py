"""Free-chat contract: streaming, idempotent sends, stop/retry, exercises, memories and legacy import."""

import asyncio
import json

from fastapi.testclient import TestClient

from app.agents.llm import ProviderError
from app.chat.service import ChatService
from app.chat.store import ChatStore
from app.main import create_app
from app.memory.store import Store
from app.models.schemas import TutorOutput
from tests.test_acceptance_support import isolated_settings


class FakeChat:
    def __init__(self, replies=(), analyses=()):
        self.replies = list(replies)
        self.analyses = list(analyses)
        self.calls = []
        self.analysis_calls = []

    async def stream(self, messages):
        self.calls.append(messages)
        reply = self.replies.pop(0) if self.replies else "好的。"
        if isinstance(reply, Exception):
            raise reply
        for start in range(0, len(reply), 4):
            yield "text", reply[start:start + 4]
        yield "finish", "stop"

    async def complete_json(self, messages):
        self.analysis_calls.append(json.loads(messages[-1]["content"]))
        result = self.analyses.pop(0) if self.analyses else {}
        if isinstance(result, Exception):
            raise result
        return result


def parse(body: str):
    events = []
    for block in body.strip().split("\n\n"):
        lines = block.split("\n")
        events.append((lines[0].removeprefix("event: "), json.loads(lines[1].removeprefix("data: "))))
    return events


def send(client, conversation_id, content, request_id):
    response = client.post(f"/api/conversations/{conversation_id}/messages",
                           json={"content": content, "client_request_id": request_id})
    assert response.status_code == 200, response.text
    return parse(response.text)


def context_of(call):
    return json.loads(call[1]["content"])


def test_free_chat_streams_persists_and_continues(tmp_path):
    model = FakeChat(["栈是后进先出，队列是先进先出。", "举个例子：叠盘子是栈。"])
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=model)) as client:
        conversation = client.post("/api/conversations", json={}).json()
        assert conversation["title"] == "新对话" and conversation["messages"] == []

        events = send(client, conversation["id"], "我一直分不清栈和队列", "req-00000001")
        names = [name for name, _ in events]
        assert names[0] == "start" and names.count("delta") > 1 and names[-2:] == ["done", "analysis"]
        assert "".join(data["text"] for name, data in events if name == "delta") == "栈是后进先出，队列是先进先出。"
        assert events[0][1]["assistant_message"]["status"] == "streaming"
        assert events[-2][1]["message"]["status"] == "complete"

        send(client, conversation["id"], "能举个例子吗", "req-00000002")
        # The follow-up carries the earlier turn as real chat history.
        assert [m["role"] for m in model.calls[1][2:]] == ["user", "assistant", "user"]
        assert model.calls[1][3]["content"] == "栈是后进先出，队列是先进先出。"

        restored = client.get(f"/api/conversations/{conversation['id']}").json()
        assert restored["title"] == "我一直分不清栈和队列"
        assert [(m["role"], m["status"]) for m in restored["messages"]] == [
            ("user", "complete"), ("assistant", "complete"), ("user", "complete"), ("assistant", "complete"),
        ]
        assert [m["seq"] for m in restored["messages"]] == [1, 2, 3, 4]
        listed = client.get("/api/conversations").json()
        assert listed[0]["id"] == conversation["id"] and listed[0]["message_count"] == 4


def test_same_request_id_never_duplicates(tmp_path):
    model = FakeChat(["第一次回复"])
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=model)) as client:
        conversation_id = client.post("/api/conversations", json={"client_request_id": "new-chat-1"}).json()["id"]
        again = client.post("/api/conversations", json={"client_request_id": "new-chat-1"}).json()["id"]
        assert again == conversation_id and len(client.get("/api/conversations").json()) == 1

        send(client, conversation_id, "你好", "req-dup-0001")
        replay = send(client, conversation_id, "你好", "req-dup-0001")
        assert replay[0][1]["replayed"] is True and len(model.calls) == 1
        assert len(client.get(f"/api/conversations/{conversation_id}").json()["messages"]) == 2


def test_failures_keep_input_and_retry_replaces_failed_reply(tmp_path):
    model = FakeChat([ProviderError(503, "模型服务暂时限流或额度不足，请稍后重试。"), "恢复后的回复"])
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=model)) as client:
        conversation_id = client.post("/api/conversations", json={}).json()["id"]
        events = send(client, conversation_id, "解释一下递归", "req-fail-001")
        assert events[-1][0] == "error" and events[-1][1]["detail"].startswith("模型服务暂时限流")
        messages = client.get(f"/api/conversations/{conversation_id}").json()["messages"]
        assert [(m["role"], m["status"]) for m in messages] == [("user", "complete"), ("assistant", "failed")]

        retried = send(client, conversation_id, "解释一下递归", "req-fail-001")
        assert retried[0][1]["discarded_ids"] == [messages[1]["id"]]
        messages = client.get(f"/api/conversations/{conversation_id}").json()["messages"]
        assert [(m["role"], m["status"], m["content"]) for m in messages] == [
            ("user", "complete", "解释一下递归"), ("assistant", "complete", "恢复后的回复"),
        ]
        # The failed attempt is not part of the model-facing history.
        assert [m["role"] for m in model.calls[1][2:]] == ["user"]


def test_unconfigured_model_reports_real_error(tmp_path):
    with TestClient(create_app(isolated_settings(tmp_path))) as client:
        conversation_id = client.post("/api/conversations", json={}).json()["id"]
        events = send(client, conversation_id, "你好", "req-noconf-1")
        assert [name for name, _ in events] == ["start", "error"]
        assert "模型未配置" in events[-1][1]["detail"]
        assert events[-1][1]["message"]["content"] == ""


def test_conversations_do_not_share_context(tmp_path):
    model = FakeChat(["A1", "B1", "A2"])
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=model)) as client:
        first = client.post("/api/conversations", json={}).json()["id"]
        second = client.post("/api/conversations", json={}).json()["id"]
        send(client, first, "关于栈", "req-ctx-0001")
        send(client, second, "关于哈希表", "req-ctx-0002")
        send(client, first, "继续", "req-ctx-0003")
        assert [m["content"] for m in model.calls[1][2:]] == ["关于哈希表"]
        assert [m["content"] for m in model.calls[2][2:]] == ["关于栈", "A1", "继续"]


def test_regenerate_and_busy_guard(tmp_path):
    model = FakeChat(["旧回复", "新回复"])
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=model)) as client:
        conversation_id = client.post("/api/conversations", json={}).json()["id"]
        assert client.post(f"/api/conversations/{conversation_id}/regenerate").status_code == 409
        send(client, conversation_id, "什么是队列", "req-regen-01")
        response = client.post(f"/api/conversations/{conversation_id}/regenerate")
        assert parse(response.text)[-2][1]["message"]["content"] == "新回复"
        messages = client.get(f"/api/conversations/{conversation_id}").json()["messages"]
        assert [m["content"] for m in messages] == ["什么是队列", "新回复"]
        # Learning analysis runs once per user message, not again on regenerate.
        assert len(model.analysis_calls) == 1


def test_stop_saves_partial_reply_as_cancelled(tmp_path):
    class SlowChat(FakeChat):
        async def stream(self, messages):
            yield "text", "先说栈："
            await asyncio.sleep(30)
            yield "text", "不会到这里"

    async def scenario():
        store = Store(tmp_path / "stop.sqlite3")
        store.initialize()
        chat_store = ChatStore(store)
        chat_store.initialize()
        service = ChatService(chat_store, lambda: SlowChat())
        conversation_id = chat_store.create_conversation("demo-student-001", title=None, problem=None, client_request_id=None)
        user_id = chat_store.add_user_message(conversation_id, "讲讲栈", "req-stop-001")
        generation = service.begin("demo-student-001", conversation_id, user_id, [])
        seen = []
        async for chunk in service.events(generation):
            seen.append(chunk.split("\n")[0])
            if seen[-1] == "event: delta":
                assert service.stop(conversation_id)
        assert seen == ["event: start", "event: delta", "event: cancelled"]
        assert not service.is_generating(conversation_id)
        messages = chat_store.conversation(conversation_id, "demo-student-001").messages
        assert [(m.status, m.content) for m in messages] == [("complete", "讲讲栈"), ("cancelled", "先说栈：")]

    asyncio.run(scenario())


def test_memory_requires_verbatim_evidence_and_is_reused_by_topic(tmp_path):
    misconception = {
        "observations": [
            {"kind": "misconception", "topic": "栈的出入顺序", "summary": "认为栈是先进先出",
             "evidence": "栈就是先进先出的", "reason": "直接陈述了错误的性质", "signal": "supports"},
            {"kind": "misconception", "topic": "队列", "summary": "编造的证据",
             "evidence": "这句话用户没说过", "reason": "无", "signal": "supports"},
        ],
    }
    question_only = {"observations": [
        {"kind": "misconception", "topic": "哈希表", "summary": "不懂哈希冲突",
         "evidence": "哈希冲突是什么？", "reason": "提问", "signal": "supports"},
    ]}
    model = FakeChat(["不对哦，栈是后进先出。", "冲突是指……", "回顾一下栈……"],
                     [misconception, question_only, {"used_memory_ids": ["placeholder"]}])
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=model)) as client:
        first = client.post("/api/conversations", json={}).json()["id"]
        events = send(client, first, "我觉得栈就是先进先出的", "req-mem-0001")
        changes = events[-1][1]["user_message"]["memory_changes"]
        assert len(changes) == 1 and changes[0]["action"] == "created"
        memory = changes[0]["memory"]
        assert memory["status"] == "suspected" and memory["evidence"][0]["quote"] == "栈就是先进先出的"
        assert memory["evidence"][0]["conversation_id"] == first

        send(client, first, "哈希冲突是什么？", "req-mem-0002")
        assert len(client.get("/api/learner-memories").json()) == 1

        second = client.post("/api/conversations", json={}).json()["id"]
        send(client, second, "再讲讲栈的应用", "req-mem-0003")
        assert [m["id"] for m in context_of(model.calls[2])["learner_memories"]] == [memory["id"]]

        corrected = client.patch(f"/api/learner-memories/{memory['id']}",
                                 json={"summary": "曾把栈和队列的顺序记反", "status": "improving"}).json()
        assert corrected["user_corrected"] is True and corrected["summary"] == "曾把栈和队列的顺序记反"
        assert client.patch(f"/api/learner-memories/{memory['id']}", json={"status": "observed"}).status_code == 422
        assert client.delete(f"/api/learner-memories/{memory['id']}").status_code == 204
        assert client.get("/api/learner-memories").json() == []


def test_unrelated_memories_are_not_retrieved(tmp_path):
    analysis = {"observations": [
        {"kind": "misconception", "topic": "二叉树遍历", "summary": "把中序遍历当成先访问根",
         "evidence": "中序遍历先访问根节点", "reason": "错误陈述", "signal": "supports"},
    ]}
    model = FakeChat(["……", "……"], [analysis])
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=model)) as client:
        first = client.post("/api/conversations", json={}).json()["id"]
        send(client, first, "中序遍历先访问根节点", "req-unrel-01")
        second = client.post("/api/conversations", json={}).json()["id"]
        send(client, second, "TCP 三次握手怎么理解", "req-unrel-02")
        assert context_of(model.calls[1])["learner_memories"] == []


def test_exercise_in_chat_uses_reference_and_guard(tmp_path):
    wrong_verdict = {"exercise_attempt": {
        "assessment": "correct", "issue": None, "evidence": "合法，因为每个元素都能出栈", "confidence": 0.8}}
    real_attempt = {"exercise_attempt": {
        "assessment": "incorrect", "issue": "没有检查弹出 3 之后的栈顶",
        "evidence": "我认为该序列合法", "confidence": 0.7}, "suggested_exercise_id": "stack-sequence-002"}
    model = FakeChat(["再想想弹出 3 之后栈顶是谁？", "我们一起模拟一下。", "当然可以。"], [wrong_verdict, real_attempt])
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=model)) as client:
        conversation = client.post("/api/conversations", json={"problem_id": "stack-sequence-001"}).json()
        assert conversation["title"].startswith("练习 · ") and conversation["messages"][0]["kind"] == "exercise"
        assert conversation["active_problem_id"] == "stack-sequence-001"

        events = send(client, conversation["id"], "合法，因为每个元素都能出栈", "req-ex-00001")
        assert context_of(model.calls[0])["active_exercise"]["id"] == "stack-sequence-001"
        assert "reference" not in context_of(model.calls[0])["active_exercise"]
        # The model called an impossible sequence "correct": the checked reference vetoes that verdict.
        assert events[-1][1]["user_message"]["attempt"] is None

        events = send(client, conversation["id"], "我认为该序列合法", "req-ex-00002")
        attempt = events[-1][1]["user_message"]["attempt"]
        assert attempt["assessment"] == "incorrect" and attempt["problem_id"] == "stack-sequence-001"
        assert events[-1][1]["assistant_message"]["suggested_problem_id"] == "stack-sequence-002"

        # Practice continues inside the same conversation, then chat carries on.
        updated = client.post(f"/api/conversations/{conversation['id']}/exercises",
                              json={"problem_id": "stack-sequence-002"}).json()
        assert updated["messages"][-1]["kind"] == "exercise" and updated["active_problem_id"] == "stack-sequence-002"
        send(client, conversation["id"], "先换个话题，讲讲队列", "req-ex-00003")
        assert model.calls[2][-2]["content"].startswith("【练习题 · 栈的出栈序列 · 2】")


def test_rename_delete_and_missing(tmp_path):
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=FakeChat())) as client:
        conversation_id = client.post("/api/conversations", json={}).json()["id"]
        assert client.patch(f"/api/conversations/{conversation_id}", json={"title": "栈复习"}).json()["title"] == "栈复习"
        send(client, conversation_id, "第一条消息不会覆盖手动标题", "req-title-01")
        assert client.get(f"/api/conversations/{conversation_id}").json()["title"] == "栈复习"
        assert client.delete(f"/api/conversations/{conversation_id}").status_code == 204
        assert client.get(f"/api/conversations/{conversation_id}").status_code == 404
        response = client.post(f"/api/conversations/{conversation_id}/messages",
                               json={"content": "hi", "client_request_id": "req-gone-001"})
        assert response.status_code == 404


def test_legacy_sessions_and_memories_are_imported_once(tmp_path):
    class Tutor:
        async def generate(self, context):
            return TutorOutput(assessment="incorrect", issue="没有检查栈顶", confidence=0.7,
                               evidence="我认为该序列合法", reply="弹出 3 后栈顶是谁？")

    settings = isolated_settings(tmp_path)
    with TestClient(create_app(settings, tutor=Tutor(), chat_model=FakeChat())) as client:
        legacy = client.post("/api/diagnosis", json={"problem_id": "stack-sequence-001", "answer": "我认为该序列合法"}).json()
        conversations = client.get("/api/conversations").json()
        assert len(conversations) == 1 and conversations[0]["legacy_session_id"] == legacy["session_id"]
        detail = client.get(f"/api/conversations/{conversations[0]['id']}").json()
        assert [m["kind"] for m in detail["messages"]] == ["exercise", "text", "text"]
        assert detail["messages"][1]["attempt"]["assessment"] == "incorrect"
        memories = client.get("/api/learner-memories").json()
        assert len(memories) == 1 and memories[0]["origin"] == "diagnosis"
        assert memories[0]["evidence"][0]["conversation_id"] == conversations[0]["id"]
        client.delete(f"/api/learner-memories/{memories[0]['id']}")
        # Legacy rows are untouched and the old API still answers.
        assert client.get(f"/api/sessions/{legacy['session_id']}").status_code == 200

    with TestClient(create_app(settings, tutor=Tutor(), chat_model=FakeChat())) as client:
        assert len(client.get("/api/conversations").json()) == 1
        assert client.get("/api/learner-memories").json() == []


def test_openai_compatible_stream_parsing(tmp_path):
    import httpx
    from app.agents.llm import ChatCompletionsChat

    def handler(request):
        assert json.loads(request.content)["stream"] is True
        if request.headers["authorization"] == "Bearer bad":
            return httpx.Response(401, json={"error": "nope"})
        body = (
            'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n'
            'data: {"choices":[{"delta":{"content":"栈是"}}]}\n\n'
            ': keep-alive\n\n'
            'data: {"choices":[{"delta":{"content":"后进先出"},"finish_reason":"length"}]}\n\n'
            'data: [DONE]\n\n'
        )
        return httpx.Response(200, text=body, headers={"content-type": "text/event-stream"})

    async def collect(key):
        settings = isolated_settings(tmp_path).model_copy(update={
            "llm_api_key": __import__("pydantic").SecretStr(key), "llm_base_url": "https://llm.test/v1", "llm_model": "m",
        })
        return [item async for item in ChatCompletionsChat(settings, httpx.MockTransport(handler)).stream([])]

    assert asyncio.run(collect("good")) == [("text", "栈是"), ("text", "后进先出"), ("finish", "length")]
    try:
        asyncio.run(collect("bad"))
    except ProviderError as exc:
        assert exc.status_code == 503 and "拒绝访问" in exc.detail
    else:
        raise AssertionError("401 must surface as a provider error")

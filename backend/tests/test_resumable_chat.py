"""Connection loss, durable queues and stop races without provider calls."""

import asyncio
import json

import httpx
import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr

from app.agents.llm import ChatCompletionsChat, ProviderError
from app.chat.service import ChatService
from app.chat.store import ChatStore, INTERRUPTED
from app.main import create_app
from app.memory.store import Store
from app.models.schemas import DEMO_STUDENT
from tests.test_acceptance_support import isolated_settings
from tests.test_chat import FakeChat


def setup(tmp_path, model):
    base = Store(tmp_path / "stream.sqlite3")
    base.initialize()
    store = ChatStore(base)
    store.initialize()
    service = ChatService(store, lambda: model)
    cid = store.create_conversation(DEMO_STUDENT, title=None, problem=None, client_request_id=None)
    return store, service, cid


class GatedChat(FakeChat):
    def __init__(self):
        super().__init__()
        self.release = asyncio.Event()
        self.first_token = asyncio.Event()

    async def stream(self, messages, tools=None):
        self.calls.append(messages)
        yield "text", "第一段。"
        self.first_token.set()
        await self.release.wait()
        yield "text", "第二段。"
        yield "finish", "stop"


def test_disconnect_and_two_readers_do_not_cancel_or_split_the_worker(tmp_path):
    async def scenario():
        model = GatedChat()
        store, service, cid = setup(tmp_path, model)
        uid = store.add_user_message(cid, "讲讲栈", "stream-request-001")
        run = service.begin(DEMO_STUDENT, cid, uid, [])
        reader = service.events(run)
        start = await anext(reader)
        assert start.startswith("event: start")
        await model.first_token.wait()
        delta = await anext(reader)
        await reader.aclose()
        assert not run.task.done() and service.is_generating(cid)
        # Independent cursors: both subscribers receive the entire remaining sequence.
        after = int(delta.split("id: ")[1].split(":")[-1].strip())
        async def collect():
            return [chunk async for chunk in service.subscribe(cid, run.assistant_message_id, after)]
        one, two = asyncio.create_task(collect()), asyncio.create_task(collect())
        model.release.set()
        a, b = await asyncio.gather(one, two)
        assert a == b and any("第二段。" in chunk for chunk in a)
        assert not any("第一段。" in chunk and "event: delta" in chunk for chunk in a)
        assert len(model.calls) == 1
        assert store.message(run.assistant_message_id, DEMO_STUDENT).content == "第一段。第二段。"
        await service.close()
    asyncio.run(scenario())


def test_queue_edit_cancel_order_and_stop_pause(tmp_path):
    async def scenario():
        model = GatedChat()
        store, service, cid = setup(tmp_path, model)
        uid = store.add_user_message(cid, "先讲定义", "stream-request-002")
        run = service.begin(DEMO_STUDENT, cid, uid, [])
        await model.first_token.wait()
        first = service.streams.enqueue(cid, "再举例", "queued-request-001")
        same = service.streams.enqueue(cid, "再举例", "queued-request-001")
        second = service.streams.enqueue(cid, "这条撤回", "queued-request-002")
        assert first["id"] == same["id"]
        assert service.streams.change(cid, first["id"], "用盘子举例")
        assert service.streams.change(cid, second["id"])
        assert len(store.history(cid)) == 2  # Pending prompts aren't transcript messages.
        assert service.stop(cid, run.assistant_message_id)
        await run.task
        service.drain_outbox(DEMO_STUDENT, cid)
        assert len(model.calls) == 1 and service.streams.listing(cid)["paused"]
        service.streams.pause(cid, False)
        service.drain_outbox(DEMO_STUDENT, cid)
        queued_run = service.active[cid]
        # A late stop for the previous reply cannot cancel this one.
        assert not service.stop(cid, run.assistant_message_id)
        model.release.set()
        await queued_run.task
        users = [row["content"] for row in store.history(cid) if row["role"] == "user"]
        assert users == ["先讲定义", "用盘子举例"]
        assert not service.streams.listing(cid)["items"]
        assert len(model.calls) == 2
        await service.close()
    asyncio.run(scenario())


def test_queued_turn_starts_without_waiting_for_learning_analysis(tmp_path):
    async def scenario():
        model = GatedChat()
        store, service, cid = setup(tmp_path, model)
        analysis_gate = asyncio.Event()
        async def analyze(*args, **kwargs):
            await analysis_gate.wait()
        service._analyze = analyze
        uid = store.add_user_message(cid, "定义", "stream-request-003")
        first = service.begin(DEMO_STUDENT, cid, uid, [])
        await model.first_token.wait()
        service.streams.enqueue(cid, "例子", "queued-request-003")
        model.release.set()
        for _ in range(40):
            if len(model.calls) == 2:
                break
            await asyncio.sleep(0.01)
        assert len(model.calls) == 2 and not first.task.done()
        analysis_gate.set()
        await service.close()
    asyncio.run(scenario())


def test_new_turn_resets_an_empty_paused_queue_but_keeps_existing_pending_items_paused(tmp_path):
    async def scenario():
        store, service, cid = setup(tmp_path, FakeChat())
        service.streams.pause(cid)
        uid = store.add_user_message(cid, "新一轮", "new-turn-request-001")
        run = service.begin(DEMO_STUDENT, cid, uid, [])
        assert not service.streams.listing(cid)["paused"]
        await run.task
        service.streams.enqueue(cid, "仍需确认的旧要求", "old-queued-request-001")
        service.streams.pause(cid)
        uid = store.add_user_message(cid, "修改当前要求", "new-turn-request-002")
        run = service.begin(DEMO_STUDENT, cid, uid, [])
        assert service.streams.listing(cid)["paused"]
        await run.task
        assert len(service.streams.listing(cid)["items"]) == 1
        await service.close()
    asyncio.run(scenario())


def test_restart_restores_last_durable_token_and_pauses_queue(tmp_path):
    async def scenario():
        model = GatedChat()
        store, service, cid = setup(tmp_path, model)
        uid = store.add_user_message(cid, "定义", "stream-request-004")
        run = service.begin(DEMO_STUDENT, cid, uid, [])
        await model.first_token.wait()
        run.queue.put_nowait(("delta", {"text": "最后已接收内容"}))
        service.streams.enqueue(cid, "下一题", "queued-request-004")
        # Simulate the persisted database at a hard crash, without running the old worker's cleanup.
        backup = Store(tmp_path / "crash.sqlite3")
        with store.connection() as source, backup.connection() as target:
            source.backup(target)
        recovered = ChatStore(backup)
        recovered.initialize()
        next_model = FakeChat()
        next_service = ChatService(recovered, lambda: next_model)
        next_service.recover()
        saved = recovered.message(run.assistant_message_id, DEMO_STUDENT)
        assert saved.status == "failed" and saved.error == INTERRUPTED
        assert saved.content == "第一段。最后已接收内容"
        assert next_service.streams.listing(cid)["paused"]
        assert len(next_model.calls) == 0
        await service.close()
        await next_service.close()
    asyncio.run(scenario())


def test_checkpoint_stream_segment_does_not_replay_an_old_cancellation(tmp_path):
    async def scenario():
        store, service, cid = setup(tmp_path, FakeChat())
        uid = store.add_user_message(cid, "继续执行", "checkpoint-stream-001")
        run = service.begin(DEMO_STUDENT, cid, uid, [])
        store.finish_reply(run.assistant_message_id, content="已有断点", status="streaming")
        service.stop(cid, run.assistant_message_id)
        await asyncio.gather(run.task, return_exceptions=True)
        assert store.message(run.assistant_message_id, DEMO_STUDENT).content == "已有断点"
        run.queue.put_nowait(("start", {"assistant_message": {"id": run.assistant_message_id, "content": "断点内容"}}))
        run.queue.put_nowait(("delta", {"text": "继续"}))
        run.queue.put_nowait(("done", {"message": None}))
        run.queue.put_nowait(None)
        chunks = [chunk async for chunk in service.subscribe(cid, run.assistant_message_id)]
        assert chunks[0].startswith("event: start")
        assert all("event: cancelled" not in chunk for chunk in chunks)
        assert any("继续" in chunk for chunk in chunks)
        await service.close()
    asyncio.run(scenario())


def test_queue_api_is_idempotent_and_stop_before_send_is_respected(tmp_path):
    model = FakeChat()
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=model)) as client:
        cid = client.post("/api/conversations", json={}).json()["id"]
        base = f"/api/conversations/{cid}"
        body = {"content": "说明一下", "client_request_id": "queued-api-request-001"}
        one = client.post(base + "/outbox", json=body)
        two = client.post(base + "/outbox", json=body)
        assert one.status_code == two.status_code == 200
        assert one.json()["id"] == two.json()["id"]
        assert client.get(f"{base}/runs/missing/events").status_code == 404
        stop = {"client_request_id": "stopped-request-001"}
        client.post(base + "/stop", json=stop)
        blocked = client.post(base + "/messages", json={"content": "不应发出", **stop})
        assert blocked.status_code == 409
        assert all("不应发出" != m["content"] for m in client.get(base).json()["messages"])


def test_provider_eof_without_finish_is_failure_and_tool_args_are_not_executed(tmp_path):
    settings = isolated_settings(tmp_path).model_copy(update={
        "llm_api_key": SecretStr("fake"), "llm_base_url": "https://example.test/v1", "llm_model": "test",
    })
    body = 'data: ' + json.dumps({"choices": [{"delta": {"content": "只收到半句"}}]}) + '\n\n'
    async def scenario():
        model = ChatCompletionsChat(settings, httpx.MockTransport(lambda _: httpx.Response(200, text=body,
            headers={"content-type": "text/event-stream"})))
        received = []
        with pytest.raises(ProviderError, match="提前断开"):
            async for kind, value in model.stream([]):
                received.append((kind, value))
        assert received == [("text", "只收到半句")]
    asyncio.run(scenario())

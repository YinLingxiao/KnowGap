"""Coordinator-to-worker delivery, background execution and persisted reports."""

import asyncio
import json

import pytest

from app.agents.llm import ProviderError
from app.chat.coordination import dispatch, next_delivery
from app.chat.service import ChatService
from app.chat.store import ChatStore
from app.memory.store import Store
from app.services.materials import MaterialStore
from tests.test_chat import FakeChat, context_of

STUDENT = "demo-student-001"


class WorkspaceSettings:
    """开发者模式：绑定了工作区，模型才拿得到文件与命令工具。"""

    def __init__(self, path):
        self.path = str(path)

    def agent_config(self):
        return {"workspace": self.path}


def setup(tmp_path, model, workspace=False):
    base = Store(tmp_path / "coordination.sqlite3")
    base.initialize()
    MaterialStore(base).initialize()
    store = ChatStore(base)
    store.initialize()
    sid = store.create_subject(STUDENT, "Java", "", "").id
    main = store.subject(sid, STUDENT).main_conversation_id
    settings = WorkspaceSettings(tmp_path) if workspace else None
    return store, ChatService(store, lambda: model, settings=settings), sid, main


async def settle(service):
    for _ in range(30):
        await asyncio.sleep(0)
        if not service.tasks:
            return
        await asyncio.wait_for(asyncio.gather(*list(service.tasks)), 3)
    pytest.fail("worker queue did not settle")


class Coordinator(FakeChat):
    def __init__(self, *, blocked=False, fail=False, approval=False):
        super().__init__()
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        self.blocked, self.fail, self.approval = blocked, fail, approval
        self.worker_inputs = []
        self.worker_histories = []

    async def stream(self, messages, tools=None):
        self.calls.append(messages)
        context = context_of(messages)
        role = context["conversation_role"]["role"]
        names = {t["function"]["name"] for t in tools}
        latest = next(m["content"] for m in reversed(messages) if m["role"] == "user")
        if messages[-1]["role"] == "tool":
            yield "text", "已交办。" if role == "main" else "请在侧栏回答这道题。"
        elif role == "main":
            assert "dispatch_thread" in names and "write" not in names
            if latest == "你好":
                yield "text", "你好。"
            else:
                arguments = {"title": "Java 第三单元", "task": "按课件逐步复习，用小题检查理解。"}
                threads = context["conversation_role"]["threads"]
                if threads:
                    arguments["thread_id"] = threads[0]["id"]
                yield "tool_calls", [{"id": "delegate", "name": "dispatch_thread", "arguments": json.dumps(arguments)}]
        else:
            assert "dispatch_thread" not in names and "report_progress" in names
            assert context["conversation_role"]["delegated_task"]
            self.worker_inputs.append(latest)
            self.worker_histories.append([dict(message) for message in messages])
            self.started.set()
            yield "text", "先看对象和类的区别。"
            if self.blocked:
                await self.release.wait()
            if self.fail:
                raise ProviderError(502, "上游模型不可用")
            yield "tool_calls", [{"id": "worker-tool", "name": "write" if self.approval else "report_progress",
                                   "arguments": json.dumps({"path": "notes.txt", "content": "example"} if self.approval else
                                                         {"summary": "已讲解对象与类，等待学生完成第一题。", "needs_user": True})}]
        yield "finish", "stop"


def test_main_dispatch_starts_worker_reports_and_routes_followups(tmp_path):
    async def scenario():
        model = Coordinator()
        store, service, sid, main = setup(tmp_path, model)
        user = store.add_user_message(main, "带我复习第三单元", "coordinator-0001")
        events = [e async for e in service.events(service.begin(STUDENT, main, user, []))]
        await settle(service)
        threads = store.threads(sid, STUDENT)
        assert len(threads) == 1 and threads[0].execution_status == "waiting"
        worker_id = threads[0].id
        worker = store.conversation(worker_id, STUDENT)
        assert worker.messages[0].content == "带我复习第三单元"
        assert worker.messages[-1].status == "complete"
        main_messages = {m.id: m for m in store.conversation(main, STUDENT).messages}
        assert [item.thread_id for item in main_messages[user].dispatched_threads] == [worker_id]
        assert any("event: thread_dispatched" in e for e in events)
        # A replay and a repeated dispatch in the same coordinator turn never deliver again.
        _ = [e async for e in service.replay(STUDENT, main, user, store.replies(user)[-1]["id"])]
        service._dispatch_thread(STUDENT, service.begin(STUDENT, main, user, [store.replies(user)[-1]["id"]]),
                                 {"title": "Java 第三单元", "task": "重复交办"})
        await settle(service)
        assert len(store.threads(sid, STUDENT)) == 1 and len(model.worker_inputs) == 1
        followup = store.add_user_message(main, "还有第14页", "coordinator-0002")
        _ = [e async for e in service.events(service.begin(STUDENT, main, followup, []))]
        await settle(service)
        assert len(store.threads(sid, STUDENT)) == 1
        assert model.worker_inputs == ["带我复习第三单元", "还有第14页"]
        messages = store.conversation(main, STUDENT).messages
        by_id = {m.id: m for m in messages}
        assert [item.thread_id for item in by_id[followup].dispatched_threads] == [worker_id]
        # 主线只有协调者的回复：用户在支线里又聊了一轮，主线没有多出任何消息
        assert [m.role for m in messages] == ["user", "assistant", "user", "assistant"]
        await service.close()
    asyncio.run(scenario())


def test_busy_worker_queues_followups_in_order_and_preserves_original_input(tmp_path):
    async def scenario():
        model = Coordinator(blocked=True)
        store, service, sid, main = setup(tmp_path, model)
        user = store.add_user_message(main, "先学第三单元", "busy-main-0001")
        coordinator = service.begin(STUDENT, main, user, [])
        _ = [e async for e in service.events(coordinator)]
        await asyncio.wait_for(model.started.wait(), 3)
        worker = store.threads(sid, STUDENT)[0].id
        for index, text in enumerate(["还有第14页", "重点看继承"]):
            source = store.add_user_message(main, text, f"busy-followup-{index}")
            _ = [e async for e in service.events(service.begin(STUDENT, main, source, []))]
        assert model.worker_inputs == ["先学第三单元"]
        assert next_delivery(store, worker)
        model.release.set()
        await settle(service)
        assert model.worker_inputs == ["先学第三单元", "还有第14页", "重点看继承"]
        # Earlier replies stay attached to their turn even if newer input was already queued.
        third_history = model.worker_histories[2][2:]
        assert third_history[-1]["role"] == "user" and third_history[-1]["content"] == "重点看继承"
        assert len([message for message in third_history if message["role"] == "assistant"
                    and "请在侧栏回答" in (message.get("content") or "")]) == 2
        assert next_delivery(store, worker) is None
        assert all(m.status == "complete" for m in store.conversation(worker, STUDENT).messages)
        await service.close()
    asyncio.run(scenario())


def test_workers_survive_observer_disconnect_and_surface_approval_and_stop(tmp_path):
    async def scenario():
        model = Coordinator(approval=True)
        store, service, sid, main = setup(tmp_path, model, workspace=True)
        source = store.add_user_message(main, "把讲解记到文件", "approval-main-01")
        _ = [e async for e in service.events(service.begin(STUDENT, main, source, []))]
        worker = store.threads(sid, STUDENT)[0].id
        generation = service.active[worker]
        observer = service.events(generation)
        await anext(observer)
        await observer.aclose()
        for _ in range(100):
            message = store.message(generation.assistant_message_id, STUDENT)
            if message.pending_approval:
                break
            await asyncio.sleep(0.01)
        else:
            pytest.fail("approval was not persisted for the sidebar")
        assert not generation.task.done()
        assert store.conversation(worker, STUDENT).execution_status == "waiting"
        assert service.stop(worker)
        await settle(service)
        assert store.message(generation.assistant_message_id, STUDENT).status == "cancelled"
        assert store.message(generation.assistant_message_id, STUDENT).pending_approval is None
        assert store.conversation(worker, STUDENT).execution_status == "cancelled"
        await service.close()
    asyncio.run(scenario())


def test_dispatch_scope_validation_and_provider_failure(tmp_path):
    async def scenario():
        model = Coordinator(fail=True)
        store, service, sid, main = setup(tmp_path, model)
        source = store.add_user_message(main, "复习", "failure-main-001")
        other_sid = store.create_subject(STUDENT, "数学", "", "").id
        other = store.create_thread(STUDENT, other_sid, title="代数", anchor_message_id=None, client_request_id="other-thread-001")
        with pytest.raises(ValueError, match="本学习空间"):
            dispatch(store, STUDENT, main, source, "代数", "越界任务", other)
        with pytest.raises(ValueError, match="主线"):
            dispatch(store, "another-student", main, source, "Java", "任务", None)
        _ = [e async for e in service.events(service.begin(STUDENT, main, source, []))]
        await settle(service)
        worker = store.threads(sid, STUDENT)[0].id
        failed = store.conversation(worker, STUDENT)
        assert failed.execution_status == "failed"
        assert "上游模型不可用" in (failed.messages[-1].error or "")
        await service.close()
    asyncio.run(scenario())


def test_blank_thread_id_from_the_model_means_a_new_thread(tmp_path):
    # GPT 类模型对可选参数常传 ""：不能当成一个叫 "" 的支线，否则写消息时外键失败
    from app.chat.schemas import DispatchThread

    body = DispatchThread(title="Cache 练习", task="按考研题型练习", thread_id="", skill="")
    assert body.thread_id is None and body.skill is None
    assert DispatchThread(title="t", task="x", thread_id="  ").thread_id is None
    assert DispatchThread(title="t", task="x", thread_id="conv-1").thread_id == "conv-1"

    async def scenario():
        store, service, sid, main = setup(tmp_path, Coordinator())
        source = store.add_user_message(main, "搜两道题", "blank-thread-001")
        thread_id, message_id = dispatch(store, STUDENT, main, source, "Cache 练习", "任务", "")
        assert thread_id and store.conversation(thread_id, STUDENT).parent_id == main
        assert store.threads(sid, STUDENT)[0].id == thread_id and message_id
        await service.close()
    asyncio.run(scenario())


def test_quick_question_stays_in_main_and_direct_thread_reply_reports_back(tmp_path):
    async def scenario():
        model = Coordinator()
        store, service, sid, main = setup(tmp_path, model)
        user = store.add_user_message(main, "你好", "quick-main-0001")
        _ = [e async for e in service.events(service.begin(STUDENT, main, user, []))]
        await settle(service)
        assert store.threads(sid, STUDENT) == []
        source = store.add_user_message(main, "复习", "quick-main-0002")
        _ = [e async for e in service.events(service.begin(STUDENT, main, source, []))]
        await settle(service)
        worker = store.threads(sid, STUDENT)[0].id
        # Direct sidebar input has no delegated brief and goes directly to its worker.
        direct = store.add_user_message(worker, "类是对象的模板", "sidebar-user-001")
        main_before = [m.id for m in store.conversation(main, STUDENT).messages]
        plain = FakeChat(["理解正确，接下来学构造方法。"], analyses=[{
            "thread_report": {"summary": "已讲解类与对象，接着讲构造方法。", "needs_user": False},
        }])
        service.model = lambda: plain
        _ = [e async for e in service.events(service.begin(STUDENT, worker, direct, []))]
        await settle(service)
        reply = store.conversation(worker, STUDENT).messages[-1]
        assert "构造方法" in store.message_meta(reply.id)["progress_summary"]
        # 支线自己聊的一轮不往主线写任何东西
        assert [m.id for m in store.conversation(main, STUDENT).messages] == main_before
        assert len(store.threads(sid, STUDENT)) == 1
        await service.close()
    asyncio.run(scenario())


def test_analysis_supplies_concise_report_for_direct_sidebar_turn(tmp_path):
    async def scenario():
        model = FakeChat(["很长的教学过程，最后问学生一道题。"], analyses=[{
            "thread_report": {"summary": "已检查回答，等待完成下一道判断题。", "needs_user": True},
        }])
        store, service, sid, main = setup(tmp_path, model)
        worker = store.create_thread(STUDENT, sid, title="类与对象", anchor_message_id=None,
                                     client_request_id="summary-thread-01")
        user = store.add_user_message(worker, "类像图纸", "summary-user-001")
        _ = [e async for e in service.events(service.begin(STUDENT, worker, user, []))]
        await settle(service)
        assert store.conversation(worker, STUDENT).execution_status == "waiting"
        assert store.message_meta(store.conversation(worker, STUDENT).messages[-1].id)["progress_summary"] == (
            "已检查回答，等待完成下一道判断题。")
        assert model.analysis_calls[0]["report_thread"] is True
        await service.close()
    asyncio.run(scenario())


def test_recovery_starts_queued_independent_threads_once(tmp_path):
    async def scenario():
        model = Coordinator()
        store, service, sid, main = setup(tmp_path, model)
        user = store.add_user_message(main, "复习类与对象，再检查继承", "recovery-main-01")
        first, _ = dispatch(store, STUDENT, main, user, "类与对象", "复习", None)
        second, _ = dispatch(store, STUDENT, main, user, "继承", "检查理解", None)
        assert first != second
        service.recover()
        await settle(service)
        service.recover()
        await settle(service)
        assert len(model.worker_inputs) == 2
        assert len(store.threads(sid, STUDENT)) == 2
        source = store.conversation(main, STUDENT).messages[0]
        assert len(source.dispatched_threads) == 2
        await service.close()
    asyncio.run(scenario())


def test_stop_cancels_current_and_queued_deliveries(tmp_path):
    async def scenario():
        model = Coordinator(blocked=True)
        store, service, sid, main = setup(tmp_path, model)
        first = store.add_user_message(main, "复习", "stop-main-0001")
        _ = [e async for e in service.events(service.begin(STUDENT, main, first, []))]
        await asyncio.wait_for(model.started.wait(), 3)
        worker = store.threads(sid, STUDENT)[0].id
        second = store.add_user_message(main, "补充第14页", "stop-main-0002")
        _ = [e async for e in service.events(service.begin(STUDENT, main, second, []))]
        assert next_delivery(store, worker)
        assert service.stop(worker)
        await settle(service)
        assert next_delivery(store, worker) is None
        assert model.worker_inputs == ["复习"]
        # 停止与取消都只发生在支线里，主线没有多出任何消息
        assert [m.role for m in store.conversation(main, STUDENT).messages] == [
            "user", "assistant", "user", "assistant"]
        service.recover()
        await settle(service)
        assert model.worker_inputs == ["复习"]
        await service.close()
    asyncio.run(scenario())


def test_concurrent_thread_limit(tmp_path):
    async def scenario():
        gate = asyncio.Event()
        two_started = asyncio.Event()
        started, running, peak = [], 0, 0

        class LimitedModel(FakeChat):
            async def stream(self, messages, tools=None):
                nonlocal running, peak
                context = context_of(messages)
                if context["conversation_role"]["role"] == "main":
                    if messages[-1]["role"] == "tool":
                        yield "text", "已交办。"
                    else:
                        yield "tool_calls", [
                            {"id": f"dispatch-{i}", "name": "dispatch_thread",
                             "arguments": json.dumps({"title": f"T{i+1}", "task": f"task {i+1}"})}
                            for i in range(4)
                        ]
                else:
                    running += 1
                    peak = max(peak, running)
                    started.append(context["conversation_role"]["delegated_task"])
                    if len(started) == 2:
                        two_started.set()
                    try:
                        await gate.wait()
                        yield "text", "Thread done"
                    finally:
                        running -= 1
                yield "finish", "stop"

        store, service, sid, main = setup(tmp_path, LimitedModel())
        try:
            user = store.add_user_message(main, "开四个任务", "concurrent-limit-001")
            _ = [e async for e in service.events(service.begin(STUDENT, main, user, []))]
            await asyncio.wait_for(two_started.wait(), 3)
            threads = store.threads(sid, STUDENT)
            assert len(threads) == 4
            assert sum(t.execution_status == "working" for t in threads) == 2
            assert sum(t.execution_status == "queued" for t in threads) == 2
            assert service._count_running_threads(STUDENT, main) == 2
            assert len(started) == 2
            gate.set()
            await settle(service)
            assert len(started) == 4 and peak == 2
            assert all(t.execution_status == "idle" for t in store.threads(sid, STUDENT))
        finally:
            await service.close()
    asyncio.run(scenario())


@pytest.mark.parametrize("end", ["failure", "stop"])
def test_slot_released_on_failure_or_stop_and_queued_task_can_be_cancelled(tmp_path, end):
    async def scenario():
        started = asyncio.Queue()
        gates = {str(i): asyncio.Event() for i in range(4)}
        fail_task = None
        class Model(FakeChat):
            async def stream(self, messages, tools=None):
                task = context_of(messages)["conversation_role"]["delegated_task"]
                started.put_nowait(task)
                await gates[task].wait()
                if task == fail_task and end == "failure":
                    raise ProviderError(502, "test failure")
                yield "text", "完成"
                yield "finish", "stop"
        store, service, sid, main = setup(tmp_path, Model())
        user = store.add_user_message(main, "四个任务", "slot-release-001")
        ids = [dispatch(store, STUDENT, main, user, f"T{i}", str(i), None)[0] for i in range(4)]
        try:
            # Exercise durable startup recovery, not just a live coordinator dispatch.
            service.recover()
            first_two = {await asyncio.wait_for(started.get(), 3) for _ in range(2)}
            assert len(first_two) == 2 and service._count_running_threads(STUDENT, main) == 2
            first = next(iter(first_two))
            if end == "stop":
                assert service.stop(ids[int(first)])
            else:
                # Only one chosen worker fails; the other is kept running to exercise the slot.
                fail_task = first
                gates[first].set()
            third = await asyncio.wait_for(started.get(), 3)
            assert third not in first_two
            waiting = next(str(i) for i in range(4) if str(i) not in first_two | {third})
            assert service.stop(ids[int(waiting)])
            assert next_delivery(store, ids[int(waiting)]) is None
            for gate in gates.values():
                gate.set()
            await settle(service)
            assert started.empty()
            assert store.conversation(ids[int(waiting)], STUDENT).execution_status == "cancelled"
            assert store.conversation(ids[int(first)], STUDENT).execution_status == ("failed" if end == "failure" else "cancelled")
            assert not service.active
        finally:
            await service.close()
    asyncio.run(scenario())


def test_propose_threads_stores_proposals_in_meta(tmp_path):
    async def scenario():
        class ProposingModel(FakeChat):
            async def stream(self, messages):
                from app.chat.agent import learning_context
                context = learning_context(messages)
                if messages[-1]["role"] == "tool":
                    yield "text", "请选择一项开始。"
                elif context["conversation_role"]["role"] == "main":
                    yield "text", "我建议你可以从以下几个方向入手："
                    yield "tool_calls", [{
                        "id": "propose-1",
                        "name": "propose_threads",
                        "arguments": json.dumps({
                            "proposals": [
                                {"title": "基础语法", "task": "学习基础语法结构", "reason": "打好基础"},
                                {"title": "常用词汇", "task": "背诵常用词汇", "reason": "扩充词汇量"},
                            ]
                        })
                    }]
                    yield "finish", "stop"
                else:
                    async for item in super().stream(messages):
                        yield item

        model = ProposingModel()
        store, service, sid, main = setup(tmp_path, model)
        user = store.add_user_message(main, "我该怎么学", "propose-001")
        _ = [e async for e in service.events(service.begin(STUDENT, main, user, []))]
        await settle(service)

        # Check that proposals are stored in meta
        replies = store.replies(user)
        assert len(replies) == 1
        meta = json.loads(replies[0]["meta_json"])
        assert "thread_proposals" in meta
        proposals = meta["thread_proposals"]
        assert len(proposals) == 2
        assert proposals[0]["title"] == "基础语法"
        assert proposals[1]["title"] == "常用词汇"

        # No threads should be created yet
        threads = store.threads(sid, STUDENT)
        assert len(threads) == 0

        await service.close()

    asyncio.run(scenario())


class GatedWorkers(FakeChat):
    def __init__(self, *, fail_first=False):
        super().__init__()
        self.fail_first = fail_first
        self.started = asyncio.Queue()
        self.gates = {str(i): asyncio.Event() for i in range(4)}
        self.inputs = []
        self.running = 0
        self.peak = 0

    async def stream(self, messages, tools=None):
        task = context_of(messages)["conversation_role"]["delegated_task"]
        if self.fail_first and task == "0":
            self.fail_first = False
            raise ProviderError(502, "测试首次生成中断")
        self.inputs.append(task)
        self.running += 1
        self.peak = max(self.peak, self.running)
        self.started.put_nowait(task)
        try:
            await self.gates[task].wait()
            yield "text", "任务完成。"
            yield "finish", "stop"
        finally:
            self.running -= 1

    async def next_started(self):
        return await asyncio.wait_for(self.started.get(), 3)


@pytest.mark.parametrize("resume_first", [False, True], ids=["normal", "checkpoint"])
def test_delete_running_workers_via_http_fills_their_slots(tmp_path, resume_first):
    from fastapi.testclient import TestClient
    from app.main import create_app
    from tests.test_acceptance_support import isolated_settings

    model = GatedWorkers(fail_first=resume_first)
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=model)) as client:
        service = client.app.state.chat_service
        store = service.store
        space = client.post("/api/subjects", json={"name": "删除任务补位"}).json()
        main = space["main_conversation_id"]

        async def seed():
            source = store.add_user_message(main, "执行四项任务", "delete-workers-source")
            first, _ = dispatch(store, STUDENT, main, source, "T0", "0", None)
            reply_id = None
            if resume_first:
                service._start_delivery(STUDENT, first)
                await settle(service)
                reply = store.conversation(first, STUDENT).messages[-1]
                assert reply.status == "failed" and reply.checkpoint_available
                reply_id = reply.id
            ids = [first] + [
                dispatch(store, STUDENT, main, source, f"T{i}", str(i), None)[0] for i in range(1, 4)
            ]
            if not resume_first:
                for cid in ids:
                    service._start_delivery(STUDENT, cid)
            return ids, reply_id

        ids, reply_id = client.portal.call(seed)
        if resume_first:
            response = client.post(f"/api/conversations/{ids[0]}/messages/{reply_id}/resume")
            assert response.status_code == 200, response.text
            async def start_remaining():
                for cid in ids[1:]:
                    service._start_delivery(STUDENT, cid)
            client.portal.call(start_remaining)

        assert {client.portal.call(model.next_started) for _ in range(2)} == {"0", "1"}
        assert model.running == 2
        for index in range(2):
            assert client.delete(f"/api/conversations/{ids[index]}").status_code == 204
            assert client.portal.call(model.next_started) == str(index + 2)
            assert client.get(f"/api/conversations/{ids[index]}").status_code == 404
            assert model.running == 2
        assert model.inputs == ["0", "1", "2", "3"] and model.peak == 2

        async def finish():
            for gate in model.gates.values():
                gate.set()
            await settle(service)
        client.portal.call(finish)
        assert not service.active and model.running == 0
        assert model.inputs == ["0", "1", "2", "3"]
        assert all(client.get(f"/api/conversations/{cid}").json()["messages"][-1]["status"] == "complete"
                   for cid in ids[2:])


def test_failed_worker_releases_its_slot_for_the_queued_one(tmp_path):
    """收尾不再汇报状态，但失败后的槽位释放与下一个排队任务必须照旧。"""
    async def scenario():
        model = GatedWorkers(fail_first=True)
        store, service, sid, main = setup(tmp_path, model)
        source = store.add_user_message(main, "执行三项任务", "failed-slot-source")
        ids = [dispatch(store, STUDENT, main, source, f"T{i}", str(i), None)[0] for i in range(3)]
        try:
            for cid in ids:
                service._start_delivery(STUDENT, cid)
            # T0 立刻失败，空出的槽位让排队的 T2 启动
            assert {await model.next_started() for _ in range(2)} == {"1", "2"}
            assert model.peak == 2
            assert store.conversation(ids[0], STUDENT).execution_status == "failed"
            for gate in model.gates.values():
                gate.set()
            await settle(service)
            assert model.inputs == ["1", "2"] and not service.active
        finally:
            await service.close()
    asyncio.run(scenario())


def test_shutdown_does_not_start_queued_workers(tmp_path):
    async def scenario():
        model = GatedWorkers()
        store, service, sid, main = setup(tmp_path, model)
        source = store.add_user_message(main, "执行四项任务", "shutdown-workers-source")
        ids = [dispatch(store, STUDENT, main, source, f"T{i}", str(i), None)[0] for i in range(4)]
        try:
            for cid in ids:
                service._start_delivery(STUDENT, cid)
            assert {await model.next_started() for _ in range(2)} == {"0", "1"}
        finally:
            await service.close()
        assert not service.active and model.running == 0
        assert model.inputs == ["0", "1"]
        assert all(next_delivery(store, cid) is not None for cid in ids[2:])
    asyncio.run(scenario())


def plain_store(tmp_path, name="thread-cards.sqlite3"):
    base = Store(tmp_path / name)
    base.initialize()
    MaterialStore(base).initialize()
    store = ChatStore(base)
    store.initialize()
    return store


def test_worker_turns_never_add_messages_to_the_main_line(tmp_path):
    """刷屏回归：同一支线连续 5 轮用户对话，主线消息数前后不变。"""
    async def scenario():
        store, service, sid, main = setup(tmp_path, Coordinator())
        source = store.add_user_message(main, "带我复习第三单元", "quiet-main-0001")
        _ = [e async for e in service.events(service.begin(STUDENT, main, source, []))]
        await settle(service)
        worker = store.threads(sid, STUDENT)[0].id
        before = [m.id for m in store.conversation(main, STUDENT).messages]
        assert len(before) == 2
        plain = FakeChat([f"第{index}轮讲解。" for index in range(5)])
        service.model = lambda: plain
        for index in range(5):
            turn = store.add_user_message(worker, f"第{index}轮追问", f"quiet-worker-{index}")
            _ = [e async for e in service.events(service.begin(STUDENT, worker, turn, []))]
            await settle(service)
        assert [m.id for m in store.conversation(main, STUDENT).messages] == before
        assert len(store.conversation(worker, STUDENT).messages) == 12
        await service.close()
    asyncio.run(scenario())


def test_initialize_removes_only_legacy_thread_update_cards(tmp_path):
    store = plain_store(tmp_path, "migration.sqlite3")
    sid = store.create_subject(STUDENT, "Java", "", "").id
    main = store.subject(sid, STUDENT).main_conversation_id
    user = store.add_user_message(main, "带我复习", "migration-0001")
    thread_id = store.create_thread(STUDENT, sid, title="旧支线", anchor_message_id=None,
                                    client_request_id="migration-thread-01")
    with store.connection() as db:
        store._insert(db, thread_id, role="user", kind="text", content="旧支线的问题", status="complete")
        card = store._insert(
            db, main, role="assistant", kind="text", content="支线「旧支线」· 本轮完成\n\n旧进展卡片",
            status="complete", client_request_id="report-legacy",
            meta={"thread_update": {"thread_id": thread_id, "title": "旧支线", "status": "idle", "summary": "旧进展"}},
        )
        keeps_word = store._insert(db, main, role="assistant", kind="text",
                                   content="工具输出里提到 thread_update 这个词，但这不是卡片。", status="complete")
        normal = store._insert(db, main, role="assistant", kind="text", content="普通回复", status="complete")
        summary = store._insert(
            db, main, role="assistant", kind="text", content="支线「旧支线」已解决\n\n小结", status="complete",
            meta={"thread_summary": {"thread_id": thread_id, "title": "旧支线", "summary": "小结",
                                     "takeaways": [], "memory_ids": []}},
        )
    before = store.conversation(main, STUDENT)
    store.initialize()
    after = store.conversation(main, STUDENT)
    ids = [m.id for m in after.messages]
    assert card not in ids
    assert keeps_word in ids and normal in ids and summary in ids and user in ids
    # 迁移只删派生卡片，不动会话时间戳
    assert after.updated_at == before.updated_at
    # 幂等：再跑一次结果一样
    store.initialize()
    assert [m.id for m in store.conversation(main, STUDENT).messages] == ids
    # 卡片已不在主线的最近消息里，支线背景自然干净了
    recent = store.role_context(thread_id)["main_recent"]
    assert all("旧进展卡片" not in item["excerpt"] and "本轮完成" not in item["excerpt"] for item in recent)


def test_role_context_carries_thread_progress_and_caps_the_list(tmp_path):
    store = plain_store(tmp_path, "role-context.sqlite3")
    sid = store.create_subject(STUDENT, "Java", "", "").id
    main = store.subject(sid, STUDENT).main_conversation_id

    def make_thread(title, request_id):
        thread_id = store.create_thread(STUDENT, sid, title=title, anchor_message_id=None,
                                        client_request_id=request_id)
        with store.connection() as db:
            store._insert(db, thread_id, role="user", kind="text", content=title, status="complete")
        return thread_id

    open_ids = [make_thread(f"开放{i}", f"cap-open-{i}") for i in range(21)]
    resolved_ids = [make_thread(f"已解决{i}", f"cap-resolved-{i}") for i in range(12)]
    for index, thread_id in enumerate(resolved_ids):
        store.resolve_thread(thread_id, STUDENT, f"已解决{index}", "小结", [])
    # 最新的一条支线才有进展摘要，保证它落在未解决的最近 20 个里
    source = store.add_user_message(main, "开任务", "context-source-1")
    progress_thread, _ = dispatch(store, STUDENT, main, source, "带进度", "任务", None)
    with store.connection() as db:
        store._insert(db, progress_thread, role="assistant", kind="text", content="讲解", status="complete",
                      meta={"progress_summary": "已讲解对象与类，等待第一题。", "needs_user": True})

    entries = store.role_context(main)["threads"]
    assert len(entries) == 30
    full, handles = entries[:20], entries[20:]
    assert all({"id", "title", "preview", "thread_status", "execution_status"} <= set(item) for item in full)
    assert all(set(item) == {"id", "title", "thread_status"} for item in handles)
    assert all(item["thread_status"] == "resolved" for item in handles)
    # 未解决按最近 20 个截断：最早建的两个不出现
    open_present = {item["id"] for item in full}
    assert open_ids[0] not in open_present and open_ids[1] not in open_present
    assert open_ids[-1] in open_present
    # 已解决只保留最近 10 个，且只有精简字段
    resolved_present = {item["id"] for item in handles}
    assert resolved_ids[0] not in resolved_present and resolved_ids[1] not in resolved_present
    assert resolved_ids[-1] in resolved_present
    entry = next(item for item in full if item["id"] == progress_thread)
    assert entry["progress_summary"] == "已讲解对象与类，等待第一题。"
    assert entry["execution_status"] == "waiting"


def test_dispatched_threads_skip_proposals_and_deleted_threads(tmp_path):
    store = plain_store(tmp_path, "dispatched.sqlite3")
    sid = store.create_subject(STUDENT, "Java", "", "").id
    main = store.subject(sid, STUDENT).main_conversation_id
    source = store.add_user_message(main, "先学第三单元", "dispatch-0001")
    thread_id, _ = dispatch(store, STUDENT, main, source, "第三单元", "任务", None)
    proposal_source = store.add_user_message(main, "我该怎么学", "dispatch-0002")
    proposal_thread, _ = dispatch(store, STUDENT, main, proposal_source, "建议项", "任务", None,
                                  task_key="proposal:proposal-1")

    messages = {m.id: m for m in store.conversation(main, STUDENT).messages}
    assert [item.thread_id for item in messages[source].dispatched_threads] == [thread_id]
    # 建议卡片确认产生的支线不重复渲染线程卡
    assert messages[proposal_source].dispatched_threads == []
    # 续接同一支线：两条用户消息各有一张卡
    followup = store.add_user_message(main, "还有第14页", "dispatch-0003")
    dispatch(store, STUDENT, main, followup, "第三单元", "继续", thread_id)
    messages = {m.id: m for m in store.conversation(main, STUDENT).messages}
    assert [item.thread_id for item in messages[followup].dispatched_threads] == [thread_id]
    assert [item.thread_id for item in messages[source].dispatched_threads] == [thread_id]
    # 支线删除后卡片随之消失，剩下不能渲染的坏卡
    store.delete_conversation(thread_id, STUDENT)
    messages = {m.id: m for m in store.conversation(main, STUDENT).messages}
    assert messages[source].dispatched_threads == []
    assert messages[followup].dispatched_threads == []
    assert proposal_thread


def test_conversation_api_exposes_dispatched_threads(tmp_path):
    from fastapi.testclient import TestClient
    from app.main import create_app
    from tests.test_acceptance_support import isolated_settings

    with TestClient(create_app(isolated_settings(tmp_path), chat_model=FakeChat())) as client:
        space = client.post("/api/subjects", json={"name": "卡片接口"}).json()
        main = space["main_conversation_id"]
        store = client.app.state.chat_service.store
        source = store.add_user_message(main, "带我复习链表", "api-card-0001")
        thread_id, _ = dispatch(store, STUDENT, main, source, "链表", "复习", None)
        data = client.get(f"/api/conversations/{main}").json()
        message = next(item for item in data["messages"] if item["id"] == source)
        assert message["dispatched_threads"] == [{"thread_id": thread_id}]
        # 单条消息接口（SSE 的 start 事件会用到）返回同一个字段
        assert [item.thread_id for item in store.message(source, STUDENT).dispatched_threads] == [thread_id]

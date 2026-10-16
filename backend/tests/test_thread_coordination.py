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


def setup(tmp_path, model):
    base = Store(tmp_path / "coordination.sqlite3")
    base.initialize()
    MaterialStore(base).initialize()
    store = ChatStore(base)
    store.initialize()
    sid = store.create_subject(STUDENT, "Java", "", "").id
    main = store.subject(sid, STUDENT).main_conversation_id
    return store, ChatService(store, lambda: model), sid, main


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
        reports = [m.thread_update for m in store.conversation(main, STUDENT).messages if m.thread_update]
        assert len(reports) == 1 and reports[0].status == "waiting" and "第一题" in reports[0].summary
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
        assert len([m for m in store.conversation(main, STUDENT).messages if m.thread_update]) == 2
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
        store, service, sid, main = setup(tmp_path, model)
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
        assert any(m.thread_update and m.thread_update.status == "waiting" for m in store.conversation(main, STUDENT).messages)
        assert service.stop(worker)
        await settle(service)
        assert store.message(generation.assistant_message_id, STUDENT).status == "cancelled"
        assert store.message(generation.assistant_message_id, STUDENT).pending_approval is None
        assert store.conversation(main, STUDENT).messages[-1].thread_update.status == "cancelled"
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
        with pytest.raises(ValueError, match="主对话"):
            dispatch(store, "another-student", main, source, "Java", "任务", None)
        _ = [e async for e in service.events(service.begin(STUDENT, main, source, []))]
        await settle(service)
        worker = store.threads(sid, STUDENT)[0].id
        assert store.conversation(worker, STUDENT).execution_status == "failed"
        report = next(m.thread_update for m in store.conversation(main, STUDENT).messages if m.thread_update)
        assert report.status == "failed" and "上游模型不可用" in report.summary
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
        plain = FakeChat(["理解正确，接下来学构造方法。"])
        service.model = lambda: plain
        _ = [e async for e in service.events(service.begin(STUDENT, worker, direct, []))]
        await settle(service)
        assert "构造方法" in store.conversation(main, STUDENT).messages[-1].thread_update.summary
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
        update = store.conversation(main, STUDENT).messages[-1].thread_update
        assert update.status == "waiting" and update.summary == "已检查回答，等待完成下一道判断题。"
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
        assert len([m for m in store.conversation(main, STUDENT).messages if m.thread_update]) == 2
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
        updates = [m.thread_update for m in store.conversation(main, STUDENT).messages if m.thread_update]
        assert len(updates) == 2 and all(update.status == "cancelled" for update in updates)
        service.recover()
        await settle(service)
        assert model.worker_inputs == ["复习"]
        await service.close()
    asyncio.run(scenario())

"""Phase 2: a resolved or failed Thread wakes the coordinator, quietly by default."""

import asyncio
import json

import pytest

import app.chat.service as service_module
from app.agents.llm import ProviderError
from app.chat.coordination import dispatch
from app.chat.plan import PlanStore
from app.chat.service import ChatService
from app.chat.store import ChatStore
from app.memory.store import Store
from app.services.materials import MaterialStore
from tests.test_chat import FakeChat, context_of

STUDENT = "demo-student-001"
SYSTEM_PREFIX = "【系统事件 · 支线汇报】"


class WakeSettings:
    def __init__(self, enabled=True):
        self.enabled = enabled

    def agent_config(self):
        return {"workspace": "", "coordinator_wakeup": self.enabled}


def setup(tmp_path, model, enabled=True, name="wake.sqlite3"):
    base = Store(tmp_path / name)
    base.initialize()
    MaterialStore(base).initialize()
    store = ChatStore(base)
    store.initialize()
    sid = store.create_subject(STUDENT, "Java", "", "").id
    main = store.subject(sid, STUDENT).main_conversation_id
    return store, ChatService(store, lambda: model, settings=WakeSettings(enabled)), sid, main


class WakeModel(FakeChat):
    """A worker that can fail, and a coordinator that stays silent, speaks, plans or fails."""

    def __init__(self, *, failed=False, wake="silent", block_worker=False):
        super().__init__()
        self.failed = failed
        self.wake_mode = wake
        self.block_worker = block_worker
        self.wake_inputs: list[str] = []
        self.wake_tools: list[set] = []
        self.main_tools: list[set] = []
        self.chat_tools: list[set] = []
        self.worker_tools: list[set] = []
        self.wake_gate = asyncio.Event()
        self.main_gate = asyncio.Event()
        self.worker_gate = asyncio.Event()
        self.worker_started = asyncio.Event()

    async def stream(self, messages, tools=None):
        self.calls.append(messages)
        names = {tool["function"]["name"] for tool in (tools or [])}
        latest = next(m["content"] for m in reversed(messages) if m["role"] == "user")
        role = context_of(messages)["conversation_role"]["role"]
        if latest.startswith(SYSTEM_PREFIX):
            if messages[-1]["role"] == "tool":
                yield "finish", "stop"
                return
            self.wake_inputs.append(latest)
            self.wake_tools.append(names)
            if self.wake_mode == "blocked":
                yield "text", "让我想想。"
                await self.wake_gate.wait()
                yield "finish", "stop"
                return
            if self.wake_mode == "fail":
                raise ProviderError(502, "唤醒模型不可用")
            if self.wake_mode == "silent":
                yield "tool_calls", [{"id": "silent", "name": "stay_silent", "arguments": "{}"}]
            elif self.wake_mode == "text":
                yield "text", "刚才那个任务没成功，我可以换个例子再试一次。"
            elif self.wake_mode == "plan":
                yield "tool_calls", [{
                    "id": "plan", "name": "update_plan",
                    "arguments": json.dumps({"steps": [{"title": "再练一次删除", "status": "pending"}]},
                                            ensure_ascii=False),
                }]
            elif self.wake_mode == "plan_done":
                yield "tool_calls", [{
                    "id": "plan", "name": "update_plan",
                    "arguments": json.dumps({"steps": [{"title": "练习", "status": "done"}]},
                                            ensure_ascii=False),
                }]
            elif self.wake_mode == "propose":
                yield "tool_calls", [{
                    "id": "propose", "name": "propose_threads",
                    "arguments": json.dumps({"proposals": [{
                        "title": "下一步：链表删除", "task": "带学生练链表删除。", "reason": "刚讲完插入",
                    }]}, ensure_ascii=False),
                }]
            elif self.wake_mode == "dispatch":
                yield "tool_calls", [{
                    "id": "escape", "name": "dispatch_thread",
                    "arguments": json.dumps({"title": "偷跑", "task": "偷跑任务"}, ensure_ascii=False),
                }]
            yield "finish", "stop"
            return
        if role == "main":
            self.main_tools.append(names)
            if latest == "主线阻塞":
                await self.main_gate.wait()
            yield "text", "好的。"
            yield "finish", "stop"
            return
        if role == "chat":
            self.chat_tools.append(names)
            yield "text", "好的。"
            yield "finish", "stop"
            return
        if messages[-1]["role"] == "tool":
            yield "finish", "stop"
            return
        self.worker_tools.append(names)
        self.worker_started.set()
        if self.block_worker:
            await self.worker_gate.wait()
        if self.failed:
            raise ProviderError(502, "上游模型不可用")
        yield "text", "先看对象和类的区别。"
        yield "tool_calls", [{
            "id": "progress", "name": "report_progress",
            "arguments": json.dumps({"summary": "已讲完链表插入。", "needs_user": False}, ensure_ascii=False),
        }]
        yield "finish", "stop"


async def settle(service, timeout=3.0):
    """Drive timers and tasks until nothing is runnable; long backoff handles are left alone."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while loop.time() < deadline:
        await asyncio.sleep(0.01)
        running = list(service.tasks)
        if running:
            await asyncio.wait(running, timeout=0.05)
        due = [handle for handle in service.wake_handles.values() if handle.when() - loop.time() < 0.05]
        if not running and not due:
            return
    pytest.fail("wake flow did not settle")


async def wait_until(predicate, timeout=3.0):
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while loop.time() < deadline:
        await asyncio.sleep(0.01)
        if predicate():
            return
    pytest.fail("condition was not met in time")


def reports(store):
    with store.connection() as db:
        return [dict(row) for row in db.execute("SELECT * FROM thread_reports ORDER BY created_at, id")]


def event_messages(store, main):
    return [message for message in store.conversation(main, STUDENT).messages
            if message.system_event is not None]


def delegated_thread(store, service, main, *, task="把链表讲完", title="链表", key="wake-main-0001"):
    source = store.add_user_message(main, task, key)
    thread_id, _message_id = dispatch(store, STUDENT, main, source, title, task, None)
    service._start_delivery(STUDENT, thread_id)
    return source, thread_id


def resolve(store, service, thread_id, *, title="链表", summary="已经讲完插入与删除。", takeaways=("边界条件",)):
    resolved = store.resolve_thread(thread_id, STUDENT, title, summary, list(takeaways))
    service.thread_resolved(STUDENT, thread_id, resolved["title"], resolved["summary"],
                            resolved["takeaways"], resolved["message_id"])
    return resolved


def test_resolved_thread_wakes_the_coordinator_and_stays_silent(tmp_path, monkeypatch):
    monkeypatch.setattr(service_module, "WAKE_QUIET_SECONDS", 0)

    async def scenario():
        model = WakeModel()
        store, service, sid, main = setup(tmp_path, model)
        _source, thread_id = delegated_thread(store, service, main)
        await settle(service)
        assert reports(store) == []          # 回合完成不写汇报
        messages_before = [m.id for m in store.conversation(main, STUDENT).messages]

        resolve(store, service, thread_id)
        # resolve 本身会写一张小结（合法的可见消息）；这里只验证沉默的唤醒回合不再改排序
        updated_before = store.conversation(main, STUDENT).updated_at
        await settle(service)
        rows = reports(store)
        assert len(rows) == 1 and rows[0]["state"] == "delivered" and rows[0]["outcome"] == "resolved"
        assert model.wake_inputs and model.wake_inputs[0].startswith(SYSTEM_PREFIX)
        assert "已经讲完插入与删除。" in model.wake_inputs[0] and "边界条件" in model.wake_inputs[0]
        # 沉默：事件消息与空回复都删掉了，主线消息数与会话排序都不变
        assert [m.id for m in store.conversation(main, STUDENT).messages][:len(messages_before)] == messages_before
        assert len(store.conversation(main, STUDENT).messages) == len(messages_before) + 1  # 小结
        assert event_messages(store, main) == []
        assert store.conversation(main, STUDENT).updated_at == updated_before
        await service.close()
    asyncio.run(scenario())


def test_completed_waiting_direct_and_stopped_turns_file_no_report(tmp_path, monkeypatch):
    monkeypatch.setattr(service_module, "WAKE_QUIET_SECONDS", 0)

    async def scenario():
        model = WakeModel()
        store, service, sid, main = setup(tmp_path, model)
        _source, thread_id = delegated_thread(store, service, main, key="no-report-1")
        await settle(service)
        assert reports(store) == []

        # 用户直接在支线里聊
        direct = store.add_user_message(thread_id, "类是对象的模板", "no-report-direct")
        _ = [e async for e in service.events(service.begin(STUDENT, thread_id, direct, []))]
        await settle(service)
        assert reports(store) == []

        # 用户主动停止
        model.block_worker = True
        _source, stopped = delegated_thread(store, service, main, key="no-report-2", title="被停止的支线")
        await asyncio.wait_for(model.worker_started.wait(), 3)
        assert service.stop(stopped)
        await settle(service)
        assert reports(store) == []
        await service.close()
    asyncio.run(scenario())


def test_failed_delegated_turn_files_a_failure_report(tmp_path, monkeypatch):
    monkeypatch.setattr(service_module, "WAKE_QUIET_SECONDS", 0)

    async def scenario():
        model = WakeModel(failed=True)
        store, service, sid, main = setup(tmp_path, model)
        _source, thread_id = delegated_thread(store, service, main)
        await settle(service)
        rows = reports(store)
        assert len(rows) == 1 and rows[0]["outcome"] == "failed" and rows[0]["state"] == "delivered"
        assert "上游模型不可用" in rows[0]["summary"]
        assert model.wake_inputs and "执行失败" in model.wake_inputs[0]
        await service.close()
    asyncio.run(scenario())


def test_direct_sidebar_failure_files_no_report(tmp_path, monkeypatch):
    monkeypatch.setattr(service_module, "WAKE_QUIET_SECONDS", 0)

    async def scenario():
        model = WakeModel(failed=True)
        store, service, sid, main = setup(tmp_path, model)
        thread_id = store.create_thread(STUDENT, sid, title="侧栏直接聊", anchor_message_id=None,
                                        client_request_id="direct-fail-thread")
        user = store.add_user_message(thread_id, "讲一下", "direct-fail-user")
        _ = [e async for e in service.events(service.begin(STUDENT, thread_id, user, []))]
        await settle(service)
        assert reports(store) == []
        assert model.wake_inputs == []
        await service.close()
    asyncio.run(scenario())


def test_duplicate_resolve_and_reopen_keep_reports_consistent(tmp_path, monkeypatch):
    monkeypatch.setattr(service_module, "WAKE_QUIET_SECONDS", 1000)

    async def scenario():
        model = WakeModel()
        store, service, sid, main = setup(tmp_path, model)
        _source, thread_id = delegated_thread(store, service, main)
        await settle(service)
        resolve(store, service, thread_id)
        assert len(reports(store)) == 1 and reports(store)[0]["state"] == "pending"

        # 重复 resolve：同一来源只记一次
        resolve(store, service, thread_id)
        assert len(reports(store)) == 1

        # 重新打开：待投递的「已解决」汇报作废
        store.reopen_thread(thread_id, STUDENT)
        service.thread_reopened(thread_id)
        assert reports(store)[0]["state"] == "skipped"
        await service.close()
    asyncio.run(scenario())


def test_later_report_replaces_the_pending_one(tmp_path, monkeypatch):
    monkeypatch.setattr(service_module, "WAKE_QUIET_SECONDS", 1000)

    async def scenario():
        model = WakeModel(failed=True)
        store, service, sid, main = setup(tmp_path, model)
        _source, thread_id = delegated_thread(store, service, main)
        await settle(service)
        assert reports(store)[0]["outcome"] == "failed"

        # 同一支线随后被标记已解决：只保留最新一条待投递汇报
        resolve(store, service, thread_id)
        rows = reports(store)
        assert len(rows) == 1 and rows[0]["outcome"] == "resolved" and rows[0]["state"] == "pending"
        assert "已经讲完插入与删除。" in rows[0]["summary"]
        await service.close()
    asyncio.run(scenario())


def test_two_resolved_threads_deliver_as_one_batch(tmp_path, monkeypatch):
    monkeypatch.setattr(service_module, "WAKE_QUIET_SECONDS", 1000)

    async def scenario():
        model = WakeModel()
        store, service, sid, main = setup(tmp_path, model)
        _source, first = delegated_thread(store, service, main, key="batch-1", title="链表")
        await settle(service)
        _source, second = delegated_thread(store, service, main, key="batch-2", title="递归")
        await settle(service)
        resolve(store, service, first, title="链表", summary="链表小结")
        resolve(store, service, second, title="递归", summary="递归小结")
        assert len(reports(store)) == 2 and all(row["state"] == "pending" for row in reports(store))

        monkeypatch.setattr(service_module, "WAKE_QUIET_SECONDS", 0)
        service._schedule_wake(STUDENT, main)
        await settle(service)
        assert len(model.wake_inputs) == 1
        assert model.wake_inputs[0].count("- 支线「") == 2
        assert "链表小结" in model.wake_inputs[0] and "递归小结" in model.wake_inputs[0]
        await service.close()
    asyncio.run(scenario())


def test_no_delivery_while_the_main_line_is_generating(tmp_path, monkeypatch):
    monkeypatch.setattr(service_module, "WAKE_QUIET_SECONDS", 0)

    async def scenario():
        model = WakeModel()
        store, service, sid, main = setup(tmp_path, model)
        _source, thread_id = delegated_thread(store, service, main)
        await settle(service)
        blocked = store.add_user_message(main, "主线阻塞", "main-block-1")
        service.begin(STUDENT, main, blocked, [])
        await asyncio.sleep(0.05)
        assert service.is_generating(main)

        resolve(store, service, thread_id)
        await wait_until(lambda: store.pending_thread_reports(main))
        await asyncio.sleep(0.05)
        assert model.wake_inputs == []
        assert event_messages(store, main) == []

        model.main_gate.set()
        await wait_until(lambda: model.wake_inputs, timeout=5)
        assert reports(store)[0]["state"] == "delivered"
        await service.close()
    asyncio.run(scenario())


def test_visible_wake_reply_is_kept_and_does_not_touch_learning_state(tmp_path, monkeypatch):
    monkeypatch.setattr(service_module, "WAKE_QUIET_SECONDS", 0)

    async def scenario():
        model = WakeModel(wake="text")
        store, service, sid, main = setup(tmp_path, model)
        _source, thread_id = delegated_thread(store, service, main)
        await settle(service)
        analysis_before = len(model.analysis_calls)
        title_before = store.conversation(main, STUDENT).title
        resolve(store, service, thread_id)
        await settle(service)

        messages = store.conversation(main, STUDENT).messages
        event = next(m for m in messages if m.system_event is not None)
        assert event.system_event.type == "thread_report"
        reply = next(m for m in messages if m.role == "assistant" and m.reply_to == event.id)
        assert reply.content == "刚才那个任务没成功，我可以换个例子再试一次。"
        assert reports(store)[0]["state"] == "delivered"
        # 事件回合不写学情、不计笔记轮次、不改标题、不产生新汇报或支线
        assert store.message_meta(event.id).get("note_counted") is None
        assert len(model.analysis_calls) == analysis_before
        assert store.conversation(main, STUDENT).title == title_before
        assert len(reports(store)) == 1 and len(store.threads(sid, STUDENT)) == 1

        # 事件消息留在历史里，后续真实回合的模型输入带固定前缀
        followup = store.add_user_message(main, "继续吧", "visible-followup-1")
        _ = [e async for e in service.events(service.begin(STUDENT, main, followup, []))]
        await settle(service)
        assert any(item.get("role") == "user" and item.get("content", "").startswith(SYSTEM_PREFIX)
                   for item in model.calls[-1])
        await service.close()
    asyncio.run(scenario())


def test_wake_turn_tools_are_restricted_and_stay_silent_stays_out_of_other_roles(tmp_path, monkeypatch):
    monkeypatch.setattr(service_module, "WAKE_QUIET_SECONDS", 0)

    async def scenario():
        model = WakeModel()
        store, service, sid, main = setup(tmp_path, model)
        hello = store.add_user_message(main, "你好", "tools-main-1")
        _ = [e async for e in service.events(service.begin(STUDENT, main, hello, []))]
        await settle(service)
        _source, thread_id = delegated_thread(store, service, main, key="tools-main-2")
        await settle(service)
        resolve(store, service, thread_id)
        await settle(service)

        wake = model.wake_tools[0]
        assert {"propose_threads", "update_plan", "session_search", "stay_silent"} <= wake
        assert not wake & {"dispatch_thread", "memory", "write", "edit", "bash",
                           "agenda_add", "create_document", "edit_document", "read_document"}
        assert "stay_silent" not in model.main_tools[0]

        chat = store.create_conversation(STUDENT, title=None, problem=None, client_request_id=None)
        chat_user = store.add_user_message(chat, "你好", "chat-user-1")
        _ = [e async for e in service.events(service.begin(STUDENT, chat, chat_user, []))]
        await settle(service)
        assert "stay_silent" not in model.chat_tools[-1]

        side_thread = store.create_thread(STUDENT, sid, title="支线", anchor_message_id=None,
                                          client_request_id="tool-thread-1")
        thread_user = store.add_user_message(side_thread, "讲一下", "tool-thread-user")
        _ = [e async for e in service.events(service.begin(STUDENT, side_thread, thread_user, []))]
        await settle(service)
        assert "stay_silent" not in model.worker_tools[-1]

        # 硬调用 dispatch_thread 也会被拒绝，不产生新支线
        before = len(store.threads(sid, STUDENT))
        model.wake_mode = "dispatch"
        resolve(store, service, side_thread)
        await settle(service)
        assert len(store.threads(sid, STUDENT)) == before
        await service.close()
    asyncio.run(scenario())


def test_preempt_lets_the_learner_win_and_redelivers_later(tmp_path, monkeypatch):
    monkeypatch.setattr(service_module, "WAKE_QUIET_SECONDS", 0)

    async def scenario():
        model = WakeModel(wake="blocked")
        store, service, sid, main = setup(tmp_path, model)
        _source, thread_id = delegated_thread(store, service, main)
        await settle(service)
        resolve(store, service, thread_id)
        await wait_until(lambda: model.wake_inputs)
        assert event_messages(store, main)

        # 抢占期间不要马上又投递一次：把安静期调回大值，等断言完再手动调度
        monkeypatch.setattr(service_module, "WAKE_QUIET_SECONDS", 1000)
        preempt = asyncio.create_task(service.preempt_system_turn(main))
        await wait_until(lambda: not service.is_generating(main))
        assert await preempt is True
        rows = reports(store)
        assert rows[0]["state"] == "pending" and rows[0]["attempts"] == 0
        assert event_messages(store, main) == []

        model.wake_mode = "silent"
        monkeypatch.setattr(service_module, "WAKE_QUIET_SECONDS", 0)
        service._schedule_wake(STUDENT, main)
        await settle(service)
        assert len(model.wake_inputs) == 2
        assert reports(store)[0]["state"] == "delivered"
        await service.close()
    asyncio.run(scenario())


def test_failed_wake_backs_off_and_then_gives_up(tmp_path, monkeypatch):
    monkeypatch.setattr(service_module, "WAKE_QUIET_SECONDS", 0)
    monkeypatch.setattr(service_module, "WAKE_MAX_ATTEMPTS", 2)

    async def scenario():
        model = WakeModel(wake="fail")
        store, service, sid, main = setup(tmp_path, model)
        _source, thread_id = delegated_thread(store, service, main)
        await settle(service)
        resolve(store, service, thread_id)
        await settle(service)
        rows = reports(store)
        assert rows[0]["state"] == "pending" and rows[0]["attempts"] == 1
        assert rows[0]["not_before"] is not None
        assert event_messages(store, main) == []

        with store.connection() as db:
            db.execute("UPDATE thread_reports SET not_before = NULL")
        service._schedule_wake(STUDENT, main)
        await settle(service)
        rows = reports(store)
        assert rows[0]["state"] == "skipped" and rows[0]["attempts"] == 2
        await service.close()
    asyncio.run(scenario())


def test_daily_cap_skips_and_the_switch_disables_wake(tmp_path, monkeypatch):
    async def scenario():
        monkeypatch.setattr(service_module, "WAKE_QUIET_SECONDS", 0)
        monkeypatch.setattr(service_module, "WAKE_DAILY_CAP", 0)
        model = WakeModel()
        store, service, sid, main = setup(tmp_path, model, name="cap.sqlite3")
        _source, thread_id = delegated_thread(store, service, main, key="cap-main-1")
        await settle(service)
        resolve(store, service, thread_id)
        await settle(service)
        assert reports(store)[0]["state"] == "skipped"
        assert model.wake_inputs == []
        await service.close()

        # 开关关闭：连汇报都不写，也不投递
        model = WakeModel()
        store, service, sid, main = setup(tmp_path, model, enabled=False, name="off.sqlite3")
        _source, thread_id = delegated_thread(store, service, main, key="off-main-1")
        await settle(service)
        resolve(store, service, thread_id)
        await settle(service)
        assert reports(store) == []
        assert model.wake_inputs == []
        await service.close()
    asyncio.run(scenario())


def test_recover_retries_pending_reports_and_rolls_back_interrupted_wakes(tmp_path, monkeypatch):
    monkeypatch.setattr(service_module, "WAKE_QUIET_SECONDS", 1000)

    async def scenario():
        model = WakeModel()
        store, service, sid, main = setup(tmp_path, model)
        _source, thread_id = delegated_thread(store, service, main)
        await settle(service)
        resolve(store, service, thread_id)
        pending = reports(store)
        assert len(pending) == 1 and pending[0]["state"] == "pending"
        report_id = pending[0]["id"]

        # 模拟：已投递但唤醒回合中断（事件消息 + streaming 回复）
        with store.connection() as db:
            event_id = store._insert(
                db, main, role="user", kind="text", content=f"{SYSTEM_PREFIX}\n- 支线「链表」：已解决",
                status="complete", meta={"system_event": {"type": "thread_report", "report_ids": [report_id],
                                                          "thread_ids": [thread_id]}},
            )
            store._insert(db, main, role="assistant", kind="text", content="", status="streaming",
                          reply_to=event_id)
            db.execute("UPDATE thread_reports SET state = 'delivered', delivered_event_id = ? WHERE id = ?",
                       (event_id, report_id))

        service.recover()
        rows = reports(store)
        assert rows[0]["state"] == "pending" and rows[0]["attempts"] == 1
        assert not any(message.system_event for message in store.conversation(main, STUDENT).messages)

        # 退避期过后重新投递（测试里直接清掉 not_before）
        with store.connection() as db:
            db.execute("UPDATE thread_reports SET not_before = NULL")
        monkeypatch.setattr(service_module, "WAKE_QUIET_SECONDS", 0)
        service._schedule_wake(STUDENT, main)
        await settle(service)
        assert len(model.wake_inputs) == 1
        assert reports(store)[0]["state"] == "delivered"
        # 重复恢复不会重复投递
        service.recover()
        await settle(service)
        assert len(model.wake_inputs) == 1
        await service.close()
    asyncio.run(scenario())


def test_event_wake_cannot_complete_a_step_waiting_for_the_learner(tmp_path, monkeypatch):
    monkeypatch.setattr(service_module, "WAKE_QUIET_SECONDS", 0)

    async def scenario():
        model = WakeModel(wake="plan_done")
        store, service, sid, main = setup(tmp_path, model)
        _source, thread_id = delegated_thread(store, service, main)
        await settle(service)
        plans = PlanStore(store)
        source = store.add_user_message(main, "先做练习", "plan-waiting-1")
        plans.update(main, STUDENT, [{"title": "练习", "status": "awaiting_learner"}],
                     message_id=None, user_message_id=source)
        resolve(store, service, thread_id)
        await settle(service)
        plan = plans.read(main, STUDENT)
        assert plan["steps"][0]["status"] == "awaiting_learner"
        await service.close()
    asyncio.run(scenario())


def test_event_wake_does_not_swallow_the_learners_plan_events(tmp_path, monkeypatch):
    monkeypatch.setattr(service_module, "WAKE_QUIET_SECONDS", 0)

    async def scenario():
        model = WakeModel()
        store, service, sid, main = setup(tmp_path, model)
        _source, thread_id = delegated_thread(store, service, main)
        await settle(service)
        PlanStore(store).user_action(main, STUDENT, "add", title="学生新增的步骤")

        def pending_events():
            with store.connection() as db:
                return json.loads(db.execute(
                    "SELECT plan_user_events FROM conversation_plans WHERE conversation_id = ?", (main,),
                ).fetchone()[0])

        assert any("学生新增的步骤" in item for item in pending_events())
        resolve(store, service, thread_id)
        await settle(service)
        assert any("学生新增的步骤" in item for item in pending_events())
        await service.close()
    asyncio.run(scenario())


def test_wake_proposals_never_leak_the_hidden_event_into_the_thread(tmp_path, monkeypatch):
    monkeypatch.setattr(service_module, "WAKE_QUIET_SECONDS", 0)

    async def scenario():
        model = WakeModel(wake="propose")
        store, service, sid, main = setup(tmp_path, model)
        _source, thread_id = delegated_thread(store, service, main)
        await settle(service)
        resolved = resolve(store, service, thread_id)
        await settle(service)

        reply = next(m for m in store.conversation(main, STUDENT).messages
                     if m.role == "assistant" and m.thread_proposals)
        proposal = reply.thread_proposals[0]
        new_thread = service.confirm_proposal(STUDENT, main, reply.id, proposal.id)
        first = store.conversation(new_thread, STUDENT).messages[0]
        assert first.content == "带学生练链表删除。"
        assert SYSTEM_PREFIX not in first.content
        assert resolved["message_id"]
        await service.close()
    asyncio.run(scenario())


def test_http_resolve_endpoint_files_the_report(tmp_path, monkeypatch):
    monkeypatch.setattr(service_module, "WAKE_QUIET_SECONDS", 1000)
    from fastapi.testclient import TestClient
    from app.main import create_app
    from tests.test_acceptance_support import isolated_settings

    model = WakeModel()
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=model)) as client:
        space = client.post("/api/subjects", json={"name": "汇报接口"}).json()
        main = space["main_conversation_id"]
        service = client.app.state.chat_service
        store = service.store
        source = store.add_user_message(main, "把链表讲完", "http-resolve-1")
        thread_id, _message_id = dispatch(store, STUDENT, main, source, "链表", "把链表讲完", None)
        response = client.post(f"/api/conversations/{thread_id}/resolve",
                               json={"title": "链表", "summary": "讲完了。", "takeaways": []})
        assert response.status_code == 200, response.text
        rows = reports(store)
        assert len(rows) == 1 and rows[0]["outcome"] == "resolved" and rows[0]["state"] == "pending"
        # 再次提交同一份小结：不重复写
        assert client.post(f"/api/conversations/{thread_id}/resolve",
                           json={"title": "链表", "summary": "讲完了。", "takeaways": []}).status_code == 200
        assert len(reports(store)) == 1

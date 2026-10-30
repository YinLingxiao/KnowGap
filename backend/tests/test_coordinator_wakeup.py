"""Phase 2: a finished Thread reports back and wakes the coordinator, quietly by default."""

import asyncio
import json

import pytest

import app.chat.service as service_module
from app.agents.llm import ProviderError
from app.chat.coordination import dispatch
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
    """Workers finish or fail; the coordinator either stays silent, speaks, plans or fails."""

    def __init__(self, *, needs_user=False, failed=False, wake="silent", block_worker=False):
        super().__init__()
        self.needs_user = needs_user
        self.failed = failed
        self.wake_mode = wake
        self.block_worker = block_worker
        self.summary = "已讲完链表插入。"
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
            "arguments": json.dumps({"summary": self.summary, "needs_user": self.needs_user}, ensure_ascii=False),
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


def delegated_turn(store, service, main, *, task="把链表讲完", title="链表", key="wake-main-0001",
                   thread_id=None, summary=None, model=None):
    if model is not None and summary is not None:
        model.summary = summary
    source = store.add_user_message(main, task, key)
    thread_id, _message_id = dispatch(store, STUDENT, main, source, title, task, thread_id)
    service._start_delivery(STUDENT, thread_id)
    return source, thread_id


def test_completed_delegated_turn_wakes_the_coordinator_and_stays_silent(tmp_path, monkeypatch):
    monkeypatch.setattr(service_module, "WAKE_QUIET_SECONDS", 0)

    async def scenario():
        model = WakeModel()
        store, service, sid, main = setup(tmp_path, model)
        _source, _thread = delegated_turn(store, service, main)
        await settle(service)
        rows = reports(store)
        assert len(rows) == 1 and rows[0]["state"] == "delivered" and rows[0]["outcome"] == "completed"
        assert model.wake_inputs and model.wake_inputs[0].startswith(SYSTEM_PREFIX)
        assert "已讲完链表插入。" in model.wake_inputs[0]
        # 沉默：事件消息与空回复都删掉了，主线里只剩当初那条交办消息
        messages = store.conversation(main, STUDENT).messages
        assert [m.role for m in messages] == ["user"]
        assert event_messages(store, main) == []
        await service.close()
    asyncio.run(scenario())


def test_direct_sidebar_turn_files_no_report(tmp_path, monkeypatch):
    monkeypatch.setattr(service_module, "WAKE_QUIET_SECONDS", 0)

    async def scenario():
        model = WakeModel()
        store, service, sid, main = setup(tmp_path, model)
        thread_id = store.create_thread(STUDENT, sid, title="侧栏直接聊", anchor_message_id=None,
                                        client_request_id="sidebar-thread-1")
        user = store.add_user_message(thread_id, "类是对象的模板", "sidebar-user-1")
        _ = [e async for e in service.events(service.begin(STUDENT, thread_id, user, []))]
        await settle(service)
        assert reports(store) == []
        assert model.wake_inputs == []
        await service.close()
    asyncio.run(scenario())


def test_waiting_resolved_and_stopped_turns_file_no_report(tmp_path, monkeypatch):
    monkeypatch.setattr(service_module, "WAKE_QUIET_SECONDS", 0)

    async def scenario():
        model = WakeModel(needs_user=True)
        store, service, sid, main = setup(tmp_path, model, name="waiting.sqlite3")
        delegated_turn(store, service, main, key="waiting-main-1")
        await settle(service)
        assert store.conversation(store.threads(sid, STUDENT)[0].id, STUDENT).execution_status == "waiting"
        assert reports(store) == []

        model.needs_user = False
        _source, thread_id = delegated_turn(store, service, main, key="waiting-main-2", title="已解决支线")
        store.resolve_thread(thread_id, STUDENT, "已解决支线", "小结", [])
        await settle(service)
        assert reports(store) == []

        model.block_worker = True
        _source, stopped = delegated_turn(store, service, main, key="waiting-main-3", title="被停止的支线")
        await asyncio.wait_for(model.worker_started.wait(), 3)
        assert service.stop(stopped)
        await settle(service)
        assert reports(store) == []
        await service.close()
    asyncio.run(scenario())


def test_reports_upsert_per_thread_and_deliver_as_one_batch(tmp_path, monkeypatch):
    monkeypatch.setattr(service_module, "WAKE_QUIET_SECONDS", 1000)

    async def scenario():
        model = WakeModel()
        store, service, sid, main = setup(tmp_path, model)
        _source, first = delegated_turn(store, service, main, key="batch-main-1", title="链表", summary="第一版进展")
        await settle(service)
        _source, second = delegated_turn(store, service, main, key="batch-main-2", title="递归")
        await settle(service)
        assert {row["thread_id"] for row in reports(store)} == {first, second}
        assert len(reports(store)) == 2 and all(row["state"] == "pending" for row in reports(store))

        # 同一支线在投递前再次完成：只保留最新摘要，不新增一行
        delegated_turn(store, service, main, key="batch-main-3", thread_id=first, summary="最新进展",
                       model=model)
        await settle(service)
        rows = reports(store)
        assert len(rows) == 2
        latest = next(row for row in rows if row["thread_id"] == first)
        assert latest["state"] == "pending" and latest["summary"] == "最新进展"

        monkeypatch.setattr(service_module, "WAKE_QUIET_SECONDS", 0)
        service._schedule_wake(STUDENT, main)
        await settle(service)
        assert len(model.wake_inputs) == 1
        assert model.wake_inputs[0].count("- 支线「") == 2
        assert "最新进展" in model.wake_inputs[0] and "递归" in model.wake_inputs[0]
        await service.close()
    asyncio.run(scenario())


def test_no_delivery_while_the_main_line_is_generating(tmp_path, monkeypatch):
    monkeypatch.setattr(service_module, "WAKE_QUIET_SECONDS", 0)

    async def scenario():
        model = WakeModel()
        store, service, sid, main = setup(tmp_path, model)
        blocked = store.add_user_message(main, "主线阻塞", "main-block-1")
        service.begin(STUDENT, main, blocked, [])
        await asyncio.sleep(0.05)
        assert service.is_generating(main)
        delegated_turn(store, service, main, key="main-block-worker")
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
        title_before = store.conversation(main, STUDENT).title
        delegated_turn(store, service, main)
        await settle(service)
        analysis_before = len(model.analysis_calls)
        messages = store.conversation(main, STUDENT).messages
        assert [m.role for m in messages] == ["user", "user", "assistant"]
        event = messages[1]
        assert event.system_event is not None and event.system_event.type == "thread_report"
        assert messages[2].content == "刚才那个任务没成功，我可以换个例子再试一次。"
        assert reports(store)[0]["state"] == "delivered"
        # 事件回合不写学情、不计笔记轮次、不改标题
        assert store.message_meta(event.id).get("note_counted") is None
        assert len(model.analysis_calls) == analysis_before
        assert store.conversation(main, STUDENT).title == title_before

        # 事件消息留在历史里，后续真实回合的模型输入带固定前缀
        followup = store.add_user_message(main, "继续吧", "visible-followup-1")
        _ = [e async for e in service.events(service.begin(STUDENT, main, followup, []))]
        await settle(service)
        assert any(item.get("role") == "user" and item.get("content", "").startswith(SYSTEM_PREFIX)
                   for item in model.calls[-1])
        # 唤醒回合没有产生新的汇报或支线
        assert len(reports(store)) == 1
        assert len(store.threads(sid, STUDENT)) == 1
        await service.close()
    asyncio.run(scenario())


def test_wake_turn_tools_are_restricted_and_stay_silent_stays_out_of_other_roles(tmp_path, monkeypatch):
    monkeypatch.setattr(service_module, "WAKE_QUIET_SECONDS", 0)

    async def scenario():
        model = WakeModel()
        store, service, sid, main = setup(tmp_path, model)
        # 普通主线回合：拿到的工具里没有 stay_silent
        hello = store.add_user_message(main, "你好", "tools-main-1")
        _ = [e async for e in service.events(service.begin(STUDENT, main, hello, []))]
        await settle(service)
        delegated_turn(store, service, main, key="tools-main-2")
        await settle(service)
        wake = model.wake_tools[0]
        assert {"propose_threads", "update_plan", "session_search", "stay_silent"} <= wake
        assert not wake & {"dispatch_thread", "memory", "write", "edit", "bash",
                           "agenda_add", "create_document", "edit_document", "read_document"}
        assert "stay_silent" not in model.main_tools[0]      # 普通主线

        chat = store.create_conversation(STUDENT, title=None, problem=None, client_request_id=None)
        chat_user = store.add_user_message(chat, "你好", "chat-user-1")
        _ = [e async for e in service.events(service.begin(STUDENT, chat, chat_user, []))]
        await settle(service)
        assert "stay_silent" not in model.chat_tools[-1]      # 普通会话

        thread_id = store.create_thread(STUDENT, sid, title="支线", anchor_message_id=None,
                                        client_request_id="tool-thread-1")
        thread_user = store.add_user_message(thread_id, "讲一下", "tool-thread-user")
        _ = [e async for e in service.events(service.begin(STUDENT, thread_id, thread_user, []))]
        await settle(service)
        assert "stay_silent" not in model.worker_tools[-1]    # 支线

        # 硬调用 dispatch_thread 也会被拒绝，不产生新支线
        before = len(store.threads(sid, STUDENT))
        model.wake_mode = "dispatch"
        delegated_turn(store, service, main, key="escape-main-1", title="另一个任务")
        await settle(service)
        assert len(store.threads(sid, STUDENT)) == before + 1  # 只多了这次交办本身
        await service.close()
    asyncio.run(scenario())


def test_preempt_lets_the_learner_win_and_redelivers_later(tmp_path, monkeypatch):
    monkeypatch.setattr(service_module, "WAKE_QUIET_SECONDS", 0)

    async def scenario():
        model = WakeModel(wake="blocked")
        store, service, sid, main = setup(tmp_path, model)
        delegated_turn(store, service, main)
        await wait_until(lambda: model.wake_inputs)
        assert event_messages(store, main)

        # 抢占期间不要马上又投递一次：把安静期调回大值，等断言完再手动调度
        monkeypatch.setattr(service_module, "WAKE_QUIET_SECONDS", 1000)
        preempt = asyncio.create_task(service.preempt_system_turn(main))
        await wait_until(lambda: not service.is_generating(main))
        assert await preempt is True
        assert not service.is_generating(main)
        rows = reports(store)
        assert rows[0]["state"] == "pending" and rows[0]["attempts"] == 0
        assert event_messages(store, main) == []

        # 用户消息可以立即开始，不需要再等唤醒回合
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
        delegated_turn(store, service, main)
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
        delegated_turn(store, service, main, key="cap-main-1")
        await settle(service)
        assert reports(store)[0]["state"] == "skipped"
        assert model.wake_inputs == []
        await service.close()

        # 开关关闭：连汇报都不写，也不投递
        model = WakeModel()
        store, service, sid, main = setup(tmp_path, model, enabled=False, name="off.sqlite3")
        delegated_turn(store, service, main, key="off-main-1")
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
        _source, thread_id = delegated_turn(store, service, main, key="recover-main-1")
        await settle(service)
        pending = reports(store)
        assert len(pending) == 1 and pending[0]["state"] == "pending"
        report_id = pending[0]["id"]
        reply_id = pending[0]["reply_id"]

        # 模拟：已投递但唤醒回合中断（事件消息 + streaming 回复）
        with store.connection() as db:
            event_id = store._insert(
                db, main, role="user", kind="text", content=f"{SYSTEM_PREFIX}\n- 支线「链表」：已完成",
                status="complete", meta={"system_event": {"type": "thread_report", "report_ids": [report_id],
                                                          "thread_ids": [thread_id]}},
            )
            store._insert(db, main, role="assistant", kind="text", content="", status="streaming",
                          reply_to=event_id)
            db.execute("UPDATE thread_reports SET state = 'delivered', delivered_event_id = ? WHERE id = ?",
                       (event_id, report_id))
        assert report_id and reply_id

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

"""A wake that dies before its first step still reports, rolls back, and is queued again."""

import asyncio

import app.chat.service as service_module
from app.agents.llm import ProviderError
from tests.test_coordinator_wakeup import (
    STUDENT, WakeModel, delegated_thread, event_messages, reports, resolve, setup, settle,
)


def _streaming(store, main) -> int:
    with store.connection() as db:
        return db.execute(
            "SELECT COUNT(*) FROM conversation_messages WHERE conversation_id = ? AND status = 'streaming'",
            (main,),
        ).fetchone()[0]


def test_provider_error_reports_the_thread_and_reschedules_the_wake(tmp_path, monkeypatch):
    monkeypatch.setattr(service_module, "WAKE_QUIET_SECONDS", 0)

    async def scenario():
        model = WakeModel()
        store, service, sid, main = setup(tmp_path, model)

        def unavailable(_conversation_id):
            raise ProviderError(502, "模型不可用")

        monkeypatch.setattr(service, "_open_conversation_model", unavailable)
        delegated_thread(store, service, main)
        await settle(service)
        rows = reports(store)
        assert len(rows) == 1 and rows[0]["outcome"] == "failed"
        assert rows[0]["state"] == "pending" and rows[0]["attempts"] == 1
        assert event_messages(store, main) == []
        assert _streaming(store, main) == 0
        assert main in service.wake_handles
        await service.close()
    asyncio.run(scenario())


def test_begin_failure_drops_the_reply_and_reschedules(tmp_path, monkeypatch):
    monkeypatch.setattr(service_module, "WAKE_QUIET_SECONDS", 1000)

    async def scenario():
        model = WakeModel()
        store, service, sid, main = setup(tmp_path, model)
        _source, thread_id = delegated_thread(store, service, main)
        await settle(service)
        resolve(store, service, thread_id)
        assert reports(store)[0]["state"] == "pending" and reports(store)[0]["attempts"] == 0

        def broken(_student_id, _conversation_id):
            raise RuntimeError("conversation lookup failed")

        monkeypatch.setattr(service_module, "WAKE_QUIET_SECONDS", 0)
        monkeypatch.setattr(service, "_conversation", broken)
        service._schedule_wake(STUDENT, main)
        await settle(service)
        rows = reports(store)
        assert len(rows) == 1 and rows[0]["outcome"] == "resolved"
        assert rows[0]["state"] == "pending" and rows[0]["attempts"] == 1
        assert event_messages(store, main) == []
        assert _streaming(store, main) == 0
        assert main not in service.active
        assert main in service.wake_handles
        await service.close()
    asyncio.run(scenario())


def test_preempt_before_the_wake_starts_restores_the_report(tmp_path, monkeypatch):
    monkeypatch.setattr(service_module, "WAKE_QUIET_SECONDS", 1000)

    async def scenario():
        model = WakeModel()
        store, service, sid, main = setup(tmp_path, model)
        _source, thread_id = delegated_thread(store, service, main)
        await settle(service)
        resolve(store, service, thread_id)
        delivered = store.deliver_pending_reports(
            main, service_module.WAKE_MAX_BATCH, service._system_event_payload)
        assert delivered is not None
        event_id, _rows = delivered
        attempts = reports(store)[0]["attempts"]
        assert reports(store)[0]["state"] == "delivered" and attempts == 0

        generation = service.begin(STUDENT, main, event_id, [], detached=True)
        reply_id = generation.assistant_message_id
        assert await service.preempt_system_turn(main) is True
        with store.connection() as db:
            assert db.execute(
                "SELECT 1 FROM conversation_messages WHERE id = ? OR reply_to = ?",
                (event_id, event_id),
            ).fetchone() is None
        assert event_messages(store, main) == []
        store.finish_reply(reply_id, content="残留", status="failed", error="已删除")
        store.finish_reply(event_id, content="残留", status="failed")
        store.rollback_wake(event_id, reply_id, preempted=True, base_delay=service_module.WAKE_RETRY_SECONDS,
                            max_attempts=service_module.WAKE_MAX_ATTEMPTS)
        store.rollback_wake(event_id, None, preempted=False, base_delay=service_module.WAKE_RETRY_SECONDS,
                            max_attempts=service_module.WAKE_MAX_ATTEMPTS)
        row = reports(store)[0]
        assert row["state"] == "pending" and row["attempts"] == attempts
        assert main not in service.active
        await service.close()
    asyncio.run(scenario())

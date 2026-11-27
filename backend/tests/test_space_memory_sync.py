"""学习空间记忆汇总进总记忆（USER 笔记）：每个空间一条摘要，按间隔或手动刷新，删空间时一起去掉。"""

import sqlite3
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace as Memory

from fastapi.testclient import TestClient

from app.main import create_app
from app.memory import curated, space_sync
from tests.test_acceptance_support import isolated_settings
from tests.test_chat import FakeChat, send
from tests.test_subjects import new_chat, new_subject, observation

STUDENT = "demo-student-001"


def user_entries(client):
    content = client.get("/api/agent-memory").json()["user"]
    return [part.strip() for part in content.split("§") if part.strip()]


def space_entries(client, name):
    return [entry for entry in user_entries(client) if entry.startswith(space_sync.entry_prefix(name))]


def test_manual_sync_writes_one_summary_per_space_and_updates_it_in_place(tmp_path):
    model = FakeChat(analyses=[
        observation("misconception", "栈的出入顺序", "认为栈是先进先出", "栈就是先进先出", tags=["栈"]),
        observation("mastery", "队列", "能正确说明队列先进先出", "队列先进先出", tags=["队列"]),
    ])
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=model)) as client:
        ds = new_subject(client, "数据结构", goal="期末考到 85 分")
        assert client.get(f"/api/subjects/{ds['id']}/memory-sync").json()["synced_at"] is None

        chat = new_chat(client, ds["id"])
        send(client, chat, "栈就是先进先出", "req-sync-01")
        first = client.post(f"/api/subjects/{ds['id']}/memory-sync").json()
        assert first["status"] in {"synced", "unchanged"} and first["synced_at"] and first["next_sync_at"]
        [entry] = space_entries(client, "数据结构")
        assert "期末考到 85 分" in entry and "待巩固：栈的出入顺序" in entry

        send(client, chat, "队列先进先出", "req-sync-02")
        client.post(f"/api/subjects/{ds['id']}/memory-sync")
        [updated] = space_entries(client, "数据结构")
        assert "已掌握：队列" in updated and "待巩固：栈的出入顺序" in updated

        assert client.post(f"/api/subjects/{ds['id']}/memory-sync").json()["status"] == "unchanged"

        # 改名后同步：改的是原来那一条，不会留下旧名字的摘要。
        client.patch(f"/api/subjects/{ds['id']}", json={"name": "算法"})
        client.post(f"/api/subjects/{ds['id']}/memory-sync")
        assert space_entries(client, "数据结构") == [] and len(space_entries(client, "算法")) == 1


def test_space_without_learning_evidence_writes_nothing_and_does_not_start_the_clock(tmp_path):
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=FakeChat())) as client:
        ds = new_subject(client, "操作系统")
        result = client.post(f"/api/subjects/{ds['id']}/memory-sync").json()
        assert result["status"] == "unchanged" and result["synced_at"] is None
        assert space_entries(client, "操作系统") == []


def test_deleting_a_space_removes_its_summary_but_keeps_other_notes(tmp_path):
    model = FakeChat(analyses=[
        observation("misconception", "栈的出入顺序", "认为栈是先进先出", "栈就是先进先出", tags=["栈"]),
    ])
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=model)) as client:
        ds = new_subject(client, "数据结构")
        send(client, new_chat(client, ds["id"]), "栈就是先进先出", "req-sync-04")
        client.post(f"/api/subjects/{ds['id']}/memory-sync")
        assert len(space_entries(client, "数据结构")) == 1

        assert client.delete(f"/api/subjects/{ds['id']}").status_code in {200, 204}
        assert space_entries(client, "数据结构") == []
        assert client.get(f"/api/subjects/{ds['id']}/memory-sync").status_code == 404


# ---- 纯数据库层：间隔、同名空间、§、偏好 -------------------------------------------------

def _db():
    db = sqlite3.connect(":memory:")
    db.row_factory = sqlite3.Row
    curated.ensure(db)
    space_sync.ensure(db)
    return db


def _at(days: float) -> str:
    return (datetime(2026, 11, 1, tzinfo=timezone.utc) + timedelta(days=days)).isoformat()


def _users(db):
    return curated.split_entries(curated.read_all(db, "s")["user"])


WEAK = [Memory(kind="misconception", status="active", topic="栈")]


def test_interval_and_unchanged_content():
    db = _db()
    assert space_sync.sync(db, "s", "a", "数据结构", "", WEAK, _at(0))["status"] == "synced"
    assert space_sync.sync(db, "s", "a", "数据结构", "", WEAK, _at(0.5))["status"] == "not_due"
    assert space_sync.sync(db, "s", "a", "数据结构", "", WEAK, _at(1.5))["status"] == "unchanged"


def test_same_named_spaces_never_touch_each_others_summary():
    db = _db()
    space_sync.sync(db, "s", "a", "英语", "", WEAK, _at(0))
    [entry] = _users(db)
    # 同名的新空间从没同步过：删除它或同步它都不能动 A 的那条。
    space_sync.forget(db, "s", "b", _at(1))
    assert _users(db) == [entry]
    space_sync.sync(db, "s", "b", "英语", "", [], _at(1), force=True)
    assert _users(db) == [entry]


def test_section_signs_and_preferences_stay_out_of_the_summary():
    memories = [
        Memory(kind="misconception", status="active", topic="教材 §3.2 的 KMP"),
        Memory(kind="preference", status="resolved", topic="先看例子"),
    ]
    entry = space_sync.summary_entry("数据 § 结构", "§ 期末", memories)
    assert "§" not in entry and "先看例子" not in entry and "教材 3.2 的 KMP" in entry
    long = space_sync.summary_entry("长", "目标" * 80, [Memory(kind="misconception", status="active", topic="很长 " * 40)])
    assert len(long) <= space_sync.ENTRY_LIMIT and long == long.strip()


def test_auto_sync_is_skipped_when_write_approval_is_on(tmp_path, monkeypatch):
    from app.chat.service import ChatService
    calls = []
    monkeypatch.setattr(ChatService, "_agent_flag", lambda self, key: key == "memory_write_approval")
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=FakeChat())) as client:
        store = client.app.state.chat_service.store
        monkeypatch.setattr(store, "sync_space_memory", lambda *args, **kwargs: calls.append(args))
        ds = new_subject(client, "数据结构")
        service = client.app.state.chat_service
        import asyncio
        asyncio.run(service._review(STUDENT, FakeChat(), [{"role": "user", "content": "好"}],
                                    ds["main_conversation_id"], None))
        assert calls == [], "开了写入前确认时不自动写 USER；只有手动「立即同步」才写"

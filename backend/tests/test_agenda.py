"""Agenda contract, persistence, isolation and model failure regression tests."""

import asyncio
from concurrent.futures import ThreadPoolExecutor
from datetime import date

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from tests.test_acceptance_support import isolated_settings
from tests.test_chat import FakeChat

BASE = "/api/agenda"


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=FakeChat())) as c:
        yield c


def create(client, **fields):
    response = client.post(BASE + "/tasks", json={"title": "复习", **fields})
    assert response.status_code == 201, response.text
    return response.json()


def patch(client, task, **fields):
    return client.patch(BASE + "/tasks/" + task["id"], json=fields)


def listed(client, **params):
    response = client.get(BASE + "/tasks", params=params)
    assert response.status_code == 200, response.text
    return response.json()["tasks"]


def seed_memory(client, memory_id="mem-one", student="demo-student-001", subject=None):
    with client.app.state.store.connection() as db:
        db.execute("INSERT INTO learner_memories (id, student_id, kind, topic, summary, status, confidence, "
                   "subject_id, created_at, updated_at) VALUES (?,?,'misconception','戴维南','误区摘要',"
                   "'suspected',0.8,?,'2026-10-20T12:00:00+00:00','2026-10-20T12:00:00+00:00')",
                   (memory_id, student, subject))
        for quote, day in (("旧原话", "20"), ("最近原话", "21")):
            db.execute("INSERT INTO learner_memory_evidence (memory_id, quote, reason, signal, created_at) "
                       "VALUES (?,?,'reason','supports',?)", (memory_id, quote, f"2026-10-{day}T12:00:00+00:00"))


def agenda_with_review_rows(path):
    from app.memory.store import Store
    store = Store(path)
    with store.connection() as db:
        db.execute("""
            CREATE TABLE agenda_tasks (
                id TEXT PRIMARY KEY, student_id TEXT NOT NULL,
                title TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '',
                parent_id TEXT, priority INTEGER NOT NULL DEFAULT 4, labels TEXT NOT NULL DEFAULT '[]',
                subject_id TEXT, thread_id TEXT, scheduled_date TEXT, scheduled_start_at TEXT,
                duration_minutes INTEGER, deadline_date TEXT,
                status TEXT NOT NULL DEFAULT 'open', completed_at TEXT,
                source TEXT NOT NULL DEFAULT 'manual', memory_id TEXT, review_step INTEGER,
                sort_order REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                UNIQUE(student_id, memory_id, review_step)
            )
        """)
        stamp = "2026-10-20T12:00:00+00:00"
        rows = [
            ("rev-open", "s", "review", "open", "mem-a", 1),
            ("rev-done", "s", "review", "done", "mem-a", 2),
            ("rev-cancelled", "s", "review", "cancelled", "mem-b", 1),
            ("rev-other", "other", "review", "open", "mem-c", 1),
            ("manual", "s", "manual", "open", None, None),
            ("ai", "s", "ai_breakdown", "done", None, None),
        ]
        db.executemany(
            "INSERT INTO agenda_tasks (id, student_id, title, status, source, memory_id, review_step, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [(task_id, student, task_id, status, source, memory, step, stamp, stamp)
             for task_id, student, source, status, memory, step in rows],
        )
    return store


def test_crud_filters_patch_and_null(client):
    task = create(client, labels=["电路"], scheduled_date="2026-10-22", scheduled_start_at="2026-10-22T15:00")
    assert task["source"] == "manual" and task["priority"] == 4 and task["status"] == "open"
    assert patch(client, task, scheduled_date="2026-10-23").status_code == 422
    changed = patch(client, task, scheduled_date=None, scheduled_start_at=None, notes=None, labels=None,
                    sort_order=1.5).json()
    assert changed["scheduled_date"] is None and changed["labels"] == [] and changed["notes"] == ""
    done = patch(client, task, status="done").json()
    assert done["completed_at"] and not listed(client)
    assert len(listed(client, status="done")) == 1
    assert patch(client, task, status="open").json()["completed_at"] is None
    patch(client, task, status="cancelled")
    assert listed(client, status="all") == []
    assert client.delete(BASE + "/tasks/" + task["id"]).status_code == 204
    assert patch(client, task, title="missing").status_code == 404


@pytest.mark.parametrize("fields", [
    {"title": ""}, {"title": "x" * 201}, {"priority": 0}, {"priority": 5}, {"priority": True},
    {"labels": ["x"] * 11}, {"labels": ["x" * 21]}, {"duration_minutes": 4}, {"duration_minutes": 721},
    {"scheduled_date": "2026-2-01"}, {"scheduled_date": "2026-02-30"},
    {"scheduled_start_at": "2026-10-22T15:00"}, {"scheduled_start_at": "2026-10-22T15:00Z"},
    {"source": "review"}, {"subject_id": "missing"}, {"thread_id": "missing"}, {"memory_id": "forged"},
    {"subject_id": ""}, {"thread_id": ""},
])
def test_create_validation(client, fields):
    assert client.post(BASE + "/tasks", json={"title": "学习", **fields}).status_code == 422


@pytest.mark.parametrize("field", ["title", "priority", "source", "status", "sort_order"])
def test_nonnullable_patch(client, field):
    assert patch(client, create(client), **{field: None}).status_code == 422


def test_parent_constraints_cascade_and_batch_atomicity(client):
    parent = create(client)
    child = create(client, parent_id=parent["id"])
    assert client.post(BASE + "/tasks", json={"title": "三层", "parent_id": child["id"]}).status_code == 422
    assert patch(client, parent, parent_id=child["id"]).status_code == 422
    assert patch(client, parent, parent_id=parent["id"]).status_code == 422
    before = len(listed(client))
    failed = client.post(BASE + "/tasks/batch", json={"parent": {"title": "新目标"},
                        "children": [{"title": "好"}, {"title": "坏", "subject_id": "missing"}]})
    assert failed.status_code == 422 and len(listed(client)) == before
    result = client.post(BASE + "/tasks/batch", json={"parent": {"title": "新目标", "source": "ai_breakdown"},
                         "children": [{"title": "步骤", "parent_id": "ignored"}]}).json()
    assert result["children"][0]["parent_id"] == result["parent"]["id"]
    standalone = client.post(BASE + "/tasks/batch", json={"parent": None,
                            "children": [{"title": "独立", "parent_id": "ignored"}]}).json()
    assert standalone["children"][0]["parent_id"] is None
    assert client.post(BASE + "/tasks/batch", json={"children": [{"title": "x"}] * 31}).status_code == 422
    assert client.delete(BASE + "/tasks/" + parent["id"]).status_code == 204
    assert patch(client, child, title="deleted").status_code == 404


def _agenda_pairs(store):
    with store.connection() as db:
        return {(row["id"], row["source"]) for row in db.execute("SELECT id, source FROM agenda_tasks")}


def test_legacy_review_rows_are_deleted_and_rerun_is_safe(tmp_path):
    from app.agenda.store import ensure
    kept = {("manual", "manual"), ("ai", "ai_breakdown")}
    store = agenda_with_review_rows(tmp_path / "old.sqlite3")
    ensure(store)
    assert _agenda_pairs(store) == kept
    ensure(store)
    assert _agenda_pairs(store) == kept


def test_review_purge_marker_is_per_database(tmp_path):
    from app.agenda.store import ensure
    kept = {("manual", "manual"), ("ai", "ai_breakdown")}
    ensure(agenda_with_review_rows(tmp_path / "one.sqlite3"))
    second = agenda_with_review_rows(tmp_path / "two.sqlite3")
    ensure(second)
    assert _agenda_pairs(second) == kept


def test_unresolved_misconceptions_do_not_generate_tasks(client):
    import json
    from app.agent_tools.agenda import run as agenda_run
    from app.chat.service import ToolContext
    seed_memory(client)
    assert listed(client) == []
    assert client.get(BASE + "/feed").json()["tasks"] == []
    assert "BEGIN:VEVENT" not in client.get(BASE + "/export.ics").text
    ctx = ToolContext(None, client.app.state.chat_service.store, "demo-student-001", "missing")
    assert json.loads(agenda_run("agenda_list", {"days": 60}, ctx))["tasks"] == []
    with client.app.state.store.connection() as db:
        assert db.execute("SELECT COUNT(*) FROM agenda_tasks").fetchone()[0] == 0


def test_threads_feed_dates_and_subject_filter(client):
    subject = client.post("/api/subjects", json={"name": "电路", "deadline": "2026-10-30"}).json()
    thread = client.post(f"/api/subjects/{subject['id']}/threads", json={"title": "定理", "client_request_id": "agenda-thread"}).json()
    task = create(client, subject_id=subject["id"], thread_id=thread["id"], scheduled_date="2027-01-01")
    done = patch(client, create(client), status="done").json()
    feed = client.get(BASE + "/feed", params={"from": "2026-01-01", "to": "2026-01-02"}).json()
    assert [t["id"] for t in feed["tasks"]] == [task["id"]]  # all open, not schedule-filtered
    assert feed["threads"][0]["thread_id"] == thread["id"]
    assert feed["threads"][0]["deadline_date"] == "2026-10-30"
    assert feed["threads"][0]["subject_name"] == "电路"
    today = date.today().isoformat()
    assert len(client.get(BASE + "/feed", params={"from": today, "to": today}).json()["tasks"]) == 2
    assert client.get(BASE + "/feed", params={"from": "bad"}).status_code == 422
    assert client.get(BASE + "/feed", params={"from": "2026-10-31", "to": "2026-10-01"}).status_code == 422
    assert [t["id"] for t in listed(client, subject_id=subject["id"])] == [task["id"]]
    with client.app.state.store.connection() as db:
        db.execute("UPDATE conversations SET thread_status='resolved' WHERE id=?", (thread["id"],))
    assert client.get(BASE + "/feed").json()["threads"] == []


def test_cross_student_isolation(client):
    task = create(client)
    subject = client.post("/api/subjects", json={"name": "私有"}).json()
    thread = client.post(f"/api/subjects/{subject['id']}/threads", json={"client_request_id": "private-thread"}).json()
    with client.app.state.store.connection() as db:
        db.execute("UPDATE agenda_tasks SET student_id='other' WHERE id=?", (task["id"],))
        db.execute("UPDATE subjects SET student_id='other' WHERE id=?", (subject["id"],))
        db.execute("UPDATE conversations SET student_id='other' WHERE subject_id=?", (subject["id"],))
    seed_memory(client, student="other")
    assert listed(client) == [] and client.get(BASE + "/feed").json()["threads"] == []
    assert patch(client, task, title="偷改").status_code == 404
    assert client.delete(BASE + "/tasks/" + task["id"]).status_code == 404
    assert client.post(BASE + "/tasks", json={"title": "x", "parent_id": task["id"]}).status_code == 404
    for fields in ({"subject_id": subject["id"]}, {"thread_id": thread["id"]}):
        assert client.post(BASE + "/tasks", json={"title": "x", **fields}).status_code == 422
    assert "私有" not in client.get(BASE + "/export.ics").text


def test_ics_utf8_crlf_escaping_folding_and_event_types(client):
    create(client, title="逗号,分号;反斜\\中文" * 12, notes="第一行\n第二行,;\\\r\nEND:VEVENT",
           scheduled_date="2026-10-22", scheduled_start_at="2026-10-22T15:00", duration_minutes=45)
    create(client, title="全天", scheduled_date="2026-10-23")
    create(client, title="交卷", deadline_date="2026-10-24")
    create(client, title="没有日期")
    done = create(client, title="已完成", scheduled_date="2026-10-25")
    patch(client, done, status="done")
    response = client.get(BASE + "/export.ics")
    assert response.status_code == 200 and response.headers["content-type"] == "text/calendar; charset=utf-8"
    assert 'filename="knowgap-agenda.ics"' in response.headers["content-disposition"]
    content = response.content
    assert b"\n" not in content.replace(b"\r\n", b"")
    assert all(len(line) <= 75 for line in content.split(b"\r\n"))
    unfolded = response.text.replace("\r\n ", "")
    assert unfolded.count("BEGIN:VEVENT") == 3
    assert "DTSTART:20261022T150000" in unfolded and "DTEND:20261022T154500" in unfolded
    assert "DTSTART;VALUE=DATE:20261023" in unfolded and "DTEND;VALUE=DATE:20261024" in unfolded
    assert "SUMMARY:截止：交卷" in unfolded
    assert "逗号\\,分号\\;反斜\\\\中文" in unfolded
    assert "第一行\\n第二行\\,\\;\\\\\\nEND:VEVENT" in unfolded
    assert client.get(BASE + "/export.ics?status=all").text.count("BEGIN:VEVENT") == 4


def test_breakdown_success_clips_dates_and_count_without_persistence(tmp_path):
    raw = {"parent": {"title": "考试", "deadline_date": "2026-12-01", "id": "unsafe"},
           "children": [{"title": "步骤", "scheduled_date": "2026-01-01", "scheduled_start_at": "2026-01-01T09:00"}] * 15}
    model = FakeChat(analyses=[raw])
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=model)) as client:
        response = client.post(BASE + "/breakdown", json={"goal": "考试", "today": "2026-10-21", "deadline_date": "2026-11-01"})
        assert response.status_code == 200, response.text
        draft = response.json()
        assert len(draft["children"]) == 12 and draft["parent"]["deadline_date"] == "2026-11-01"
        assert "id" not in draft["parent"]
        assert draft["children"][0]["scheduled_start_at"] == "2026-10-21T09:00"
        assert listed(client) == [] and len(model.analysis_calls) == 1


@pytest.mark.parametrize("reply", [RuntimeError("offline"), {}, {"parent": {"title": "x"}, "children": [{"title": ""}]}])
def test_breakdown_unavailable_and_invalid_response(tmp_path, reply):
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=FakeChat(analyses=[reply]))) as client:
        response = client.post(BASE + "/breakdown", json={"goal": "学习", "today": "2026-10-21"})
        assert response.status_code == 503 and response.json()["detail"]
        assert listed(client) == []


def test_breakdown_drops_only_malformed_children(tmp_path):
    raw = {"parent": {"title": "期末"}, "children": [{"title": "好步骤", "scheduled_start_at": "2026-10-22T09:00"},
                                                     {"title": ""}, {"title": "也好", "priority": 9}]}
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=FakeChat(analyses=[raw]))) as client:
        response = client.post(BASE + "/breakdown", json={"goal": "期末", "today": "2026-10-21"})
    assert response.status_code == 200, response.text
    children = response.json()["children"]
    assert [child["title"] for child in children] == ["好步骤"]
    assert children[0]["scheduled_date"] == "2026-10-22"


def test_breakdown_timeout_and_input_validation(tmp_path, monkeypatch):
    class Slow(FakeChat):
        async def complete_json(self, messages):
            await asyncio.sleep(30)
    monkeypatch.setattr("app.agenda.breakdown.MODEL_TIMEOUT_SECONDS", 0.01)
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=Slow())) as client:
        assert client.post(BASE + "/breakdown", json={"goal": "学习", "today": "2026-10-21"}).status_code == 503
        assert client.post(BASE + "/breakdown", json={"goal": "学习", "today": "2026-10-21", "subject_id": "other"}).status_code == 422
        assert client.post(BASE + "/breakdown", json={"goal": "学习", "today": "2026-10-21", "deadline_date": "2026-10-01"}).status_code == 422


def test_migration_repeatable_across_app_restart(tmp_path):
    settings = isolated_settings(tmp_path)
    with TestClient(create_app(settings, chat_model=FakeChat())) as client:
        task = create(client)
    with TestClient(create_app(settings, chat_model=FakeChat())) as client:
        assert listed(client)[0]["id"] == task["id"]


def test_reminder_old_database_migration_idempotent(client):
    from app.agenda.store import ensure
    task = create(client)
    store = client.app.state.store
    with store.connection() as db:
        db.execute("ALTER TABLE agenda_tasks DROP COLUMN reminder_minutes")
    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(lambda _: ensure(store), range(8)))
    assert listed(client)[0]["id"] == task["id"]
    assert listed(client)[0]["reminder_minutes"] is None
    assert patch(client, task, reminder_minutes=10).json()["reminder_minutes"] == 10
    ensure(store)
    assert listed(client)[0]["reminder_minutes"] == 10


@pytest.mark.parametrize("minutes", [None, 0, 5, 10, 15, 30, 60, 120, 1440])
def test_reminder_roundtrip_and_clear(client, minutes):
    task = create(client, reminder_minutes=minutes)
    assert task["reminder_minutes"] == minutes
    assert listed(client)[0]["reminder_minutes"] == minutes
    assert patch(client, task, reminder_minutes=minutes).json()["reminder_minutes"] == minutes
    assert patch(client, task, reminder_minutes=None).json()["reminder_minutes"] is None
    assert listed(client)[0]["reminder_minutes"] is None


@pytest.mark.parametrize("minutes", [-1, 1, 7, 1441, True, False, "5", 5.0, [], {}])
def test_reminder_invalid_create_patch_and_draft(client, minutes):
    from app.agenda.schemas import TaskDraft
    from pydantic import ValidationError
    assert client.post(BASE + "/tasks", json={"title": "提醒", "reminder_minutes": minutes}).status_code == 422
    task = create(client, reminder_minutes=5)
    assert patch(client, task, reminder_minutes=minutes).status_code == 422
    assert listed(client)[0]["reminder_minutes"] == 5
    with pytest.raises(ValidationError):
        TaskDraft(title="提醒", reminder_minutes=minutes)


@pytest.mark.parametrize("minutes", [0, 10, 1440])
def test_ics_reminder_only_for_timed_events(client, minutes):
    create(client, title="复习,定理;\\\n继续", scheduled_date="2026-10-22",
           scheduled_start_at="2026-10-22T10:00", reminder_minutes=minutes)
    create(client, title="全天提醒不触发", scheduled_date="2026-10-22", reminder_minutes=minutes)
    create(client, title="无提醒", scheduled_date="2026-10-22", scheduled_start_at="2026-10-22T11:00")
    text = client.get(BASE + "/export.ics").text.replace("\r\n ", "")
    assert text.count("BEGIN:VALARM") == text.count("END:VALARM") == 1
    assert f"BEGIN:VALARM\r\nTRIGGER:-PT{minutes}M\r\nACTION:DISPLAY\r\n" in text
    assert "DESCRIPTION:复习\\,定理\\;\\\\\\n继续\r\nEND:VALARM\r\nEND:VEVENT" in text

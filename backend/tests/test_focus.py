from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient

from app.main import create_app
from app.models.schemas import DEMO_STUDENT
from tests.test_acceptance_support import isolated_settings
from tests.test_auth_and_isolation import auth_headers
from tests.test_chat import FakeChat


def local_day(value: str) -> str:
    parsed = datetime.fromisoformat(value)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone().date().isoformat()


def test_start_and_finish_session_is_scoped_to_the_student(tmp_path):
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=FakeChat())) as client:
        code = client.post("/api/auth/send-code", json={"email": "bob@school.edu", "purpose": "register"}).json()["demo_code"]
        bob = client.post(
            "/api/auth/register",
            json={"email": "bob@school.edu", "password": "password123", "code": code, "display_name": "Bob"},
        ).json()
        bob_headers = auth_headers(bob["token"])

        empty = client.post("/api/focus/sessions", json={"title": "  ", "planned_minutes": 25})
        assert empty.status_code == 422
        assert client.post("/api/focus/sessions", json={"title": "太短", "planned_minutes": -1}).status_code == 422

        started = client.post("/api/focus/sessions", json={
            "title": " 复习戴维南 ", "planned_minutes": 25, "task_id": "", "subject_id": "subj-demo",
        })
        assert started.status_code == 201, started.text
        session = started.json()
        assert session["student_id"] == DEMO_STUDENT
        assert session["title"] == "复习戴维南"
        assert session["task_id"] is None
        assert session["subject_id"] == "subj-demo"
        assert session["status"] is None
        assert session["ended_at"] is None
        assert session["planned_minutes"] == 25

        demo_blast = client.post("/api/focus/sessions", json={"title": "极速演示", "planned_minutes": 0})
        assert demo_blast.status_code == 201

        missing = client.patch(f"/api/focus/sessions/{session['id']}", headers=bob_headers, json={
            "status": "completed", "note": "别人的",
        })
        assert missing.status_code == 404

        done = client.patch(f"/api/focus/sessions/{session['id']}", json={
            "status": "completed", "note": " 搞清了等效电路 ", "actual_seconds": 90,
        })
        assert done.status_code == 200, done.text
        assert done.json()["status"] == "completed"
        assert done.json()["note"] == "搞清了等效电路"
        assert done.json()["actual_seconds"] == 90
        assert done.json()["ended_at"]

        again = client.patch(f"/api/focus/sessions/{session['id']}", json={"status": "abandoned", "note": "再来"})
        assert again.status_code == 409

        store = client.app.state.store
        abandoned = client.patch(f"/api/focus/sessions/{demo_blast.json()['id']}", json={
            "status": "abandoned", "note": "超时未结项", "actual_seconds": 30,
        })
        assert abandoned.status_code == 200, abandoned.text
        assert abandoned.json()["actual_seconds"] == 30

        heatmap = client.get("/api/focus/heatmap").json()
        today = datetime.now().astimezone().date().isoformat()
        by_day = {item["date"]: item for item in heatmap["days"]}
        assert heatmap["weeks"] == 12
        assert len(heatmap["days"]) == 84
        assert datetime.fromisoformat(heatmap["start"]).weekday() == 0
        assert datetime.fromisoformat(heatmap["end"]).weekday() == 6
        assert by_day[today]["focus_minutes"] == 2.0

        measured = client.post("/api/focus/sessions", json={"title": "计时", "planned_minutes": 25}).json()
        past = (datetime.now(timezone.utc) - timedelta(seconds=30)).isoformat()
        with store.connection() as db:
            db.execute("UPDATE focus_sessions SET started_at = ? WHERE id = ?", (past, measured["id"]))
        abandoned = client.patch(f"/api/focus/sessions/{measured['id']}", json={"status": "abandoned", "note": "超时未结项"})
        assert abandoned.status_code == 200, abandoned.text
        assert abandoned.json()["status"] == "abandoned"
        assert 25 <= abandoned.json()["actual_seconds"] <= 40

        bob_heatmap = client.get("/api/focus/heatmap", headers=bob_headers).json()
        bob_today = {item["date"]: item for item in bob_heatmap["days"]}[today]
        assert bob_today["focus_minutes"] == 0
        assert client.get("/api/focus/heatmap?weeks=0").status_code == 422


def test_heatmap_counts_cleared_misconceptions_and_resolved_threads(tmp_path):
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=FakeChat())) as client:
        assert client.get("/api/focus/heatmap").status_code == 200
        store = client.app.state.store
        boundary_dt = (datetime.now(timezone.utc) - timedelta(days=10)).replace(hour=20, minute=0, second=0, microsecond=0)
        boundary = boundary_dt.isoformat()
        boundary_day = local_day(boundary)
        utc_day = boundary[:10]
        now = datetime.now(timezone.utc).isoformat()
        today = local_day(now)
        old = (datetime.now(timezone.utc) - timedelta(days=3)).isoformat()
        old_day = local_day(old)
        with store.connection() as db:
            db.executemany(
                """
                INSERT INTO learner_memories(
                    id, student_id, kind, topic, summary, status, confidence, created_at, updated_at
                ) VALUES (?, ?, 'misconception', ?, '摘要', ?, 0.6, ?, ?)
                """,
                [
                    ("lmem-resolved", DEMO_STUDENT, "方向反了", "resolved", now, now),
                    ("lmem-improving", DEMO_STUDENT, "公式用错", "improving", now, now),
                    ("lmem-open", DEMO_STUDENT, "还没搞懂", "suspected", now, now),
                    ("lmem-boundary", DEMO_STUDENT, "时区边界", "resolved", boundary, boundary),
                    ("lmem-old", DEMO_STUDENT, "三天前", "resolved", old, old),
                    ("lmem-other", "student-bob", "别人的误区", "resolved", now, now),
                ],
            )
            db.execute(
                """
                INSERT INTO learner_memories(
                    id, student_id, kind, topic, summary, status, confidence, created_at, updated_at
                ) VALUES ('lmem-mastery', ?, 'mastery', '已掌握', '摘要', 'resolved', 0.9, ?, ?)
                """,
                (DEMO_STUDENT, now, now),
            )
            db.executemany(
                """
                INSERT INTO conversations(
                    id, student_id, title, title_source, created_at, updated_at, kind, thread_status, resolved_at
                ) VALUES (?, ?, 'Thread', 'user', ?, ?, 'thread', ?, ?)
                """,
                [
                    ("conv-resolved", DEMO_STUDENT, now, now, "resolved", now),
                    ("conv-open", DEMO_STUDENT, now, now, "open", None),
                    ("conv-old", DEMO_STUDENT, old, old, "resolved", old),
                    ("conv-other", "student-bob", now, now, "resolved", now),
                ],
            )
            db.execute(
                """
                INSERT INTO focus_sessions(
                    id, student_id, title, planned_minutes, started_at, ended_at, actual_seconds, status, note
                ) VALUES ('focus-other', 'student-bob', '别人的', 25, ?, ?, 3600, 'completed', '')
                """,
                (now, now),
            )

        heatmap = client.get("/api/focus/heatmap?weeks=12").json()
        by_day = {item["date"]: item for item in heatmap["days"]}
        expected_mis = {today: 2, boundary_day: 0, old_day: 0}
        expected_threads = {today: 1, boundary_day: 0, old_day: 0}
        expected_mis[boundary_day] += 1
        expected_mis[old_day] += 1
        expected_threads[old_day] += 1
        for day, count in expected_mis.items():
            assert by_day[day]["misconceptions_resolved"] == count
        for day, count in expected_threads.items():
            assert by_day[day]["threads_resolved"] == count
        assert by_day[today]["focus_minutes"] == 0
        if utc_day != boundary_day and utc_day not in expected_mis:
            assert by_day[utc_day]["misconceptions_resolved"] == 0

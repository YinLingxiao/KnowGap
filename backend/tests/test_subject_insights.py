"""Space insights aggregation and the exam cheat sheet built on it (contract: docs/contracts/subject-insights.md)."""

import asyncio
import json

from fastapi.testclient import TestClient

from app.agents.llm import ProviderError
from app.chat import cheatsheet as cheatsheet_module
from app.main import create_app
from tests.test_acceptance_support import isolated_settings
from tests.test_auth_and_isolation import auth_headers
from tests.test_chat import FakeChat

SHEET = {
    "formulas": [{"name": "欧姆定律", "formula": "$U = IR$", "conditions": "线性电阻、直流稳态", "pitfall": ""}],
    "contrasts": [{"a": "栈", "b": "队列", "difference": "栈后进先出，队列先进先出", "tip": "叠盘子 vs 排队"}],
    "quiz": [{"question": "push 1,2,3 后 pop 得到什么？", "answer": "3"}, {"question": "", "answer": "缺题干被丢弃"}],
}


class SlowChat(FakeChat):
    async def complete_json(self, messages):
        await asyncio.sleep(5)
        return SHEET


def seeded(client, name="数据结构"):
    """A space with one open misconception (with a learner quote), one mastery, a resolved and an open thread."""
    space = client.post("/api/subjects", json={"name": name, "goal": "期末 85+", "deadline": "2026-12-31"}).json()
    store = client.app.state.chat_service.store
    with store.connection() as db:
        student = db.execute("SELECT student_id FROM subjects WHERE id = ?", (space["id"],)).fetchone()[0]
    thread = client.post(f"/api/subjects/{space['id']}/threads",
                         json={"title": "栈的出栈顺序", "client_request_id": "thread-req-0001"}).json()
    message_id = store.add_user_message(thread["id"], "我觉得栈是先进先出的", "msg-req-00001")
    store.record_observation(
        student, kind="misconception", topic="栈的顺序", topic_key=None, summary="把栈记成了先进先出",
        quote="栈是先进先出", reason="原话", signal="supports", related_id=None,
        conversation_id=thread["id"], message_id=message_id, subject_id=space["id"],
    )
    store.record_observation(
        student, kind="mastery", topic="队列", topic_key=None, summary="能正确说明队列先进先出",
        quote="我觉得栈是先进先出的", reason="测试", signal="supports", related_id=None,
        conversation_id=thread["id"], message_id=message_id, subject_id=space["id"],
    )
    resolved = client.post(f"/api/conversations/{thread['id']}/resolve", json={
        "title": "栈的出栈顺序", "summary": "栈是后进先出，最后压入的元素最先弹出。", "takeaways": ["LIFO：叠盘子"],
    })
    assert resolved.status_code == 200, resolved.text
    open_thread = client.post(f"/api/subjects/{space['id']}/threads",
                              json={"title": "红黑树", "client_request_id": "thread-req-0002"}).json()
    return space, thread, open_thread


def test_insights_aggregates_memories_threads_and_stats(tmp_path):
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=FakeChat())) as client:
        space, thread, open_thread = seeded(client)
        response = client.get(f"/api/subjects/{space['id']}/insights")
        assert response.status_code == 200, response.text
        data = response.json()
        assert data["schema_version"] == 1
        assert data["subject"]["name"] == "数据结构" and data["subject"]["goal"] == "期末 85+"
        assert data["subject"]["deadline"] == "2026-12-31"

        [wrong] = data["misconceptions"]
        assert wrong["topic"] == "栈的顺序" and wrong["status"] in {"suspected", "needs_review"}
        assert wrong["evidence"][0]["quote"] == "栈是先进先出" and wrong["evidence"][0]["signal"] == "supports"
        assert [m["topic"] for m in data["mastered"]] == ["队列"] and data["mastered"][0]["source"] == "mastery"

        by_id = {t["id"]: t for t in data["threads"]}
        assert by_id[thread["id"]]["status"] == "resolved"
        assert by_id[thread["id"]]["summary"].startswith("栈是后进先出")
        assert by_id[thread["id"]]["takeaways"] == ["LIFO：叠盘子"]
        assert by_id[open_thread["id"]]["status"] == "open"
        assert by_id[open_thread["id"]]["summary"] == "" and by_id[open_thread["id"]]["takeaways"] == []
        assert data["threads"][0]["status"] == "open"  # open threads first

        stats = data["stats"]
        assert stats["misconceptions"] == 1 and stats["to_review"] == 1 and stats["mastered"] == 1
        assert stats["threads_open"] == 1 and stats["threads_resolved"] == 1 and stats["evidence"] == 2
        assert stats["materials"] == 0 and isinstance(stats["days_to_deadline"], int)
        # Read-only and deterministic.
        assert client.get(f"/api/subjects/{space['id']}/insights").json() == data


def test_insights_empty_space_shape_and_404s(tmp_path):
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=FakeChat())) as client:
        space = client.post("/api/subjects", json={"name": "空空间"}).json()
        data = client.get(f"/api/subjects/{space['id']}/insights").json()
        assert data["misconceptions"] == [] and data["mastered"] == [] and data["threads"] == []
        assert data["materials"] == [] and data["subject"]["deadline"] is None
        assert data["stats"]["days_to_deadline"] is None and data["stats"]["misconceptions"] == 0
        assert client.get("/api/subjects/subj-missing/insights").status_code == 404
        assert client.post("/api/subjects/subj-missing/cheatsheet", json={}).status_code == 404


def test_cross_student_insights_and_cheatsheet_are_404(tmp_path):
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=FakeChat(analyses=[SHEET]))) as client:
        tokens = []
        for email in ("alice@school.edu", "bob@school.edu"):
            code = client.post("/api/auth/send-code", json={"email": email, "purpose": "register"}).json()["demo_code"]
            tokens.append(client.post("/api/auth/register", json={
                "email": email, "password": "password123", "code": code, "display_name": email[:3],
            }).json()["token"])
        alice, bob = (auth_headers(token) for token in tokens)
        space = client.post("/api/subjects", headers=alice, json={"name": "Alice 的空间"}).json()
        assert client.get(f"/api/subjects/{space['id']}/insights", headers=alice).status_code == 200
        assert client.get(f"/api/subjects/{space['id']}/insights", headers=bob).status_code == 404
        assert client.post(f"/api/subjects/{space['id']}/cheatsheet", headers=bob, json={}).status_code == 404


def test_cheatsheet_uses_real_evidence_and_caches(tmp_path):
    model = FakeChat(analyses=[SHEET, SHEET])
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=model)) as client:
        space, thread, _ = seeded(client)
        response = client.post(f"/api/subjects/{space['id']}/cheatsheet", json={"notes": "笔记：栈 LIFO"})
        assert response.status_code == 200, response.text
        sheet = response.json()
        assert sheet["degraded"] is False and sheet["cached"] is False and sheet["notice"] is None
        sections = sheet["sections"]
        assert sections["pitfalls"] == [{
            "memory_id": sections["pitfalls"][0]["memory_id"], "topic": "栈的顺序", "summary": "把栈记成了先进先出",
            "status": sections["pitfalls"][0]["status"], "quotes": ["栈是先进先出"],
        }]
        assert sections["conclusions"][0]["thread_id"] == thread["id"]
        assert sections["conclusions"][0]["takeaways"] == ["LIFO：叠盘子"]
        assert sections["formulas"][0]["formula"] == "$U = IR$"
        assert len(sections["quiz"]) == 1  # the item without a question is dropped
        assert "## ① 个人易错红榜" in sheet["markdown"] and "「栈是先进先出」" in sheet["markdown"]
        assert "$U = IR$" in sheet["markdown"]

        # The model saw the space data and the client's notes, not a request to write evidence.
        sent = model.analysis_calls[0]
        assert sent["notes"] == "笔记：栈 LIFO" and sent["misconceptions"][0]["topic"] == "栈的顺序"
        assert sent["thread_conclusions"][0]["takeaways"] == ["LIFO：叠盘子"]

        again = client.post(f"/api/subjects/{space['id']}/cheatsheet", json={"notes": "笔记：栈 LIFO"}).json()
        assert again["cached"] is True and len(model.analysis_calls) == 1
        assert again["sections"] == sections

        forced = client.post(f"/api/subjects/{space['id']}/cheatsheet", json={"notes": "笔记：栈 LIFO", "force": True})
        assert forced.json()["cached"] is False and len(model.analysis_calls) == 2


def test_cheatsheet_degrades_when_model_fails(tmp_path):
    model = FakeChat(analyses=[ProviderError(503, "模型服务暂时限流"), SHEET])
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=model)) as client:
        space, thread, _ = seeded(client)
        response = client.post(f"/api/subjects/{space['id']}/cheatsheet", json={})
        assert response.status_code == 200, response.text
        sheet = response.json()
        assert sheet["degraded"] is True and "模型暂不可用" in sheet["notice"]
        assert sheet["sections"]["pitfalls"][0]["quotes"] == ["栈是先进先出"]
        assert sheet["sections"]["conclusions"][0]["thread_id"] == thread["id"]
        assert sheet["sections"]["formulas"] == [] and sheet["sections"]["contrasts"] == []
        assert sheet["sections"]["quiz"] == []
        # Degraded sheets are not cached: the next open retries the model.
        retry = client.post(f"/api/subjects/{space['id']}/cheatsheet", json={}).json()
        assert retry["degraded"] is False and retry["sections"]["formulas"]


def test_cheatsheet_degrades_on_timeout_and_garbage(tmp_path, monkeypatch):
    monkeypatch.setattr(cheatsheet_module, "MODEL_TIMEOUT_SECONDS", 0.05)
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=SlowChat())) as client:
        space, _, _ = seeded(client)
        sheet = client.post(f"/api/subjects/{space['id']}/cheatsheet").json()
        assert sheet["degraded"] is True and "超时" in sheet["notice"]
        assert sheet["sections"]["pitfalls"] and sheet["sections"]["formulas"] == []

    with TestClient(create_app(isolated_settings(tmp_path / "b"), chat_model=FakeChat(analyses=["not json"]))) as client:
        space, _, _ = seeded(client)
        sheet = client.post(f"/api/subjects/{space['id']}/cheatsheet", json={}).json()
        assert sheet["degraded"] is False and sheet["notice"] and sheet["sections"]["formulas"] == []


def test_validate_repairs_unescaped_latex_from_model_json():
    # "\tau", "\frac", "\beta" written unescaped in JSON decode to TAB / form feed / backspace.
    raw = json.loads(r'{"formulas":[{"formula":"$\tau=RC$, $\frac{a}{b}$, $\beta$, $a\neq b$","conditions":"一\n二"}]}')
    [formula] = cheatsheet_module.validate(raw)["formulas"]
    assert formula["formula"] == r"$\tau=RC$, $\frac{a}{b}$, $\beta$, $a\neq b$"
    assert formula["conditions"] == "一 二"

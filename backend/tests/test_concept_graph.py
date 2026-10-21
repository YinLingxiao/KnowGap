"""Concept-graph outer ring: model output, cache, degradation, and student isolation."""

import asyncio
import json

from fastapi.testclient import TestClient

from app.agents.llm import ProviderError
from app.chat import concept_graph as concept_graph_module
from app.main import create_app
from app.memory.store import now
from tests.test_acceptance_support import isolated_settings
from tests.test_auth_and_isolation import auth_headers
from tests.test_chat import FakeChat
from tests.test_subject_insights import seeded


class Scripted(FakeChat):
    async def complete_json(self, messages):
        payload = json.loads(messages[-1]["content"])
        self.analysis_calls.append(payload)
        known = payload["known_nodes"]
        first = known[0]["id"] if known else "missing"
        concepts = [
            {"name": f"概念{i}", "summary": f"说明{i}", "related_ids": [first, "nope"]}
            for i in range(10)
        ]
        concepts.append({"name": "队列", "summary": "已经掌握，应丢掉", "related_ids": []})
        concepts.append({"name": "概念0", "summary": "重复名称", "related_ids": [first]})
        return {"concepts": concepts}


class SlowChat(FakeChat):
    async def complete_json(self, messages):
        self.analysis_calls.append(json.loads(messages[-1]["content"]))
        await asyncio.sleep(5)
        return {"concepts": [{"name": "不应出现", "summary": "超时", "related_ids": []}]}


def _add_material(client, space_id: str) -> None:
    store = client.app.state.chat_service.store
    with store.connection() as db:
        student = db.execute("SELECT student_id FROM subjects WHERE id = ?", (space_id,)).fetchone()[0]
        db.execute(
            "INSERT INTO course_materials(id, student_id, title, kind, page_count, chunk_count, created_at, subject_id) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            ("material-graph", student, "第3章 栈与队列.md", "md", 0, 1, now(), space_id),
        )
        db.execute(
            "INSERT INTO course_chunks(id, document_id, content, page, start_line, end_line) VALUES (?, ?, ?, ?, ?, ?)",
            ("source-graph", "material-graph", "# 栈与队列\n说明\n## 循环队列\n第3章 树\n", None, 1, 4),
        )


def test_concept_graph_filters_caches_and_refreshes(tmp_path):
    model = Scripted()
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=model)) as client:
        space, _, _ = seeded(client)
        _add_material(client, space["id"])
        response = client.post(f"/api/subjects/{space['id']}/concept-graph", json={})
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["degraded"] is False and body["cached"] is False and body["notice"] is None
        assert {node["name"] for node in body["nodes"]} == {f"概念{i}" for i in range(8)}
        assert all(node["id"].startswith("fog-") for node in body["nodes"])
        assert [node["id"] for node in body["nodes"]] == sorted(node["id"] for node in body["nodes"])

        sent = model.analysis_calls[0]
        assert sent["subject"]["goal"] == "期末 85+"
        assert sent["misconceptions"][0]["topic"] == "栈的顺序"
        assert sent["materials"][0]["title"] == "第3章 栈与队列.md"
        assert sent["materials"][0]["outline"] == ["栈与队列", "循环队列", "第3章 树"]
        first = sent["known_nodes"][0]["id"]
        assert all(node["related_ids"] == [first] for node in body["nodes"])
        assert "队列" not in {node["name"] for node in body["nodes"]}

        again = client.post(f"/api/subjects/{space['id']}/concept-graph", json={}).json()
        assert again["cached"] is True and len(model.analysis_calls) == 1
        assert [node["id"] for node in again["nodes"]] == [node["id"] for node in body["nodes"]]

        forced = client.post(f"/api/subjects/{space['id']}/concept-graph", json={"force": True}).json()
        assert forced["cached"] is False and len(model.analysis_calls) == 2

        changed = client.patch(f"/api/subjects/{space['id']}", json={"goal": "期末 90+"})
        assert changed.status_code == 200, changed.text
        refreshed = client.post(f"/api/subjects/{space['id']}/concept-graph", json={}).json()
        assert refreshed["cached"] is False and len(model.analysis_calls) == 3
        assert model.analysis_calls[-1]["subject"]["goal"] == "期末 90+"


def test_concept_graph_degrades_when_model_fails_then_retries(tmp_path):
    ok = {"concepts": [
        {"name": "平衡二叉树", "summary": "左右子树高度差不超过 1", "related_ids": ["nope"]},
        {"name": "堆", "summary": "用完全二叉树存储", "related_ids": []},
        {"name": "哈希", "summary": "按关键字定位", "related_ids": []},
    ]}
    model = FakeChat(analyses=[ProviderError(503, "模型服务暂时限流"), ok])
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=model)) as client:
        space, _, _ = seeded(client)
        response = client.post(f"/api/subjects/{space['id']}/concept-graph", json={})
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["degraded"] is True and body["nodes"] == [] and "模型暂不可用" in body["notice"]
        retry = client.post(f"/api/subjects/{space['id']}/concept-graph", json={}).json()
        assert retry["degraded"] is False and retry["cached"] is False
        assert {node["name"] for node in retry["nodes"]} == {"平衡二叉树", "堆", "哈希"}
        assert all(node["related_ids"] == [] for node in retry["nodes"])


def test_concept_graph_degrades_on_timeout_and_garbage(tmp_path, monkeypatch):
    monkeypatch.setattr(concept_graph_module, "MODEL_TIMEOUT_SECONDS", 0.05)
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=SlowChat())) as client:
        space, _, _ = seeded(client)
        body = client.post(f"/api/subjects/{space['id']}/concept-graph").json()
        assert body["degraded"] is True and body["nodes"] == [] and "超时" in body["notice"]

    with TestClient(create_app(isolated_settings(tmp_path / "b"), chat_model=FakeChat(analyses=["not json"]))) as client:
        space, _, _ = seeded(client)
        body = client.post(f"/api/subjects/{space['id']}/concept-graph", json={}).json()
        assert body["degraded"] is False and body["nodes"] == [] and body["notice"]
        cached = client.post(f"/api/subjects/{space['id']}/concept-graph", json={}).json()
        assert cached["cached"] is True and cached["nodes"] == []


def test_concept_graph_empty_space_does_not_500(tmp_path):
    model = FakeChat(analyses=[ProviderError(503, "down")])
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=model)) as client:
        space = client.post("/api/subjects", json={"name": "空空间"}).json()
        response = client.post(f"/api/subjects/{space['id']}/concept-graph", json={})
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["degraded"] is True and body["nodes"] == [] and body["notice"]


def test_concept_graph_missing_and_cross_student_are_404(tmp_path):
    model = FakeChat(analyses=[{"concepts": [{"name": "不该生成", "summary": "隔离", "related_ids": []}]}])
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=model)) as client:
        assert client.post("/api/subjects/subj-missing/concept-graph", json={}).status_code == 404
        tokens = []
        for email in ("alice@school.edu", "bob@school.edu"):
            code = client.post("/api/auth/send-code", json={"email": email, "purpose": "register"}).json()["demo_code"]
            tokens.append(client.post("/api/auth/register", json={
                "email": email, "password": "password123", "code": code, "display_name": email[:3],
            }).json()["token"])
        alice, bob = (auth_headers(token) for token in tokens)
        space = client.post("/api/subjects", headers=alice, json={"name": "Alice 的空间"}).json()
        assert client.post(f"/api/subjects/{space['id']}/concept-graph", headers=bob, json={}).status_code == 404
        assert model.analysis_calls == []
        own = client.post(f"/api/subjects/{space['id']}/concept-graph", headers=alice, json={})
        assert own.status_code == 200, own.text
        assert own.json()["nodes"][0]["name"] == "不该生成"

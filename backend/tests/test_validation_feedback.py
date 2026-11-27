"""Regressions from the desktop QA report: readable errors and real dates."""

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app


@pytest.fixture
def client(tmp_path):
    settings = Settings(_env_file=None, database_path=tmp_path / "validation.sqlite3",
                        llm_api_key="", llm_base_url="", llm_model="")
    with TestClient(create_app(settings)) as client:
        yield client


@pytest.mark.parametrize("method,path,arguments,label", [
    ("get", "/api/materials/search", {"params": {"q": ""}}, "搜索内容"),
    ("get", "/api/materials/search", {"params": {"q": "测" * 601}}, "搜索内容"),
    ("get", "/api/materials/search", {"params": {"q": "栈", "limit": 11}}, "结果数量"),
    ("post", "/api/subjects", {"json": {"name": ""}}, "学习空间名称"),
    ("post", "/api/subjects", {"json": {"name": "测" * 500}}, "学习空间名称"),
    ("post", "/api/agenda/tasks", {"json": {"title": "复习", "duration_minutes": -5}}, "预计时长"),
    ("post", "/api/agenda/tasks", {"json": {"title": "复习", "scheduled_date": "2026-02-30"}}, "计划日期"),
    ("post", "/api/agenda/tasks/batch", {"json": {"children": [{"title": "复习", "duration_minutes": -5}]}}, "预计时长"),
])
def test_invalid_input_has_one_readable_chinese_detail(client, method, path, arguments, label):
    response = getattr(client, method)(path, **arguments)
    assert response.status_code == 422
    detail = response.json()["detail"]
    assert isinstance(detail, str) and label in detail
    assert "Input should" not in detail and "String should" not in detail
    assert "Traceback" not in response.text


@pytest.mark.parametrize("query", ["   ", "\t\n", "\u3000\u3000"])
def test_whitespace_search_is_rejected_after_trimming(client, query):
    response = client.get("/api/materials/search", params={"q": query})
    assert response.status_code == 422
    assert response.json()["detail"] == "搜索内容不能为空。"


def test_search_still_trims_valid_queries(client):
    client.post("/api/materials", files={"file": ("notes.txt", "栈遵循后进先出。".encode(), "text/plain")}).raise_for_status()
    plain = client.get("/api/materials/search", params={"q": "后进先出"})
    padded = client.get("/api/materials/search", params={"q": "  后进先出  "})
    assert plain.status_code == padded.status_code == 200
    assert plain.json() and padded.json() == plain.json()


@pytest.mark.parametrize("deadline", ["2026-13-40", "2026-02-29", "2026-04-31", "0000-01-01"])
def test_invalid_calendar_dates_never_create_a_space(client, deadline):
    response = client.post("/api/subjects", json={"name": "日期测试", "deadline": deadline})
    assert response.status_code == 422
    assert "截止日期" in response.json()["detail"]
    assert client.get("/api/subjects").json() == []


def test_bad_date_patch_is_atomic_and_valid_dates_can_be_cleared(client):
    created = client.post("/api/subjects", json={"name": "原名称", "deadline": "2028-02-29"})
    assert created.status_code == 201 and created.json()["deadline"] == "2028-02-29"
    path = "/api/subjects/" + created.json()["id"]
    rejected = client.patch(path, json={"name": "不应保存", "deadline": "2026-02-29"})
    assert rejected.status_code == 422
    current = client.get(path).json()
    assert current["name"] == "原名称" and current["deadline"] == "2028-02-29"
    assert client.patch(path, json={"deadline": None}).json()["deadline"] is None
    assert client.post("/api/subjects", json={"name": "无截止日期"}).status_code == 201


def test_validation_feedback_does_not_echo_rejected_input(client):
    sentinel = "do-not-echo-this-value-" * 50
    response = client.post("/api/subjects", json={"name": sentinel})
    assert response.status_code == 422
    assert sentinel not in response.text and "input" not in response.json()
    malformed = client.post("/api/subjects", content='{"name": "do-not-echo-this-value-',
                            headers={"Content-Type": "application/json"})
    assert malformed.status_code == 422
    assert isinstance(malformed.json()["detail"], str)
    assert "do-not-echo-this-value-" not in malformed.text

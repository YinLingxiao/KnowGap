"""Learning plan draft acceptance: three-agent relay, rule review, confirm and boundaries.

任务单 7.1～7.8：全部使用 FakeChat 三段 JSON 顺序队列，独立 tmp_path 数据库，
接口断言与 SQLite 断言同时存在，不访问真实模型与网络。
"""

import asyncio
import json
import logging
import sqlite3
import threading
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient

from app.agenda import store as agenda_store
from app.learning import agents as learning_agents
from app.learning import service as learning_service
from app.main import create_app
from tests.test_acceptance_support import isolated_settings
from tests.test_chat import FakeChat

STUDENT = "demo-student-001"
OTHER_STUDENT = "someone-else"
TIMESTAMP = "2026-01-01T00:00:00+00:00"
EMPTY_REVIEW = {"approved": [], "rejected": [], "total_minutes": 0}
OMIT = object()
SECRET_TOPIC = "SECRET-MISCONCEPTION-原话"


def day(offset):
    return (date.today() + timedelta(days=offset)).isoformat()


def make_client(tmp_path, analyses):
    model = FakeChat(analyses=analyses)
    return TestClient(create_app(isolated_settings(tmp_path), chat_model=model)), model


def create_space(client, name="数学"):
    response = client.post("/api/subjects", json={"name": name})
    assert response.status_code == 201, response.text
    return response.json()["id"]


def seed_memory(client, memory_id, *, subject_id=None, student=STUDENT, status="open",
                kind="misconception", topic="栈与队列", summary="把栈当成先进先出", with_evidence=True):
    with client.app.state.store.connection() as db:
        db.execute(
            "INSERT INTO learner_memories(id,student_id,subject_id,kind,topic,topic_key,summary,status,"
            "confidence,origin,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,0.8,'chat',?,?)",
            (memory_id, student, subject_id, kind, topic, None, summary, status, TIMESTAMP, TIMESTAMP),
        )
        if with_evidence:
            db.execute(
                "INSERT INTO learner_memory_evidence(memory_id,quote,reason,signal,created_at) VALUES (?,?,?,?,?)",
                (memory_id, "栈就是先进先出", "把栈与队列混淆", "supports", TIMESTAMP),
            )


def seed_agenda_task(client, title="既有日程"):
    agenda_store.ensure(client.app.state.store)
    with client.app.state.store.connection() as db:
        return agenda_store.insert(db, STUDENT, {"title": title, "source": "manual"})


def diagnose_item(memory_id, *, due=OMIT, priority=OMIT, topic="模型编造主题", summary="模型编造摘要"):
    item = {"memory_id": memory_id, "topic": topic, "summary": summary}
    if due is not OMIT:
        item["due"] = due
    if priority is not OMIT:
        item["priority"] = priority
    return item


def plan_item(memory_id=OMIT, *, order=1, title="复习栈的出入顺序", evidence=OMIT,
              duration=30, scheduled=OMIT):
    item = {"title": title, "duration_minutes": duration, "order": order}
    if memory_id is not OMIT:
        item["memory_id"] = memory_id
    if evidence is OMIT and memory_id is not OMIT:
        evidence = f"memory_id={memory_id}；测验中把栈写成先进先出"
    if evidence is not OMIT:
        item["evidence"] = evidence
    item["scheduled_date"] = day(1) if scheduled is OMIT else scheduled
    return item


def queue(diagnose, plan, review=None):
    return [{"weak_points": diagnose}, {"tasks": plan}, EMPTY_REVIEW if review is None else review]


def request_draft(client, subject_id, *, budget=120, deadline_offset=5, expect=200):
    response = client.post("/api/learning/plans/draft", json={
        "subject_id": subject_id, "budget_minutes": budget, "deadline": day(deadline_offset),
    })
    assert response.status_code == expect, response.text
    return response.json()


def confirm(client, draft_id, task_ids, *, expect=200):
    response = client.post(f"/api/learning/plans/{draft_id}/confirm", json={"task_ids": task_ids})
    assert response.status_code == expect, response.text
    return response.json() if expect == 200 else response


def table_count(client, table):
    with client.app.state.store.connection() as db:
        exists = db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone()
        if not exists:
            return 0
        return db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]


def agenda_rows(client):
    with client.app.state.store.connection() as db:
        if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agenda_tasks'").fetchone():
            return []
        return [dict(row) for row in db.execute("SELECT * FROM agenda_tasks ORDER BY created_at, id")]


def draft_task_rows(client, draft_id):
    with client.app.state.store.connection() as db:
        return [dict(row) for row in db.execute(
            "SELECT * FROM learning_plan_draft_tasks WHERE draft_id=? ORDER BY task_order", (draft_id,))]


def review_output(payload):
    return payload["agents"][2]["output"]


def rejected_codes(payload):
    return [item["code"] for item in review_output(payload)["rejected"]]


def rejected_code_by_title(payload):
    planned = {task["draft_task_id"]: task for task in payload["agents"][1]["output"]["tasks"]}
    return {planned[item["draft_task_id"]]["title"]: item["code"]
            for item in review_output(payload)["rejected"]}


def boundary_logs(caplog):
    return [record.message for record in caplog.records
            if record.name == "app.learning.service" and "learning_plan agent=" in record.message]


# ---------------------------------------------------------------- 7.2 生成链路


def test_relay_order_candidate_scope_and_agent_records(tmp_path):
    analyses = queue([diagnose_item("mem-open", due=day(2), priority=2)],
                     [plan_item("mem-open")])
    client, model = make_client(tmp_path, analyses)
    with client:
        subject_id = create_space(client)
        other_space = create_space(client, "物理")
        seed_memory(client, "mem-open", subject_id=subject_id, topic=SECRET_TOPIC)
        seed_memory(client, "mem-resolved", subject_id=subject_id, status="resolved")
        seed_memory(client, "mem-mastery", subject_id=subject_id, kind="mastery")
        seed_memory(client, "mem-other-space", subject_id=other_space)
        seed_memory(client, "mem-other-student", subject_id=subject_id, student=OTHER_STUDENT)
        before = len(agenda_rows(client))
        payload = request_draft(client, subject_id)

    assert len(model.analysis_calls) == 3
    diagnose_input, plan_input, review_input = model.analysis_calls
    assert [m["memory_id"] for m in diagnose_input["memories"]] == ["mem-open"]
    assert diagnose_input["subject"] == {"subject_id": subject_id, "name": "数学"}
    assert diagnose_input["deadline"] == day(5) and diagnose_input["budget_minutes"] == 120
    # 快照证据随诊断输入提供，规划输入只含诊断选中的记忆。
    assert diagnose_input["memories"][0]["evidence"][0]["quote"] == "栈就是先进先出"
    assert [w["memory_id"] for w in plan_input["weak_points"]] == ["mem-open"]
    assert [m["memory_id"] for m in plan_input["memories"]] == ["mem-open"]
    assert "rule_result" in review_input and review_input["tasks"]

    assert [run["agent"] for run in payload["agents"]] == ["diagnose", "plan", "review"]
    for run in payload["agents"]:
        assert run["started_at"] <= run["finished_at"]
        assert run["started_at"].endswith("+00:00") or run["started_at"].endswith("Z")
    # 诊断的 topic/summary 用快照覆盖，模型编造文本不外泄。
    diagnosed = payload["agents"][0]["output"]["weak_points"][0]
    assert diagnosed["topic"] == SECRET_TOPIC and diagnosed["summary"] == "把栈当成先进先出"
    task = payload["tasks"][0]
    assert task["memory_id"] == "mem-open" and task["duration_minutes"] == 30
    assert task["evidence"].startswith("memory_id=mem-open；")
    assert len(agenda_rows(client)) == before == 0


def test_server_side_ids_due_priority_order_and_duplicate_diagnosis(tmp_path):
    diagnose = [
        diagnose_item("mem-a", due=day(3), priority=1),
        diagnose_item("mem-a", due=day(1), priority=4),  # 重复诊断只保留首项
        diagnose_item("mem-b", due=day(1), priority=4),
        diagnose_item("mem-c", priority=1),  # 无 due 置后
    ]
    planned = []
    for order, memory_id in enumerate(["mem-c", "mem-a", "mem-b"], start=1):
        item = plan_item(memory_id, order=order, title=f"复习{memory_id}")
        item["draft_task_id"] = f"forged-{memory_id}"
        item["id"] = f"forged-agenda-{memory_id}"
        planned.append(item)
    client, model = make_client(tmp_path, queue(diagnose, planned))
    with client:
        subject_id = create_space(client)
        for memory_id in ("mem-a", "mem-b", "mem-c"):
            seed_memory(client, memory_id, subject_id=subject_id)
        payload = request_draft(client, subject_id)

    assert [task["memory_id"] for task in payload["tasks"]] == ["mem-b", "mem-a", "mem-c"]
    assert [task["order"] for task in payload["tasks"]] == [1, 2, 3]
    ids = [task["draft_task_id"] for task in payload["tasks"]]
    assert len(set(ids)) == 3
    for task_id in ids:
        assert task_id.startswith("learning-task-") and "forged" not in task_id
    assert all("forged" not in json.dumps(task, ensure_ascii=False) for task in payload["tasks"])
    # 规划输出同样按服务端顺序重排，scheduled_date 不参与排序。
    assert [task["memory_id"] for task in payload["agents"][1]["output"]["tasks"]] == ["mem-b", "mem-a", "mem-c"]


def test_draft_saved_without_agenda_writes_and_confirm_after_restart(tmp_path):
    analyses = queue([diagnose_item("mem-a", due=day(1))],
                     [plan_item("mem-a", title="合格任务"),
                      plan_item("mem-a", order=2, title="时长非法任务", duration=4)])
    settings = isolated_settings(tmp_path)
    model = FakeChat(analyses=analyses)
    with TestClient(create_app(settings, chat_model=model)) as client:
        subject_id = create_space(client)
        seed_memory(client, "mem-a", subject_id=subject_id)
        existing = seed_agenda_task(client)
        before = agenda_rows(client)
        payload = request_draft(client, subject_id)
        draft_id = payload["draft_id"]

        assert [task["title"] for task in payload["tasks"]] == ["合格任务"]
        assert rejected_codes(payload) == ["invalid_duration"]
        assert agenda_rows(client) == before  # 生成不写日程，既有行完全不变
        assert table_count(client, "learning_plan_drafts") == 1
        rows = draft_task_rows(client, draft_id)
        assert [row["title"] for row in rows] == ["合格任务"]  # 被拒任务不入最终任务表
        assert rows[0]["confirmed_task_id"] is None
        with client.app.state.store.connection() as db:
            head = db.execute("SELECT * FROM learning_plan_drafts WHERE draft_id=?", (draft_id,)).fetchone()
            agents_json = json.loads(head["agents_json"])
        assert [run["agent"] for run in agents_json] == ["diagnose", "plan", "review"]
        assert head["student_id"] == STUDENT and head["budget_minutes"] == 120

    # 同一 Settings 第二个应用实例：不另建数据库文件，确认不再调用模型。
    restarted_model = FakeChat()
    with TestClient(create_app(settings, chat_model=restarted_model)) as restarted:
        created = confirm(restarted, draft_id, [payload["tasks"][0]["draft_task_id"]])
        assert restarted_model.analysis_calls == []
        assert len(created["created"]) == 1 and created["skipped"] == []
        task = created["created"][0]
        assert task["source"] == "learning_agent" and task["memory_id"] == "mem-a"
        assert task["duration_minutes"] == 30 and task["subject_id"] == subject_id
        rows = agenda_rows(restarted)
        assert len(rows) == 2
        assert rows[0]["id"] == existing["id"] and rows[0]["title"] == "既有日程"
        assert rows[1]["source"] == "learning_agent" and rows[1]["review_step"] is None


def test_empty_candidates_run_all_stages_and_confirm_empty_selection(tmp_path):
    client, model = make_client(tmp_path, queue([], []))
    with client:
        subject_id = create_space(client)
        payload = request_draft(client, subject_id)
        assert payload["tasks"] == []
        assert [run["agent"] for run in payload["agents"]] == ["diagnose", "plan", "review"]
        assert review_output(payload) == {"approved": [], "rejected": [], "total_minutes": 0}
        assert len(model.analysis_calls) == 3
        assert model.analysis_calls[0]["memories"] == []
        assert agenda_rows(client) == []
        result = confirm(client, payload["draft_id"], [])
        assert result == {"created": [], "skipped": []}


# ---------------------------------------------------------------- 7.3 规则审核


@pytest.mark.parametrize("variant", ["no_memory_id", "no_evidence", "undiagnosed_memory", "no_marker"])
def test_missing_evidence_variants_are_rejected(tmp_path, variant):
    memory_id = "mem-b" if variant == "undiagnosed_memory" else "mem-a"
    item = plan_item(memory_id)
    if variant == "no_memory_id":
        item = plan_item(evidence="memory_id=mem-a；有理由但没有记忆标识字段")
        item.pop("memory_id", None)
    elif variant == "no_evidence":
        item.pop("evidence")
    elif variant == "no_marker":
        item["evidence"] = "只有文字理由，没有完整标识标记"
    client, _model = make_client(tmp_path, queue([diagnose_item("mem-a")], [item]))
    with client:
        subject_id = create_space(client)
        seed_memory(client, "mem-a", subject_id=subject_id)
        seed_memory(client, "mem-b", subject_id=subject_id)
        payload = request_draft(client, subject_id)
        assert payload["tasks"] == []
        assert rejected_codes(payload) == ["missing_evidence"]
        assert review_output(payload)["total_minutes"] == 0
        assert draft_task_rows(client, payload["draft_id"]) == []
        assert agenda_rows(client) == []


def test_duplicate_memory_keeps_earliest_and_sums_only_kept(tmp_path):
    planned = [plan_item("mem-a", title="先复习", duration=30),
               plan_item("mem-a", order=2, title="重复复习", duration=40)]
    client, _model = make_client(tmp_path, queue([diagnose_item("mem-a")], planned))
    with client:
        subject_id = create_space(client)
        seed_memory(client, "mem-a", subject_id=subject_id)
        payload = request_draft(client, subject_id)
        assert [task["title"] for task in payload["tasks"]] == ["先复习"]
        assert rejected_code_by_title(payload) == {"重复复习": "duplicate"}
        assert review_output(payload)["total_minutes"] == 30
        assert [row["title"] for row in draft_task_rows(client, payload["draft_id"])] == ["先复习"]


@pytest.mark.parametrize("scheduled,expected", [
    (day(0), "approved"),
    (day(5), "approved"),
    (day(-1), "date_out_of_range"),
    (day(6), "date_out_of_range"),
    (None, "date_out_of_range"),
    ("2026-1-1", "date_out_of_range"),
    ("2026-02-30", "date_out_of_range"),
])
def test_scheduled_date_closed_interval_and_invalid_values(tmp_path, scheduled, expected):
    item = plan_item("mem-a", scheduled=scheduled)
    if scheduled is None:
        item.pop("scheduled_date")
    client, _model = make_client(tmp_path, queue([diagnose_item("mem-a")], [item]))
    with client:
        subject_id = create_space(client)
        seed_memory(client, "mem-a", subject_id=subject_id)
        payload = request_draft(client, subject_id)
        if expected == "approved":
            assert [task["scheduled_date"] for task in payload["tasks"]] == [scheduled]
            assert rejected_codes(payload) == []
        else:
            assert payload["tasks"] == [] and rejected_codes(payload) == [expected]
            # 越界不自动裁剪：规划候选保留模型原始日期供拒绝解释。
            assert payload["agents"][1]["output"]["tasks"][0]["scheduled_date"] == scheduled


def test_budget_truncates_longest_prefix_without_backfilling(tmp_path):
    planned = [plan_item("mem-a", title="八十分钟", duration=80),
               plan_item("mem-b", order=2, title="五十分钟", duration=50),
               plan_item("mem-c", order=3, title="十分钟", duration=10)]
    client, _model = make_client(tmp_path, queue(
        [diagnose_item("mem-a"), diagnose_item("mem-b"), diagnose_item("mem-c")], planned))
    with client:
        subject_id = create_space(client)
        for memory_id in ("mem-a", "mem-b", "mem-c"):
            seed_memory(client, memory_id, subject_id=subject_id)
        payload = request_draft(client, subject_id, budget=120)
        assert [task["title"] for task in payload["tasks"]] == ["八十分钟"]
        assert rejected_code_by_title(payload) == {"五十分钟": "over_budget", "十分钟": "over_budget"}
        assert review_output(payload)["total_minutes"] == 80
        assert [row["title"] for row in draft_task_rows(client, payload["draft_id"])] == ["八十分钟"]


def test_budget_exact_120_and_request_budget_cap(tmp_path):
    planned = [plan_item("mem-a", title="第一段", duration=60),
               plan_item("mem-b", order=2, title="第二段", duration=60)]
    client, _model = make_client(tmp_path, queue(
        [diagnose_item("mem-a"), diagnose_item("mem-b")], planned))
    with client:
        subject_id = create_space(client)
        seed_memory(client, "mem-a", subject_id=subject_id)
        seed_memory(client, "mem-b", subject_id=subject_id)
        payload = request_draft(client, subject_id, budget=120)
        assert len(payload["tasks"]) == 2
        assert review_output(payload)["total_minutes"] == 120 == sum(
            task["duration_minutes"] for task in payload["tasks"])
        assert rejected_codes(payload) == []


@pytest.mark.parametrize("field,value,expected", [
    ("title", "", "invalid_task"),
    ("title", "x" * 201, "invalid_task"),
    ("duration_minutes", 4, "invalid_duration"),
    ("duration_minutes", 121, "invalid_duration"),
    ("duration_minutes", True, "invalid_duration"),
    ("duration_minutes", "30", "invalid_duration"),
    ("duration_minutes", 10.5, "invalid_duration"),
])
def test_invalid_task_fields_are_rejected(tmp_path, field, value, expected):
    item = plan_item("mem-a")
    item[field] = value
    client, _model = make_client(tmp_path, queue([diagnose_item("mem-a")], [item]))
    with client:
        subject_id = create_space(client)
        seed_memory(client, "mem-a", subject_id=subject_id)
        payload = request_draft(client, subject_id)
        assert payload["tasks"] == [] and rejected_codes(payload) == [expected]
        assert review_output(payload)["total_minutes"] == 0


def test_invalid_duration_does_not_join_total(tmp_path):
    planned = [plan_item("mem-a", title="有效", duration=30),
               plan_item("mem-b", order=2, title="字符串时长", duration="30")]
    client, _model = make_client(tmp_path, queue(
        [diagnose_item("mem-a"), diagnose_item("mem-b")], planned))
    with client:
        subject_id = create_space(client)
        seed_memory(client, "mem-a", subject_id=subject_id)
        seed_memory(client, "mem-b", subject_id=subject_id)
        payload = request_draft(client, subject_id)
        assert review_output(payload)["total_minutes"] == 30
        assert rejected_code_by_title(payload) == {"字符串时长": "invalid_duration"}


# ---------------------------------------------------------------- 7.4 规则优先与降级


class ReviewScriptChat(FakeChat):
    """前两段走顺序队列，第三段根据真实服务端 draft_task_id 动态生成审核输出。"""

    def __init__(self, analyses, review_factory):
        super().__init__(analyses=analyses)
        self.review_factory = review_factory

    async def complete_json(self, messages):
        payload = json.loads(messages[-1]["content"])
        self.analysis_calls.append(payload)
        if len(self.analysis_calls) < 3:
            result = self.analyses.pop(0)
            if isinstance(result, Exception):
                raise result
            return result
        return self.review_factory(payload)


@pytest.mark.parametrize("mode", ["approve_rule_rejected", "extra_rejection"])
def test_rule_review_has_priority_over_model(tmp_path, mode, caplog):
    caplog.set_level(logging.INFO, logger="app.learning.service")
    planned = [plan_item("mem-a", title="合格任务", duration=30),
               plan_item("mem-b", order=2, title="规则拒绝任务", duration=4)]

    def review_factory(payload):
        ids = {task["title"]: task["draft_task_id"] for task in payload["tasks"]}
        if mode == "approve_rule_rejected":
            # 模型试图批准规则已拒绝的候选；total_minutes 与自身声明一致，不触发降级。
            return {"approved": [ids["合格任务"], ids["规则拒绝任务"]], "rejected": [], "total_minutes": 34}
        return {"approved": [], "total_minutes": 0, "rejected": [
            {"draft_task_id": ids["合格任务"], "code": "model_concern", "message": "模型补充：依据过于笼统"}]}

    model = ReviewScriptChat([{"weak_points": [diagnose_item("mem-a"), diagnose_item("mem-b")]},
                              {"tasks": planned}], review_factory)
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=model)) as client:
        subject_id = create_space(client)
        seed_memory(client, "mem-a", subject_id=subject_id)
        seed_memory(client, "mem-b", subject_id=subject_id)
        payload = request_draft(client, subject_id)

    codes = rejected_code_by_title(payload)
    if mode == "approve_rule_rejected":
        assert [task["title"] for task in payload["tasks"]] == ["合格任务"]
        assert codes == {"规则拒绝任务": "invalid_duration"}  # 规则原因不可删除或覆盖
        assert review_output(payload)["total_minutes"] == 30
    else:
        assert payload["tasks"] == []
        assert codes == {"合格任务": "model_concern", "规则拒绝任务": "invalid_duration"}
        assert review_output(payload) == {"approved": [], "rejected": review_output(payload)["rejected"],
                                          "total_minutes": 0}
    # review.output、最终 tasks、total_minutes 三者一致。
    assert review_output(payload)["approved"] == [task["draft_task_id"] for task in payload["tasks"]]
    assert review_output(payload)["total_minutes"] == sum(task["duration_minutes"] for task in payload["tasks"])
    assert not any("status=rule_fallback" in message for message in boundary_logs(caplog))


@pytest.mark.parametrize("third", [
    RuntimeError("review exploded"),
    ["not-a-dict"],
    {"approved": []},
    {"approved": ["ghost-task"], "rejected": [], "total_minutes": 0},
], ids=["exception", "invalid_root", "missing_fields", "unknown_task_id"])
def test_review_failures_fall_back_to_rule_result(tmp_path, third, caplog):
    caplog.set_level(logging.INFO, logger="app.learning.service")
    client, model = make_client(tmp_path, queue([diagnose_item("mem-a")], [plan_item("mem-a")], third))
    with client:
        subject_id = create_space(client)
        seed_memory(client, "mem-a", subject_id=subject_id)
        payload = request_draft(client, subject_id)  # 审核失败不返回 503
        assert len(model.analysis_calls) == 3
        assert [task["memory_id"] for task in payload["tasks"]] == ["mem-a"]
        assert review_output(payload)["total_minutes"] == 30
        assert rejected_codes(payload) == []
        assert any("agent=review event=end status=rule_fallback" in message
                   for message in boundary_logs(caplog))
        created = confirm(client, payload["draft_id"], [payload["tasks"][0]["draft_task_id"]])
        assert len(created["created"]) == 1
        assert agenda_rows(client)[0]["source"] == "learning_agent"


def test_review_timeout_falls_back_without_extra_model_calls(tmp_path, monkeypatch, caplog):
    caplog.set_level(logging.INFO, logger="app.learning.service")

    class SlowReviewChat(FakeChat):
        async def complete_json(self, messages):
            payload = json.loads(messages[-1]["content"])
            self.analysis_calls.append(payload)
            if len(self.analysis_calls) == 3:
                await asyncio.sleep(0.5)
            result = self.analyses.pop(0) if self.analyses else {}
            if isinstance(result, Exception):
                raise result
            return result

    monkeypatch.setattr(learning_agents, "MODEL_TIMEOUT_SECONDS", 0.01)
    model = SlowReviewChat(analyses=queue([diagnose_item("mem-a")], [plan_item("mem-a")]))
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=model)) as client:
        subject_id = create_space(client)
        seed_memory(client, "mem-a", subject_id=subject_id)
        payload = request_draft(client, subject_id)
        assert len(model.analysis_calls) == 3  # 不重试、没有第四次调用
        assert review_output(payload)["total_minutes"] == 30
        fallback_logs = [message for message in boundary_logs(caplog)
                         if "agent=review event=end status=rule_fallback" in message]
        # 日志字段顺序为 agent/event/status/draft_id/error_type，draft_id 夹在中间。
        assert len(fallback_logs) == 1 and "error_type=TimeoutError" in fallback_logs[0]


@pytest.mark.parametrize("stage,bad_response,calls", [
    ("diagnose", RuntimeError("diagnose down"), 1),
    ("diagnose", {"nope": 1}, 1),
    ("plan", RuntimeError("plan down"), 2),
    ("plan", {"tasks": "broken"}, 2),
], ids=["diagnose_exception", "diagnose_invalid", "plan_exception", "plan_invalid"])
def test_diagnose_and_plan_failures_return_503_without_partial_state(
        tmp_path, stage, bad_response, calls, caplog):
    caplog.set_level(logging.INFO, logger="app.learning.service")
    analyses = [{"weak_points": [diagnose_item("mem-a")]}, {"tasks": [plan_item("mem-a")]}, EMPTY_REVIEW]
    analyses[0 if stage == "diagnose" else 1] = bad_response
    client, model = make_client(tmp_path, analyses)
    with client:
        subject_id = create_space(client)
        seed_memory(client, "mem-a", subject_id=subject_id)
        response = client.post("/api/learning/plans/draft", json={
            "subject_id": subject_id, "budget_minutes": 120, "deadline": day(5)})
        assert response.status_code == 503, response.text
        assert len(model.analysis_calls) == calls
        assert agenda_rows(client) == []
        assert table_count(client, "learning_plan_drafts") == 0
        logs = boundary_logs(caplog)
        started = [message for message in logs if "event=start" in message]
        assert len(started) == calls
        assert f"agent={stage} event=end status=failed" in logs[-1]
        # 未启动的阶段不产生任何伪造日志。
        for name in ({"diagnose", "plan", "review"} - ({"diagnose"} if stage == "diagnose" else {"diagnose", "plan"})):
            assert not any(f"agent={name} " in message for message in logs)


# ---------------------------------------------------------------- 7.5 确认、隔离与原子性


def two_task_client(tmp_path):
    planned = [plan_item("mem-a", title="任务A", duration=30),
               plan_item("mem-b", order=2, title="任务B", duration=45)]
    client, model = make_client(tmp_path, queue(
        [diagnose_item("mem-a"), diagnose_item("mem-b")], planned))
    return client, model


def prepare_two_tasks(client):
    subject_id = create_space(client)
    seed_memory(client, "mem-a", subject_id=subject_id)
    seed_memory(client, "mem-b", subject_id=subject_id)
    payload = request_draft(client, subject_id)
    assert [task["title"] for task in payload["tasks"]] == ["任务A", "任务B"]
    return subject_id, payload


def test_confirm_selected_subset_uses_server_snapshot_and_skips_model(tmp_path):
    client, model = two_task_client(tmp_path)
    with client:
        subject_id, payload = prepare_two_tasks(client)
        task_a, task_b = payload["tasks"]
        review_before = json.dumps(review_output(payload), ensure_ascii=False, sort_keys=True)
        calls_before = len(model.analysis_calls)
        # 逆序选择：created 仍按草稿 order 返回，未选中项不出现在 skipped。
        result = confirm(client, payload["draft_id"], [task_b["draft_task_id"], task_a["draft_task_id"]])
        assert [task["title"] for task in result["created"]] == ["任务A", "任务B"]
        assert result["skipped"] == []
        assert len(model.analysis_calls) == calls_before  # 确认不调用模型
        rows = agenda_rows(client)
        assert len(rows) == 2
        for created_task, source in zip(result["created"], (task_a, task_b)):
            row = next(item for item in rows if item["id"] == created_task["id"])
            assert row["title"] == source["title"] == created_task["title"]
            assert row["notes"] == source["evidence"]
            assert row["memory_id"] == source["memory_id"]
            assert row["duration_minutes"] == source["duration_minutes"]
            assert row["scheduled_date"] == source["scheduled_date"]
            assert row["subject_id"] == subject_id
            assert row["source"] == "learning_agent" and row["review_step"] is None

        with client.app.state.store.connection() as db:
            head = db.execute("SELECT agents_json FROM learning_plan_drafts WHERE draft_id=?",
                              (payload["draft_id"],)).fetchone()
            stored_review = json.loads(head["agents_json"])[2]["output"]
        assert json.dumps(stored_review, ensure_ascii=False, sort_keys=True) == review_before
        # 重复确认：不重复创建，标记 already_confirmed。
        again = confirm(client, payload["draft_id"], [task_a["draft_task_id"]])
        assert again["created"] == []
        assert again["skipped"] == [{"draft_task_id": task_a["draft_task_id"],
                                     "code": "already_confirmed", "message": "该任务已经写入日程"}]
        assert len(agenda_rows(client)) == 2


def test_confirm_empty_duplicate_and_invalid_selection(tmp_path):
    client, _model = two_task_client(tmp_path)
    with client:
        _subject_id, payload = prepare_two_tasks(client)
        task_a, task_b = payload["tasks"]
        assert confirm(client, payload["draft_id"], []) == {"created": [], "skipped": []}
        duplicated = confirm(client, payload["draft_id"], [task_a["draft_task_id"], task_a["draft_task_id"]])
        assert len(duplicated["created"]) == 1 and duplicated["skipped"] == []
        unknown = confirm(client, payload["draft_id"], ["ghost-task"])
        assert unknown["created"] == []
        assert unknown["skipped"][0]["code"] == "not_approved"
        assert unknown["skipped"][0]["draft_task_id"] == "ghost-task"
        # 未选中的任务B不出现在 skipped，也不写入日程。
        assert task_b["draft_task_id"] not in json.dumps(unknown)
        assert len(agenda_rows(client)) == 1


@pytest.mark.parametrize("extra", [
    {"title": "篡改标题"}, {"duration_minutes": 5}, {"scheduled_date": day(0)},
    {"evidence": "篡改依据"}, {"source": "manual"}, {"memory_id": "mem-b"}, {"notes": "篡改备注"},
])
def test_confirm_rejects_client_field_overrides(tmp_path, extra):
    client, _model = two_task_client(tmp_path)
    with client:
        _subject_id, payload = prepare_two_tasks(client)
        task_id = payload["tasks"][0]["draft_task_id"]
        response = client.post(f"/api/learning/plans/{payload['draft_id']}/confirm",
                               json={"task_ids": [task_id], **extra})
        assert response.status_code == 422, response.text
        assert agenda_rows(client) == []
        assert draft_task_rows(client, payload["draft_id"])[0]["confirmed_task_id"] is None


def test_confirm_missing_or_foreign_draft_returns_404(tmp_path):
    client, _model = two_task_client(tmp_path)
    with client:
        _subject_id, payload = prepare_two_tasks(client)
        task_id = payload["tasks"][0]["draft_task_id"]
        missing = confirm(client, "learning-draft-missing", [task_id], expect=404)
        assert "复习计划草稿不存在" in missing.json()["detail"]
        # 把草稿归属改成他人：同一接口返回 404，不泄露归属、不写日程。
        with client.app.state.store.connection() as db:
            db.execute("UPDATE learning_plan_drafts SET student_id=? WHERE draft_id=?",
                       (OTHER_STUDENT, payload["draft_id"]))
        foreign = confirm(client, payload["draft_id"], [task_id], expect=404)
        assert foreign.json()["detail"] == "复习计划草稿不存在"
        assert agenda_rows(client) == []


def test_concurrent_confirm_creates_at_most_one_agenda_task(tmp_path):
    client, _model = two_task_client(tmp_path)
    with client:
        _subject_id, payload = prepare_two_tasks(client)
        task_id = payload["tasks"][0]["draft_task_id"]
        workers = 4
        barrier = threading.Barrier(workers)

        def race():
            barrier.wait(timeout=15)
            response = client.post(f"/api/learning/plans/{payload['draft_id']}/confirm",
                                   json={"task_ids": [task_id]})
            assert response.status_code == 200, response.text
            return response.json()

        with ThreadPoolExecutor(max_workers=workers) as pool:
            results = list(pool.map(lambda _: race(), range(workers)))
        created = [task for result in results for task in result["created"]]
        assert len(created) == 1
        skipped = [item for result in results for item in result["skipped"]]
        assert len(skipped) == workers - 1
        assert all(item["code"] == "already_confirmed" for item in skipped)
        assert len(agenda_rows(client)) == 1


def test_confirm_rolls_back_everything_when_second_insert_fails(tmp_path, monkeypatch):
    client, _model = two_task_client(tmp_path)
    with client:
        _subject_id, payload = prepare_two_tasks(client)
        ids = [task["draft_task_id"] for task in payload["tasks"]]
        original = agenda_store.insert
        calls = {"count": 0}

        def failing_insert(db, student, data):
            calls["count"] += 1
            if calls["count"] == 2:
                raise sqlite3.OperationalError("disk I/O error")
            return original(db, student, data)

        monkeypatch.setattr(agenda_store, "insert", failing_insert)
        response = client.post(f"/api/learning/plans/{payload['draft_id']}/confirm", json={"task_ids": ids})
        assert response.status_code == 503, response.text
        assert calls["count"] == 2
        assert agenda_rows(client) == []  # 第一条插入同样回滚
        assert all(row["confirmed_task_id"] is None for row in draft_task_rows(client, payload["draft_id"]))


# ---------------------------------------------------------------- 7.6 连接边界与阶段日志


def test_no_connection_open_during_model_calls_and_exactly_six_logs(tmp_path, caplog):
    caplog.set_level(logging.INFO, logger="app.learning.service")
    observations = []

    class ConnectionTrackingChat(FakeChat):
        async def complete_json(self, messages):
            observations.append(tracker.active)
            return await super().complete_json(messages)

    model = ConnectionTrackingChat(analyses=queue([diagnose_item("mem-a")], [plan_item("mem-a")]))
    app = create_app(isolated_settings(tmp_path), chat_model=model)
    store = app.state.store
    original_connection = store.connection

    class Tracker:
        def __init__(self):
            self.active = 0
            self.max_active = 0

        @contextmanager
        def connection(self):
            self.active += 1
            self.max_active = max(self.max_active, self.active)
            try:
                with original_connection() as db:
                    yield db
            finally:
                self.active -= 1

    tracker = Tracker()
    with TestClient(app) as client:
        store.connection = tracker.connection
        try:
            subject_id = create_space(client)
            seed_memory(client, "mem-a", subject_id=subject_id, topic=SECRET_TOPIC)
            payload = request_draft(client, subject_id)
            assert payload["tasks"]
            assert tracker.active == 0  # 草稿保存连接已关闭
        finally:
            store.connection = original_connection

    assert observations == [0, 0, 0]  # 三次模型入口均不持有连接或事务
    logs = boundary_logs(caplog)
    assert len(logs) == 6
    expected = [(agent, event) for agent in ("diagnose", "plan", "review") for event in ("start", "end")]
    assert [(message.split("agent=")[1].split(" ")[0], message.split("event=")[1].split(" ")[0])
            for message in logs] == expected
    assert all(f"draft_id={payload['draft_id']}" in message for message in logs)
    assert "status=running" in logs[0] and "status=success" in logs[-1]
    assert SECRET_TOPIC not in caplog.text  # 日志不含误区原话


# ---------------------------------------------------------------- 7.7 框架校验与空间归属


@pytest.mark.parametrize("override", [
    {"subject_id": ""},
    {"deadline": day(-1)},
    {"deadline": "2026-02-30"},
    {"deadline": "not-a-date"},
    {"budget_minutes": 0},
    {"budget_minutes": 121},
    {"budget_minutes": True},
    {"budget_minutes": "30"},
    {"budget_minutes": 10.5},
    {"unexpected": 1},
], ids=["empty_subject", "past_deadline", "invalid_calendar_day", "bad_date_format", "budget_zero",
        "budget_121", "budget_bool", "budget_str", "budget_float", "extra_field"])
def test_invalid_draft_requests_are_422_without_model_or_writes(tmp_path, override):
    client, model = make_client(tmp_path, queue([diagnose_item("mem-a")], [plan_item("mem-a")]))
    with client:
        subject_id = create_space(client)
        seed_memory(client, "mem-a", subject_id=subject_id)
        body = {"subject_id": subject_id, "budget_minutes": 120, "deadline": day(5), **override}
        response = client.post("/api/learning/plans/draft", json=body)
        assert response.status_code == 422, response.text
        assert model.analysis_calls == []
        assert table_count(client, "learning_plan_drafts") == 0
        assert agenda_rows(client) == []


def test_foreign_or_unknown_subject_is_422_without_leaking_memories(tmp_path):
    client, model = make_client(tmp_path, queue([diagnose_item("mem-a")], [plan_item("mem-a")]))
    with client:
        foreign_space = client.app.state.chat_service.store.create_subject(
            OTHER_STUDENT, "他人空间", "", "")
        seed_memory(client, "mem-foreign", subject_id=foreign_space.id,
                    student=OTHER_STUDENT, topic=SECRET_TOPIC)
        for subject_id in (foreign_space.id, "subj-missing"):
            response = client.post("/api/learning/plans/draft", json={
                "subject_id": subject_id, "budget_minutes": 120, "deadline": day(5)})
            assert response.status_code == 422, response.text
            assert response.json()["detail"] == "subject_id 不属于当前学生"
            assert SECRET_TOPIC not in response.text
        assert model.analysis_calls == []
        assert table_count(client, "learning_plan_drafts") == 0


# ---------------------------------------------------------------- 7.8 初始化幂等


def test_ensure_is_idempotent_across_restart_and_preserves_existing_data(tmp_path):
    settings = isolated_settings(tmp_path)
    model = FakeChat(analyses=queue([diagnose_item("mem-a")], [plan_item("mem-a")]))
    with TestClient(create_app(settings, chat_model=model)) as client:
        subject_id = create_space(client)
        seed_memory(client, "mem-a", subject_id=subject_id, topic=SECRET_TOPIC)
        existing = seed_agenda_task(client)
        payload = request_draft(client, subject_id)
        store = client.app.state.store
        learning_service.ensure(store)
        learning_service.ensure(store)  # 连续两次 ensure 无重复建表错误
        with store.connection() as db:
            memory_before = dict(db.execute("SELECT * FROM learner_memories WHERE id='mem-a'").fetchone())
            agenda_before = [dict(row) for row in db.execute("SELECT * FROM agenda_tasks")]
        assert [row["id"] for row in agenda_before] == [existing["id"]]
        assert memory_before["topic"] == SECRET_TOPIC and memory_before["status"] == "open"

    with TestClient(create_app(settings, chat_model=FakeChat())) as restarted:
        store = restarted.app.state.store
        learning_service.ensure(store)
        with store.connection() as db:
            memory_after = dict(db.execute("SELECT * FROM learner_memories WHERE id='mem-a'").fetchone())
            agenda_after = [dict(row) for row in db.execute("SELECT * FROM agenda_tasks")]
            head = db.execute("SELECT draft_id FROM learning_plan_drafts").fetchone()
            tasks = db.execute("SELECT COUNT(*) FROM learning_plan_draft_tasks").fetchone()[0]
        assert memory_after == memory_before  # 学习初始化不修改既有记忆与日程
        assert agenda_after == agenda_before
        assert head["draft_id"] == payload["draft_id"] and tasks == 1
        created = confirm(restarted, payload["draft_id"], [payload["tasks"][0]["draft_task_id"]])
        assert len(created["created"]) == 1
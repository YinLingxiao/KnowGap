"""micro_quiz 封存、判分接口、幂等与重新生成后的保留。"""

import json

from fastapi.testclient import TestClient

from app.chat.quizzes import seal_quizzes
from app.chat.store import ChatStore
from app.main import create_app
from tests.test_acceptance_support import isolated_settings
from tests.test_auth_and_isolation import auth_headers
from tests.test_chat import FakeChat

QUIZ = {"type": "micro_quiz", "question": "栈的出栈顺序？", "options": ["先进先出", "后进先出", "随机"],
        "answerIndex": 1, "explanation": "栈是后进先出。", "meta": {"source": "own"}}


def block(widget) -> str:
    return "```knowgap-widget\n" + json.dumps(widget, ensure_ascii=False) + "\n```"


def widgets(text: str) -> list[dict]:
    from app.chat.skills.problem_drill_skill import WIDGET_RE
    return [json.loads(m.group(1)) for m in WIDGET_RE.finditer(text)]


def register(client, email):
    code = client.post("/api/auth/send-code", json={"email": email, "purpose": "register"}).json()["demo_code"]
    token = client.post("/api/auth/register", json={
        "email": email, "password": "password123", "code": code, "display_name": email.split("@")[0],
    }).json()["token"]
    return auth_headers(token)


def setup(client):
    """Alice 的会话里有一条助手回复，含两道题和一个坏块。"""
    alice = register(client, "alice@school.edu")
    conversation = client.post("/api/conversations", headers=alice, json={"title": "栈"}).json()["id"]
    store = ChatStore(client.app.state.store)
    user = store.add_user_message(conversation, "出题", "req-quiz-001")
    reply = store.start_reply(conversation, user, [])
    second = {**QUIZ, "question": "第二题", "answerIndex": 0}
    text = f"先看题：\n{block(QUIZ)}\n坏块：\n```knowgap-widget\n{{oops\n```\n再来：\n{block(second)}\n"
    sealed = seal_quizzes(text, reply, conversation, store)
    store.finish_reply(reply, content=sealed, status="complete")
    return alice, conversation, store, user, reply, sealed


def attempt(client, headers, quiz_id, action_id, option):
    return client.post(f"/api/quizzes/{quiz_id}/attempts", headers=headers,
                       json={"action_id": action_id, "option_index": option})


def test_seal_hides_answers_and_assigns_ids(tmp_path):
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=FakeChat([]))) as client:
        _, _, _, _, reply, sealed = setup(client)
    assert "answerIndex" not in sealed and "栈是后进先出" not in sealed
    assert "{oops" in sealed  # 解析不了的块原样保留
    quizzes = [w for w in widgets(sealed.replace("{oops", '{"type": "text"}')) if w["type"] == "micro_quiz"]
    assert [q["quizId"] for q in quizzes] == [f"{reply}:0", f"{reply}:1"]
    assert quizzes[0]["meta"] == {"source": "own"} and quizzes[0]["options"] == QUIZ["options"]


def test_old_and_invalid_quizzes_are_left_alone(tmp_path):
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=FakeChat([]))) as client:
        _, conversation, store, *_ = setup(client)
        bad = block({**QUIZ, "answerIndex": 9})
        assert seal_quizzes(bad, "m1", conversation, store) == bad
        assert seal_quizzes("没有题", "m1", conversation, store) == "没有题"


def test_attempt_grading_idempotency_and_first_attempt_only(tmp_path):
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=FakeChat([]))) as client:
        alice, conversation, _, _, reply, _ = setup(client)
        quiz_id = f"{reply}:0"
        first = attempt(client, alice, quiz_id, "act-1", 0)
        assert first.status_code == 200
        body = first.json()
        assert body["correct"] is False and body["answer_index"] == 1 and body["explanation"] == "栈是后进先出。"
        assert body["quiz_id"] == quiz_id and body["option_index"] == 0 and "repeated" not in body
        assert attempt(client, alice, quiz_id, "act-1", 0).json() == body  # 同 payload 重发
        assert attempt(client, alice, quiz_id, "act-1", 1).status_code == 409
        again = attempt(client, alice, quiz_id, "act-2", 1).json()
        assert again["repeated"] is True and again["attempt_id"] == body["attempt_id"] and again["correct"] is False
        right = attempt(client, alice, f"{reply}:1", "act-3", 0).json()
        assert right["correct"] is True
        listed = client.get(f"/api/conversations/{conversation}/quiz-attempts", headers=alice).json()
        assert set(listed) == {quiz_id, f"{reply}:1"} and listed[quiz_id] == body


def test_out_of_range_missing_and_foreign_quiz(tmp_path):
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=FakeChat([]))) as client:
        alice, conversation, _, _, reply, _ = setup(client)
        bob = register(client, "bob@school.edu")
        quiz_id = f"{reply}:0"
        assert attempt(client, alice, quiz_id, "act-1", 3).status_code == 422
        assert attempt(client, alice, quiz_id, "act-1", -1).status_code == 422
        assert attempt(client, alice, "nope:0", "act-1", 0).status_code == 404
        assert attempt(client, bob, quiz_id, "act-b", 0).status_code == 404
        assert client.get(f"/api/conversations/{conversation}/quiz-attempts", headers=bob).status_code == 404
        assert client.get(f"/api/conversations/{conversation}/quiz-attempts", headers=alice).json() == {}


def test_regenerate_keeps_attempts_and_marks_quiz_superseded(tmp_path):
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=FakeChat([]))) as client:
        alice, conversation, store, user, reply, _ = setup(client)
        quiz_id = f"{reply}:0"
        attempt(client, alice, quiz_id, "act-1", 1)
        store.start_reply(conversation, user, [reply])
        with store.connection() as db:
            assert db.execute("SELECT COUNT(*) FROM conversation_messages WHERE id = ?", (reply,)).fetchone()[0] == 0
            rows = db.execute("SELECT quiz_id, superseded FROM quiz_items ORDER BY quiz_id").fetchall()
        assert [(r["quiz_id"], r["superseded"]) for r in rows] == [(quiz_id, 1), (f"{reply}:1", 1)]
        restored = client.get(f"/api/conversations/{conversation}/quiz-attempts", headers=alice).json()
        assert restored[quiz_id]["correct"] is True
        assert attempt(client, alice, quiz_id, "act-1", 1).json()["attempt_id"] == restored[quiz_id]["attempt_id"]


# ------------------------------------------------------------------ 作答证据、计划推进、缺口卡

def student_of(store, conversation):
    with store.connection() as db:
        return db.execute("SELECT student_id FROM conversations WHERE id = ?", (conversation,)).fetchone()[0]


def misconception(store, student, conversation, message, topic="栈顺序"):
    change = store.record_observation(
        student, kind="misconception", topic=topic, topic_key=None, summary="以为栈先进先出", quote="栈是先进先出",
        reason="口述", signal="supports", related_id=None, conversation_id=conversation, message_id=message)
    return change.memory.id


def drill_reply(store, conversation, user, widget):
    reply = store.start_reply(conversation, user, [])
    sealed = seal_quizzes(block(widget), reply, conversation, store)
    store.finish_reply(reply, content=sealed, status="complete")
    return reply, sealed


def evidence(store, memory_id):
    with store.connection() as db:
        return db.execute("SELECT * FROM learner_memory_evidence WHERE memory_id = ? ORDER BY id", (memory_id,)).fetchall()


def test_wrong_answer_records_supporting_evidence_once(tmp_path):
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=FakeChat([]))) as client:
        alice, conversation, store, user, *_ = setup(client)
        student = student_of(store, conversation)
        mid = misconception(store, student, conversation, user)
        other = misconception(store, student, conversation, user, topic="队列")
        reply, _ = drill_reply(store, conversation, user, {**QUIZ, "meta": {
            "target_misconceptions": [mid], "option_misconceptions": [mid, None, other]}})
        wrong = attempt(client, alice, f"{reply}:0", "w-1", 0).json()
        assert len(wrong["memory_changes"]) == 1 and wrong["memory_changes"][0]["memory"]["id"] == mid
        assert wrong["memory_changes"][0]["action"] == "updated" and wrong["plan_step"] is None
        rows = evidence(store, mid)
        assert [r["signal"] for r in rows] == ["supports", "supports"]
        assert rows[1]["source"] == "quiz_attempt" and rows[1]["attempt_id"] == wrong["attempt_id"]
        assert rows[1]["message_id"] is None and rows[1]["quote"] == "题目：栈的出栈顺序？｜所选：先进先出"
        assert rows[0]["source"] == "message_quote"
        with store.connection() as db:
            wire = store._memories(db, student, mid)[0].evidence
        assert [e.source for e in wire] == ["message_quote", "quiz_attempt"]
        # 重放、repeated、GET 都不再产生证据或变化
        assert attempt(client, alice, f"{reply}:0", "w-1", 0).json()["memory_changes"] == []
        assert attempt(client, alice, f"{reply}:0", "w-2", 1).json()["memory_changes"] == []
        listed = client.get(f"/api/conversations/{conversation}/quiz-attempts", headers=alice).json()
        assert listed[f"{reply}:0"]["memory_changes"] == [] and listed[f"{reply}:0"]["plan_step"] is None
        assert len(evidence(store, mid)) == 2 and len(evidence(store, other)) == 1


def test_correct_answer_contradicts_targets(tmp_path):
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=FakeChat([]))) as client:
        alice, conversation, store, user, *_ = setup(client)
        mid = misconception(store, student_of(store, conversation), conversation, user)
        reply, _ = drill_reply(store, conversation, user, {**QUIZ, "meta": {"target_misconceptions": [mid]}})
        done = attempt(client, alice, f"{reply}:0", "c-1", 1).json()
        assert done["correct"] is True and done["memory_changes"][0]["memory"]["id"] == mid
        assert [r["signal"] for r in evidence(store, mid)] == ["supports", "contradicts"]


def test_corrected_and_foreign_misconceptions_are_skipped(tmp_path):
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=FakeChat([]))) as client:
        alice, conversation, store, user, *_ = setup(client)
        bob = register(client, "bob@school.edu")
        bob_conv = client.post("/api/conversations", headers=bob, json={"title": "b"}).json()["id"]
        bob_user = store.add_user_message(bob_conv, "hi", "req-bob-001")
        foreign = misconception(store, student_of(store, bob_conv), bob_conv, bob_user)
        mine = misconception(store, student_of(store, conversation), conversation, user)
        with store.connection() as db:
            db.execute("UPDATE learner_memories SET user_corrected = 1 WHERE id = ?", (mine,))
        reply, _ = drill_reply(store, conversation, user, {**QUIZ, "meta": {
            "target_misconceptions": [mine, foreign], "option_misconceptions": [foreign, None, None]}})
        wrong = attempt(client, alice, f"{reply}:0", "s-1", 0).json()
        assert wrong["memory_changes"] == [] and len(evidence(store, foreign)) == 1
        reply2, _ = drill_reply(store, conversation, user, {**QUIZ, "meta": {"target_misconceptions": [mine, foreign]}})
        right = attempt(client, alice, f"{reply2}:0", "s-2", 1).json()
        assert right["memory_changes"] == [] and len(evidence(store, mine)) == 1 and len(evidence(store, foreign)) == 1


def plan_with(store, conversation, student, status="awaiting_learner"):
    from app.chat.plan import PlanStore
    plans = PlanStore(store)
    result = plans.update(conversation, student, [{"title": "自测栈", "status": status}])
    return plans, result["plan"]["steps"][0]["id"]


def test_wrong_answer_leaves_plan_alone(tmp_path):
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=FakeChat([]))) as client:
        alice, conversation, store, user, *_ = setup(client)
        student = student_of(store, conversation)
        plans, step_id = plan_with(store, conversation, student)
        reply, sealed = drill_reply(store, conversation, user, {**QUIZ, "planStepId": step_id})
        assert f'"planStepId": "{step_id}"' in sealed
        with store.connection() as db:
            assert db.execute("SELECT plan_step_id FROM quiz_items WHERE quiz_id = ?",
                              (f"{reply}:0",)).fetchone()[0] == step_id
        version = plans.read(conversation, student)["version"]
        wrong = attempt(client, alice, f"{reply}:0", "p-1", 0).json()
        assert wrong["plan_step"] is None and plans.read(conversation, student)["version"] == version
        assert plans.read(conversation, student)["steps"][0]["status"] == "awaiting_learner"


def test_correct_first_attempt_completes_plan_step(tmp_path):
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=FakeChat([]))) as client:
        alice, conversation, store, user, *_ = setup(client)
        student = student_of(store, conversation)
        plans, step_id = plan_with(store, conversation, student)
        reply, _ = drill_reply(store, conversation, user, {**QUIZ, "planStepId": step_id})
        version = plans.read(conversation, student)["version"]
        right = attempt(client, alice, f"{reply}:0", "p-2", 1).json()
        assert right["plan_step"] == {"id": step_id, "title": "自测栈"}
        plan = plans.read(conversation, student)
        assert plan["steps"][0]["status"] == "done" and plan["version"] == version + 1
        assert attempt(client, alice, f"{reply}:0", "p-2", 1).json()["plan_step"] is None


def test_plan_step_not_stored_unless_awaiting_learner(tmp_path):
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=FakeChat([]))) as client:
        alice, conversation, store, user, *_ = setup(client)
        student = student_of(store, conversation)
        _, step_id = plan_with(store, conversation, student, status="in_progress")
        for planned in (step_id, "step-nope", 7):
            reply, _ = drill_reply(store, conversation, user, {**QUIZ, "planStepId": planned})
            with store.connection() as db:
                assert db.execute("SELECT plan_step_id FROM quiz_items WHERE quiz_id = ?",
                                  (f"{reply}:0",)).fetchone()[0] is None
            assert attempt(client, alice, f"{reply}:0", f"n-{reply}", 1).json()["plan_step"] is None


def test_guard_gaps_drops_unknown_memory_and_truncates_note():
    from app.chat.quizzes import guard_gaps
    good = block({"type": "gap", "memoryId": "lmem_ok", "note": "长" * 200})
    bad = block({"type": "gap", "memoryId": "lmem_fake"})
    out = guard_gaps(f"前\n{good}\n中\n{bad}\n后\n{block(QUIZ)}", {"lmem_ok"})
    assert "lmem_fake" not in out and "前" in out and "后" in out
    assert [w["type"] for w in widgets(out)] == ["gap", "micro_quiz"]
    assert len(widgets(out)[0]["note"]) == 120


def test_prompts_no_longer_force_widgets():
    from app.chat.skills.thread_skills import DEEP_EXPLAIN_SKILL, WIDGET_SCHEMA_GUIDE
    assert "必须在正文中嵌入" not in DEEP_EXPLAIN_SKILL and "强制内联" not in DEEP_EXPLAIN_SKILL
    assert "不要用卡片" not in DEEP_EXPLAIN_SKILL + WIDGET_SCHEMA_GUIDE and "planStepId" in WIDGET_SCHEMA_GUIDE

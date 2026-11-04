from fastapi.testclient import TestClient

from app.chat.agent import REVIEW_PROMPT, validate_analysis
from app.chat.cheatsheet import pitfalls, to_markdown
from app.chat.store import ChatStore
from app.main import create_app
from app.memory.store import Store
from tests.test_acceptance_support import isolated_settings
from tests.test_chat import FakeChat, send


STUDENT = "demo-student-001"
BASIS = "连续两次把 i<=n 写成 i<n，都是边界条件出错"


def observation(kind, topic, summary, evidence, source="stated", signal="supports"):
    return {
        "kind": kind, "topic": topic, "summary": summary, "evidence": evidence,
        "reason": "测试依据", "effect": "reinforces", "signal": signal, "source": source,
    }


def chat_store(tmp_path):
    base = Store(tmp_path / "inferred.sqlite3")
    base.initialize()
    store = ChatStore(base)
    store.initialize()
    return store


def test_inferred_observation_keeps_basis_that_is_not_in_the_message():
    user = "我又写错了"
    kept = observation("misconception", "循环边界", "上界经常少一次", BASIS, "inferred")
    dropped = observation("misconception", "编造", "对不上原文", "这句话用户没说过")
    also = observation("preference", "例子", "看例子更快", "看完例子就会", "inferred")
    overflow = observation("mastery", "定义", "看定义会追问", "看定义时反复追问", "inferred")
    result = validate_analysis({"observations": [kept, dropped, also, overflow]}, user, None, [])
    assert [(item["topic"], item["source"], item["quote"]) for item in result["observations"]] == [
        ("循环边界", "inferred", BASIS),
        ("例子", "inferred", "看完例子就会"),
    ]
    stated = validate_analysis({"observations": [{
        "kind": "misconception", "topic": "栈", "summary": "记反了", "evidence": "栈是先进先出",
        "reason": "原话", "effect": "reinforces",
    }]}, "我觉得栈是先进先出的", None, [])
    assert stated["observations"][0]["source"] == "message_quote"
    blank = validate_analysis({"observations": [observation("misconception", "空", "空依据", "  ", "inferred")]}, user, None, [])
    assert blank["observations"] == []
    long = validate_analysis(
        {"observations": [observation("misconception", "太长", "超长依据", "据" * 201, "inferred")]}, user, None, [])
    assert long["observations"] == []


def test_inferred_observation_is_stored_with_source(tmp_path):
    model = FakeChat(["再看一下上界。"], [{"observations": [
        observation("misconception", "循环边界", "上界经常少一次", BASIS, "inferred"),
        observation("misconception", "编造", "对不上原文", "这句话用户没说过"),
    ]}])
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=model)) as client:
        conversation = client.post("/api/conversations", json={}).json()["id"]
        events = send(client, conversation, "我又写错了", "req-infer-0001")
        changes = events[-1][1]["user_message"]["memory_changes"]
        assert len(changes) == 1 and changes[0]["action"] == "created"
        evidence = changes[0]["memory"]["evidence"][0]
        assert evidence["quote"] == BASIS and evidence["source"] == "inferred"
        assert evidence["message_id"] == events[-1][1]["user_message"]["id"]
        assert changes[0]["memory"]["status"] == "suspected"


def test_inferred_only_mastery_is_not_observed_until_it_weighs_a_full_quote(tmp_path):
    store = chat_store(tmp_path)
    conversation = store.create_conversation(STUDENT, title=None, problem=None, client_request_id=None)
    first = store.add_user_message(conversation, "看完例子自己写出来了", "req-weight-01")
    stated = store.record_observation(
        STUDENT, kind="mastery", topic="栈", topic_key=None, summary="能说明后进先出",
        quote="栈是后进先出", reason="原话", signal="supports", related_id=None,
        conversation_id=conversation, message_id=first,
    )
    second = store.add_user_message(conversation, "这题我写完了", "req-weight-02")
    inferred = store.record_observation(
        STUDENT, kind="mastery", topic="递归", topic_key=None, summary="看完例子能独立写出",
        quote="看完例子后能独立写出", reason="连续表现", signal="supports", related_id=None,
        conversation_id=conversation, message_id=second, source="inferred",
    )
    assert stated.memory.status == "observed" and stated.memory.confidence == 0.5
    assert inferred.memory.status == "uncertain" and inferred.memory.confidence == 0.42
    third = store.add_user_message(conversation, "下一题也自己写完了", "req-weight-03")
    again = store.record_observation(
        STUDENT, kind="mastery", topic="递归", topic_key=None, summary="看完例子能独立写出",
        quote="又一次看完例子后独立写对", reason="连续表现", signal="supports", related_id=None,
        conversation_id=conversation, message_id=third, source="inferred",
    )
    assert again.memory.status == "observed" and again.memory.confidence == 0.5
    assert [item.source for item in again.memory.evidence] == ["inferred", "inferred"]


def test_inferred_evidence_does_not_overwrite_a_user_correction(tmp_path):
    store = chat_store(tmp_path)
    conversation = store.create_conversation(STUDENT, title=None, problem=None, client_request_id=None)
    first = store.add_user_message(conversation, "我会栈了", "req-correct-01")
    created = store.record_observation(
        STUDENT, kind="mastery", topic="栈", topic_key=None, summary="能说明后进先出",
        quote="我会栈了", reason="原话", signal="supports", related_id=None,
        conversation_id=conversation, message_id=first,
    )
    store.update_memory(created.memory.id, STUDENT, "用户改过的掌握说明", "observed")
    second = store.add_user_message(conversation, "继续", "req-correct-02")
    rejected = store.record_observation(
        STUDENT, kind="mastery", topic="栈", topic_key=None, summary="推断覆盖",
        quote="连续两次没看定义就写对", reason="推断", signal="supports", related_id=created.memory.id,
        conversation_id=conversation, message_id=second, source="inferred",
    )
    assert rejected is None
    memory = store.memories(STUDENT)[0]
    assert memory.user_corrected and memory.summary == "用户改过的掌握说明"
    assert len(memory.evidence) == 1 and memory.evidence[0].source == "message_quote"


def test_review_prompt_marks_repeated_learning_traits_as_inferred():
    assert "学习特点：" in REVIEW_PROMPT and "（推断）" in REVIEW_PROMPT
    assert "知识点的误区、掌握不要写" in REVIEW_PROMPT
    assert "不要从单次行为推断" in REVIEW_PROMPT


def test_cheatsheet_does_not_quote_inferred_basis():
    insights = {"misconceptions": [
        {"id": "m1", "topic": "边界", "summary": "循环上界经常少一次", "status": "suspected", "evidence": [
            {"signal": "supports", "quote": BASIS, "source": "inferred"},
            {"signal": "supports", "quote": "我写成了 i<n", "source": "message_quote"},
        ]},
        {"id": "m2", "topic": "递归", "summary": "递归边界容易漏", "status": "suspected", "evidence": [
            {"signal": "supports", "quote": "两次都在终止条件上漏掉等号", "source": "inferred"},
        ]},
    ]}
    rows = pitfalls(insights)
    assert rows[0]["quotes"] == ["我写成了 i<n"] and rows[0]["summary"] == "循环上界经常少一次"
    assert rows[1]["quotes"] == [] and rows[1]["summary"] == "递归边界容易漏"
    text = to_markdown({
        "subject": {"name": "算法"},
        "generated_at": "2026-11-04T12:00:00+00:00",
        "sections": {"pitfalls": rows, "conclusions": [], "formulas": [], "contrasts": [], "quiz": []},
    })
    assert "「我写成了 i<n」" in text and "递归边界容易漏" in text
    assert BASIS not in text and "两次都在终止条件上漏掉等号" not in text


def test_insights_evidence_includes_source(tmp_path):
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=FakeChat())) as client:
        space = client.post("/api/subjects", json={"name": "算法"}).json()
        store = client.app.state.chat_service.store
        with store.connection() as db:
            student = db.execute("SELECT student_id FROM subjects WHERE id = ?", (space["id"],)).fetchone()[0]
        message = store.add_user_message(space["main_conversation_id"], "我又写错了", "req-insight-01")
        store.record_observation(
            student, kind="misconception", topic="循环边界", topic_key=None, summary="上界经常少一次",
            quote=BASIS, reason="两次同类错误", signal="supports", related_id=None,
            conversation_id=space["main_conversation_id"], message_id=message, subject_id=space["id"],
            source="inferred",
        )
        evidence = client.get(f"/api/subjects/{space['id']}/insights").json()["misconceptions"][0]["evidence"][0]
    assert evidence["source"] == "inferred" and evidence["quote"] == BASIS

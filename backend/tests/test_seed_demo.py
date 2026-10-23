from datetime import date, timedelta

from app.chat.insights import subject_insights
from app.memory.curated import split_entries
from scripts.seed_demo import CIRCUIT_NAME, DS_NAME, PROFILE_MARK, main, open_store, resolve_db

STUDENT = "demo-student-001"


def _snap(store, student):
    subjects = {item.name: item for item in store.subjects(student)}

    def pack(subject):
        conversation = store.conversation(subject.main_conversation_id, student)
        threads = store.threads(subject.id, student) or []
        memories = [item for item in store.memories(student) if item.subject_id == subject.id]
        return (
            len(conversation.messages),
            tuple(sorted(item.id for item in threads)),
            tuple(sorted((item.topic, item.status, len(item.evidence)) for item in memories)),
        )

    profile = tuple(sorted(split_entries(store.agent_notes(student).get("user") or "")))
    return pack(subjects[DS_NAME]), pack(subjects[CIRCUIT_NAME]), profile


def _assert_quotes(store, student, subject_id):
    memories = [item for item in store.memories(student) if item.subject_id == subject_id]
    assert memories
    for memory in memories:
        assert 1 <= len(memory.evidence) <= 2
        for evidence in memory.evidence:
            message = store.message(evidence.message_id, student)
            assert message is not None and message.role == "user"
            assert message.conversation_id == evidence.conversation_id
            assert evidence.quote in message.content
            assert store.conversation(message.conversation_id, student).subject_id == subject_id


def _assert_demo(store, student):
    subjects = {item.name: item for item in store.subjects(student)}
    ds = subjects[DS_NAME]
    circuit = subjects[CIRCUIT_NAME]
    assert "演示" in ds.description and "演示" in ds.goal
    assert ds.level == "exam"
    assert ds.deadline == (date.today() + timedelta(days=10)).isoformat()
    main_chat = store.conversation(ds.main_conversation_id, student)
    assert sum(item.role == "user" for item in main_chat.messages) >= 5
    _assert_quotes(store, student, ds.id)
    _assert_quotes(store, student, circuit.id)
    ds_memories = [item for item in store.memories(student) if item.subject_id == ds.id]
    misconceptions = [item for item in ds_memories if item.kind == "misconception"]
    mastery = [item for item in ds_memories if item.kind == "mastery"]
    assert len(misconceptions) == 5 and len(mastery) == 3
    by_topic = {item.topic: item.status for item in misconceptions}
    assert by_topic["栈的后进先出（演示）"] == "needs_review"
    assert by_topic["循环队列判满（演示）"] == "needs_review"
    assert by_topic["二叉树中序遍历（演示）"] == "suspected"
    assert by_topic["哈希冲突（演示）"] == "needs_review"
    assert by_topic["递归与系统栈（演示）"] == "improving"
    assert {item.status for item in mastery} == {"observed"}
    insights = subject_insights(store, student, ds.id)
    assert insights["stats"]["threads_open"] == 1 and insights["stats"]["threads_resolved"] == 2
    resolved = [item for item in insights["threads"] if item["status"] == "resolved"]
    assert len(resolved) == 2 and all(item["summary"] and item["takeaways"] for item in resolved)
    open_thread = next(item for item in insights["threads"] if item["status"] == "open")
    assert "演示" in open_thread["title"] and open_thread["summary"] == ""
    open_chat = store.conversation(open_thread["id"], student)
    assert any(item.role == "user" for item in open_chat.messages)
    circuit_insights = subject_insights(store, student, circuit.id)
    assert circuit_insights["stats"]["misconceptions"] == 1
    assert circuit_insights["stats"]["mastered"] == 1
    assert circuit_insights["stats"]["threads_open"] == 1
    assert circuit_insights["stats"]["threads_resolved"] == 0
    profile = [item for item in split_entries(store.agent_notes(student)["user"]) if PROFILE_MARK in item]
    assert len(profile) == 5
    for prefix in ("[Identity]", "[Preference]", "[Context]", "[Activity]", "[Experience]"):
        assert any(item.startswith(prefix) for item in profile)


def _agenda_count(store):
    with store.connection() as conn:
        return conn.execute("SELECT COUNT(*) FROM agenda_tasks WHERE student_id = ?", (STUDENT,)).fetchone()[0]


def test_seed_demo_is_idempotent_and_reset_keeps_user_data(tmp_path, capsys):
    assert resolve_db(str(tmp_path)) == (tmp_path / "knowgap.sqlite3").resolve()
    db = tmp_path / "app.sqlite3"
    store = open_store(db)
    user_subject = store.create_subject(STUDENT, "我的线性代数", "用户自己的课程", "", goal="期末自己复习")
    user_message = store.add_user_message(user_subject.main_conversation_id, "我自己的矩阵笔记别删", "user-own-msg")
    change = store.record_observation(
        STUDENT, kind="mastery", topic="用户自己的矩阵", topic_key=None, summary="用户自己记住了矩阵乘法",
        quote="我自己的矩阵笔记别删", reason="用户原话", signal="supports", related_id=None,
        conversation_id=user_subject.main_conversation_id, message_id=user_message, subject_id=user_subject.id,
    )
    store.save_agent_note(STUDENT, "user", "[Preference] 我喜欢先看例题")
    other = store.create_subject("other-student", "别人的课", "不要动", "")

    main(["--db", str(db), "--student", STUDENT])
    store = open_store(db)
    _assert_demo(store, STUDENT)
    snap = _snap(store, STUDENT)
    assert any(item.topic == "用户自己的矩阵" for item in store.memories(STUDENT))

    with store.connection() as conn:
        conn.execute("INSERT INTO agenda_tasks(id, student_id, title, created_at, updated_at) "
                     "VALUES ('task-user-own', ?, '用户自己的待办', 'x', 'x')", (STUDENT,))
    count = _agenda_count(store)
    assert count >= 8

    main(["--db", str(db), "--student", STUDENT])
    store = open_store(db)
    assert _snap(store, STUDENT) == snap
    _assert_demo(store, STUDENT)
    assert _agenda_count(store) == count

    main(["--db", str(db), "--student", STUDENT, "--reset"])
    store = open_store(db)
    names = [item.name for item in store.subjects(STUDENT)]
    assert DS_NAME not in names and CIRCUIT_NAME not in names
    kept = store.subject(user_subject.id, STUDENT)
    assert kept is not None and kept.goal == "期末自己复习"
    message = store.message(user_message, STUDENT)
    assert message is not None and message.content == "我自己的矩阵笔记别删"
    assert [item.id for item in store.memories(STUDENT)] == [change.memory.id]
    notes = store.agent_notes(STUDENT)["user"]
    assert "我喜欢先看例题" in notes and PROFILE_MARK not in notes
    assert store.subject(other.id, "other-student") is not None
    assert _agenda_count(store) == 1
    assert "reset" in capsys.readouterr().out


def test_reset_still_clears_focus_rows_left_by_older_versions(tmp_path):
    store = open_store(tmp_path / "legacy.sqlite3")
    with store.connection() as conn:
        conn.execute("CREATE TABLE focus_sessions(id TEXT PRIMARY KEY, student_id TEXT NOT NULL)")
        conn.executemany("INSERT INTO focus_sessions VALUES (?, ?)", [
            ("focus-seed-demo-001", STUDENT), ("focus-own-001", STUDENT)])
    main(["--db", str(tmp_path / "legacy.sqlite3"), "--student", STUDENT, "--reset"])
    with open_store(tmp_path / "legacy.sqlite3").connection() as conn:
        assert [row[0] for row in conn.execute("SELECT id FROM focus_sessions")] == ["focus-own-001"]

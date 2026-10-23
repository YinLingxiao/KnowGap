"""学习空间：主线、支线、合并小结、进度和旧数据迁移。"""

import sqlite3

from fastapi.testclient import TestClient

from app.agents.llm import ProviderError
from app.main import create_app
from tests.test_acceptance_support import isolated_settings
from tests.test_chat import FakeChat, context_of, send
from tests.test_subjects import observation


def new_space(client, name="日语", **fields):
    response = client.post("/api/subjects", json={"name": name, "goal": "三个月后能点餐问路", "level": "beginner", **fields})
    assert response.status_code == 201, response.text
    return response.json()


def new_thread(client, subject_id, request_id, **fields):
    response = client.post(f"/api/subjects/{subject_id}/threads", json={"client_request_id": request_id, **fields})
    assert response.status_code == 201, response.text
    return response.json()


def test_new_space_has_a_main_conversation_and_keeps_the_goal(tmp_path):
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=FakeChat())) as client:
        space = new_space(client, deadline="2026-12-31", color="#2e8a5c")
        assert space["goal"] == "三个月后能点餐问路" and space["level"] == "beginner"
        assert space["deadline"] == "2026-12-31" and space["color"] == "#2e8a5c"
        main = client.get(f"/api/conversations/{space['main_conversation_id']}").json()
        assert main["kind"] == "main" and main["subject_id"] == space["id"] and main["messages"] == []
        listed = [item["id"] for item in client.get("/api/conversations").json()]
        assert space["main_conversation_id"] not in listed
        patched = client.patch(f"/api/subjects/{space['id']}", json={"level": "exam", "deadline": None}).json()
        assert patched["level"] == "exam" and patched["deadline"] is None and patched["goal"] == space["goal"]


def test_thread_dedup_and_context_carries_the_anchor(tmp_path):
    model = FakeChat(["先从问候和整句开始。", "て形是把动词变成连接形。"])
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=model)) as client:
        space = new_space(client, deadline="2026-12-31")
        main_id = space["main_conversation_id"]
        send(client, main_id, "我想学问候", "req-main-0001")
        anchor_id = client.get(f"/api/conversations/{main_id}").json()["messages"][0]["id"]
        thread = new_thread(client, space["id"], "thread-req-01", anchor_message_id=anchor_id)
        again = new_thread(client, space["id"], "thread-req-01", title="不该再建一条")
        assert again["id"] == thread["id"]
        assert len(client.get(f"/api/subjects/{space['id']}/threads").json()) == 1
        assert thread["kind"] == "thread" and thread["parent_id"] == main_id and thread["thread_status"] == "open"
        assert thread["anchor"]["message_id"] == anchor_id and "问候" in thread["anchor"]["excerpt"]

        send(client, thread["id"], "て形怎么用", "req-thread-01")
        assert context_of(model.calls[0])["conversation_role"]["role"] == "main"
        assert context_of(model.calls[0])["subject"]["level"] == "beginner"
        assert context_of(model.calls[0])["subject"]["deadline"] == "2026-12-31"
        role = context_of(model.calls[1])["conversation_role"]
        assert role["role"] == "thread" and "问候" in role["anchor"]["excerpt"]
        assert any("问候" in item["excerpt"] for item in role["main_recent"])


def test_resolve_drafts_without_saving_then_merges_once(tmp_path):
    draft = {
        "title": "第 3 题",
        "summary": "问题是不会用て形。关键是把它当成变化规则。结论是点餐时先用整句。",
        "takeaways": ["先记整句"],
    }
    model = FakeChat(analyses=[draft])
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=model)) as client:
        space = new_space(client)
        main_id = space["main_conversation_id"]
        thread = new_thread(client, space["id"], "thread-req-02", title="第 3 题")
        before = client.get(f"/api/conversations/{main_id}").json()["messages"]
        drafted = client.post(f"/api/conversations/{thread['id']}/resolve/draft").json()
        assert drafted["title"] == "第 3 题" and drafted["takeaways"] == ["先记整句"]
        assert client.get(f"/api/conversations/{main_id}").json()["messages"] == before
        assert client.get(f"/api/conversations/{thread['id']}").json()["thread_status"] == "open"

        edited = {"title": drafted["title"], "summary": "问题是不会用て形。我改过的结论是先用整句。", "takeaways": drafted["takeaways"]}
        resolved = client.post(f"/api/conversations/{thread['id']}/resolve", json=edited)
        assert resolved.status_code == 200, resolved.text
        resolved = resolved.json()
        messages = client.get(f"/api/conversations/{main_id}").json()["messages"]
        assert len(messages) == 1 and messages[0]["thread_summary"]["thread_id"] == thread["id"]
        assert messages[0]["thread_summary"]["summary"] == edited["summary"]
        assert messages[0]["id"] == resolved["message_id"]
        assert client.get(f"/api/conversations/{thread['id']}").json()["thread_status"] == "resolved"

        duplicate = client.post(f"/api/conversations/{thread['id']}/resolve", json=draft).json()
        assert duplicate["message_id"] == resolved["message_id"]
        assert len(client.get(f"/api/conversations/{main_id}").json()["messages"]) == 1

        assert client.post(f"/api/conversations/{thread['id']}/reopen").json()["thread_status"] == "open"
        client.post(f"/api/conversations/{thread['id']}/resolve", json={
            "title": "再次解决", "summary": "又卡住了一次。这次自己写对了。", "takeaways": ["自己写"],
        })
        assert len(client.get(f"/api/conversations/{main_id}").json()["messages"]) == 2
        assert client.get(f"/api/conversations/{thread['id']}").json()["thread_status"] == "resolved"


def test_progress_counts_memories_and_threads(tmp_path):
    model = FakeChat(analyses=[
        observation("misconception", "て形", "把て形当成过去式", "て形就是过去式"),
        observation("mastery", "问候", "能独立说出问候", "你好是こんにちは"),
    ])
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=model)) as client:
        space = new_space(client)
        main_id = space["main_conversation_id"]
        send(client, main_id, "て形就是过去式", "req-prog-0001")
        send(client, main_id, "你好是こんにちは", "req-prog-0002")
        done = new_thread(client, space["id"], "thread-prog-01")
        client.post(f"/api/conversations/{done['id']}/resolve", json={
            "title": "问候", "summary": "问题是不会问候。结论是先记整句。", "takeaways": ["こんにちは"],
        })
        open_thread = new_thread(client, space["id"], "thread-prog-02")
        progress = client.get(f"/api/subjects/{space['id']}").json()["progress"]
        assert progress["to_review"] == 1 and progress["mastered"] == 1 and progress["improving"] == 0
        assert progress["open_threads"] == 1 and progress["resolved_threads"] == 1
        assert progress["last_studied_at"]
        listed = client.get(f"/api/subjects/{space['id']}/threads").json()
        assert [item["id"] for item in listed] == [open_thread["id"], done["id"]]


def test_deleting_a_space_turns_threads_into_chats(tmp_path):
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=FakeChat())) as client:
        space = new_space(client)
        thread = new_thread(client, space["id"], "thread-del-001")
        assert client.delete(f"/api/subjects/{space['id']}").status_code == 204
        main = client.get(f"/api/conversations/{space['main_conversation_id']}").json()
        opened = client.get(f"/api/conversations/{thread['id']}").json()
        assert main["kind"] == "chat" and main["subject_id"] is None and main["parent_id"] is None
        assert opened["kind"] == "chat" and opened["parent_id"] is None and opened["thread_status"] is None


def test_main_conversation_and_threads_stay_inside_their_space(tmp_path):
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=FakeChat())) as client:
        space = new_space(client)
        main_id = space["main_conversation_id"]
        thread = new_thread(client, space["id"], "thread-own-001")

        assert client.delete(f"/api/conversations/{main_id}").status_code == 409
        assert client.get(f"/api/conversations/{main_id}").status_code == 200
        assert client.get(f"/api/subjects/{space['id']}").json()["main_conversation_id"] == main_id

        for conversation_id in (main_id, thread["id"]):
            assert client.patch(f"/api/conversations/{conversation_id}", json={"subject_id": None}).status_code == 409
            assert client.patch(f"/api/conversations/{conversation_id}", json={"subject_id": space["id"]}).status_code == 200
            renamed = client.patch(f"/api/conversations/{conversation_id}", json={"title": "改个名"})
            assert renamed.status_code == 200 and renamed.json()["title"] == "改个名"
            assert renamed.json()["subject_id"] == space["id"]

        assert client.delete(f"/api/conversations/{thread['id']}").status_code == 204


def test_opening_a_thread_twice_reuses_the_empty_one(tmp_path):
    model = FakeChat(["好的。"])
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=model)) as client:
        space = new_space(client)
        main_id = space["main_conversation_id"]
        send(client, main_id, "我想学问候", "req-reuse-0001")
        anchor_id = client.get(f"/api/conversations/{main_id}").json()["messages"][0]["id"]

        first = new_thread(client, space["id"], "reuse-req-01", anchor_message_id=anchor_id)
        assert new_thread(client, space["id"], "reuse-req-02", anchor_message_id=anchor_id)["id"] == first["id"]
        blank = new_thread(client, space["id"], "reuse-req-03")
        assert blank["id"] != first["id"]
        assert new_thread(client, space["id"], "reuse-req-04")["id"] == blank["id"]
        assert len(client.get(f"/api/subjects/{space['id']}/threads").json()) == 2

        send(client, first["id"], "て形怎么用", "req-reuse-0002")
        used = new_thread(client, space["id"], "reuse-req-05", anchor_message_id=anchor_id)
        assert used["id"] != first["id"]

        client.post(f"/api/conversations/{blank['id']}/resolve", json={
            "title": "空的", "summary": "没有问题。随手关掉了。", "takeaways": [],
        })
        assert new_thread(client, space["id"], "reuse-req-06")["id"] != blank["id"]


def test_old_space_conversations_become_threads(tmp_path):
    settings = isolated_settings(tmp_path)
    db = sqlite3.connect(settings.resolved_database_path())
    db.executescript("""
        CREATE TABLE subjects (
            id TEXT PRIMARY KEY, student_id TEXT NOT NULL, name TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '', instructions TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        INSERT INTO subjects VALUES ('subj-old', 'demo-student-001', '日语', '', '',
            '2026-10-01T00:00:00+00:00', '2026-10-01T00:00:00+00:00');
        CREATE TABLE conversations (
            id TEXT PRIMARY KEY, student_id TEXT NOT NULL, title TEXT NOT NULL,
            title_source TEXT NOT NULL CHECK(title_source IN ('pending', 'auto', 'user')),
            client_request_id TEXT, legacy_session_id TEXT UNIQUE,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL, subject_id TEXT,
            UNIQUE(student_id, client_request_id)
        );
        INSERT INTO conversations VALUES ('conv-old', 'demo-student-001', '旧的栈问题', 'user', NULL, NULL,
            '2026-10-01T00:00:00+00:00', '2026-10-02T00:00:00+00:00', 'subj-old');
        CREATE TABLE conversation_messages (
            id TEXT PRIMARY KEY,
            conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
            seq INTEGER NOT NULL,
            role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
            kind TEXT NOT NULL CHECK(kind IN ('text', 'exercise')),
            content TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('complete', 'streaming', 'failed', 'cancelled')),
            error TEXT, client_request_id TEXT, reply_to TEXT,
            meta_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
            UNIQUE(conversation_id, seq), UNIQUE(conversation_id, client_request_id)
        );
        INSERT INTO conversation_messages VALUES ('cmsg-old', 'conv-old', 1, 'user', 'text', '栈是什么',
            'complete', NULL, NULL, NULL, '{}', '2026-10-02T00:00:00+00:00', '2026-10-02T00:00:00+00:00');
    """)
    db.close()
    main_id = None
    for _ in range(2):
        with TestClient(create_app(settings, chat_model=FakeChat())) as client:
            space = client.get("/api/subjects/subj-old").json()
            assert space["name"] == "日语" and space["main_conversation_id"]
            if main_id is None:
                main_id = space["main_conversation_id"]
            assert space["main_conversation_id"] == main_id
            threads = client.get("/api/subjects/subj-old/threads").json()
            assert [item["id"] for item in threads] == ["conv-old"]
            assert threads[0]["thread_status"] == "open" and threads[0]["parent_id"] == main_id
            restored = client.get("/api/conversations/conv-old").json()
            assert restored["messages"][0]["content"] == "栈是什么"
            assert client.get(f"/api/conversations/{main_id}").json()["kind"] == "main"


def test_draft_failure_reports_the_model_error(tmp_path):
    model = FakeChat(analyses=[ProviderError(503, "模型服务暂时限流或额度不足，请稍后重试。")])
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=model)) as client:
        space = new_space(client)
        thread = new_thread(client, space["id"], "thread-err-001")
        failed = client.post(f"/api/conversations/{thread['id']}/resolve/draft")
        assert failed.status_code == 503 and "限流" in failed.json()["detail"]
        assert client.get(f"/api/conversations/{thread['id']}").json()["thread_status"] == "open"
        assert client.get(f"/api/conversations/{space['main_conversation_id']}").json()["messages"] == []

    model = FakeChat(analyses=[{"title": "坏的", "summary": "只有一句。", "takeaways": []}])
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=model)) as client:
        space = new_space(client)
        thread = new_thread(client, space["id"], "thread-err-002")
        failed = client.post(f"/api/conversations/{thread['id']}/resolve/draft")
        assert failed.status_code == 502 and "2 到 4" in failed.json()["detail"]
        assert client.get(f"/api/conversations/{thread['id']}").json()["thread_status"] == "open"
        assert client.get(f"/api/conversations/{space['main_conversation_id']}").json()["messages"] == []

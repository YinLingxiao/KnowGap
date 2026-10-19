"""Subjects (Project-like folders) and layered memory recall: own Subject first, then general, then outward."""

import sqlite3

from fastapi.testclient import TestClient

from app.main import create_app
from tests.test_acceptance_support import isolated_settings
from tests.test_chat import FakeChat, context_of, send


def observation(kind, topic, summary, evidence, tags=(), signal="supports"):
    return {"observations": [{
        "kind": kind, "topic": topic, "summary": summary, "evidence": evidence,
        "reason": "测试证据", "signal": signal, "tags": list(tags),
    }]}


def new_subject(client, name, **fields):
    response = client.post("/api/subjects", json={"name": name, **fields})
    assert response.status_code == 201, response.text
    return response.json()


def new_chat(client, subject_id=None):
    return client.post("/api/conversations", json={"subject_id": subject_id} if subject_id else {}).json()["id"]


def recalled(model, call_index):
    context = context_of(model.calls[call_index])
    # Preferences remain recallable as evidence, separate from authoritative USER policy.
    return [(m["summary"], m["scope"]) for m in context.get("preference_evidence", []) + context["learner_memories"]]


def test_subject_crud_and_conversation_membership(tmp_path):
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=FakeChat())) as client:
        ds = new_subject(client, "数据结构", description="大二必修", instructions="多用图示")
        assert ds["conversation_count"] == 0 and client.get("/api/subjects").json()[0]["name"] == "数据结构"
        renamed = client.patch(f"/api/subjects/{ds['id']}", json={"instructions": "先给例子"}).json()
        assert renamed["instructions"] == "先给例子" and renamed["description"] == "大二必修"

        inside = new_chat(client, ds["id"])
        outside = new_chat(client)
        assert client.get(f"/api/conversations/{inside}").json()["subject_id"] == ds["id"]
        assert [c["id"] for c in client.get(f"/api/conversations?subject_id={ds['id']}").json()] == [inside]
        assert client.post("/api/conversations", json={"subject_id": "subj-missing"}).status_code == 404

        moved = client.patch(f"/api/conversations/{outside}", json={"subject_id": ds["id"]}).json()
        assert moved["subject_id"] == ds["id"]
        out = client.patch(f"/api/conversations/{outside}", json={"subject_id": None}).json()
        assert out["subject_id"] is None and out["title"] == "新对话"
        assert client.get(f"/api/subjects/{ds['id']}").json()["conversation_count"] == 1


def test_subject_instructions_reach_the_model(tmp_path):
    model = FakeChat(["好的"])
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=model)) as client:
        ds = new_subject(client, "数据结构", instructions="回答先给一个小例子")
        send(client, new_chat(client, ds["id"]), "什么是栈", "req-subj-001")
        assert context_of(model.calls[0])["subject"] == {
            "name": "数据结构", "description": "", "instructions": "回答先给一个小例子",
        }


def test_layered_recall_prefers_own_subject_and_looks_outward_only_when_needed(tmp_path):
    analyses = [
        observation("misconception", "栈的出入顺序", "认为栈是先进先出", "栈就是先进先出", tags=["栈", "LIFO"]),
        observation("preference", "讲解方式", "希望先看例子再看定义", "我更喜欢先看例子"),
        observation("misconception", "进程调度", "混淆了抢占式与非抢占式调度", "非抢占式调度也会打断正在运行的进程",
                    tags=["调度", "抢占"]),
    ]
    model = FakeChat(analyses=analyses)
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=model)) as client:
        ds = new_subject(client, "数据结构")
        os_ = new_subject(client, "操作系统")
        ds_chat = new_chat(client, ds["id"])
        os_chat = new_chat(client, os_["id"])
        send(client, ds_chat, "我觉得栈就是先进先出", "req-layer-01")
        send(client, ds_chat, "我更喜欢先看例子", "req-layer-02")
        send(client, os_chat, "我以为非抢占式调度也会打断正在运行的进程", "req-layer-03")

        memories = {m["summary"]: m for m in client.get("/api/learner-memories").json()}
        assert memories["认为栈是先进先出"]["subject_id"] == ds["id"]
        assert memories["认为栈是先进先出"]["tags"] == ["栈", "LIFO"]
        assert memories["希望先看例子再看定义"]["subject_id"] is None  # preferences are general
        assert memories["混淆了抢占式与非抢占式调度"]["subject_id"] == os_["id"]

        # Own Subject: the stack mistake is recalled as "本科目", the preference as "通用".
        send(client, new_chat(client, ds["id"]), "栈还有哪些应用", "req-layer-04")
        assert recalled(model, 3) == [("希望先看例子再看定义", "通用"), ("认为栈是先进先出", "本科目")]

        # Another Subject, unrelated topic: nothing from 数据结构 leaks in, the general preference still applies.
        send(client, new_chat(client, os_["id"]), "讲讲虚拟内存", "req-layer-05")
        assert recalled(model, 4) == [("希望先看例子再看定义", "通用")]

        # Another Subject, nothing local on the topic, but a concept tag hits: look outward and label the source.
        send(client, new_chat(client, os_["id"]), "函数调用栈在内存里怎么工作", "req-layer-06")
        assert ("认为栈是先进先出", "其他科目：数据结构") in recalled(model, 5)

        # A single shared character is not enough to cross Subjects.
        send(client, new_chat(client, ds["id"]), "数组的度量", "req-layer-07")
        assert ("混淆了抢占式与非抢占式调度", "其他科目：操作系统") not in recalled(model, 6)

        # Enough local hits: the outward search does not run even if another Subject matches.
        send(client, os_chat, "抢占式调度和栈有关系吗", "req-layer-08")
        scopes = [scope for _, scope in recalled(model, 7)]
        assert "本科目" in scopes and len(scopes) <= 4


def test_memory_scope_can_be_corrected(tmp_path):
    model = FakeChat(analyses=[observation("misconception", "栈", "认为栈是先进先出", "栈就是先进先出", tags=["栈"])])
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=model)) as client:
        ds = new_subject(client, "数据结构")
        os_ = new_subject(client, "操作系统")
        send(client, new_chat(client, ds["id"]), "栈就是先进先出", "req-scope-01")
        memory = client.get("/api/learner-memories").json()[0]
        general = client.patch(f"/api/learner-memories/{memory['id']}", json={"subject_id": None}).json()
        assert general["subject_id"] is None and general["user_corrected"] is True
        assert client.patch(f"/api/learner-memories/{memory['id']}", json={"subject_id": "subj-x"}).status_code == 404
        # A general memory is local to every Subject.
        send(client, new_chat(client, os_["id"]), "栈帧是什么", "req-scope-02")
        assert recalled(model, 1) == [("认为栈是先进先出", "通用")]
        assert client.get(f"/api/learner-memories?subject_id={ds['id']}").json() == []


def test_deleting_a_subject_keeps_what_was_learned(tmp_path):
    model = FakeChat(analyses=[observation("misconception", "栈", "认为栈是先进先出", "栈就是先进先出")])
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=model)) as client:
        ds = new_subject(client, "数据结构")
        chat = new_chat(client, ds["id"])
        send(client, chat, "栈就是先进先出", "req-del-0001")
        upload = client.post(f"/api/materials?subject_id={ds['id']}",
                             files={"file": ("栈.md", "栈是后进先出的线性表。".encode(), "text/markdown")})
        assert upload.status_code == 201 and upload.json()["subject_id"] == ds["id"]
        assert client.get(f"/api/subjects/{ds['id']}").json()["material_count"] == 1

        assert client.delete(f"/api/subjects/{ds['id']}").status_code == 204
        assert client.get(f"/api/subjects/{ds['id']}").status_code == 404
        assert client.get(f"/api/conversations/{chat}").json()["subject_id"] is None
        assert client.get("/api/learner-memories").json()[0]["subject_id"] is None
        assert client.get("/api/materials?unassigned=true").json()[0]["subject_id"] is None


def test_course_files_are_scoped_to_their_subject(tmp_path):
    model = FakeChat(["", "", ""])
    model.replies = ["答复一", "答复二", "答复三"]
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=model)) as client:
        ds = new_subject(client, "数据结构")
        os_ = new_subject(client, "操作系统")
        for subject, name, text in [(ds, "栈.md", "栈的出栈顺序遵循后进先出。"), (os_, "栈帧.md", "函数调用时栈帧保存返回地址。")]:
            client.post(f"/api/materials?subject_id={subject['id']}",
                        files={"file": (name, text.encode(), "text/markdown")})
        client.post("/api/materials", files={"file": ("通用.md", "栈是一种线性表。".encode(), "text/markdown")})

        send(client, new_chat(client, ds["id"]), "栈的出栈顺序", "req-mat-0001")
        titles = [s["title"] for s in context_of(model.calls[0])["course_sources"]]
        assert titles[0] == "栈.md" and "栈帧.md" not in titles

        send(client, new_chat(client), "栈是什么", "req-mat-0002")
        assert [s["title"] for s in context_of(model.calls[1])["course_sources"]] == ["通用.md"]
        assert [m["title"] for m in client.get(f"/api/materials?subject_id={os_['id']}").json()] == ["栈帧.md"]


def test_existing_database_is_migrated_in_place(tmp_path):
    settings = isolated_settings(tmp_path)
    path = settings.resolved_database_path()
    db = sqlite3.connect(path)
    db.executescript("""
        CREATE TABLE conversations (
            id TEXT PRIMARY KEY, student_id TEXT NOT NULL, title TEXT NOT NULL,
            title_source TEXT NOT NULL CHECK(title_source IN ('pending', 'auto', 'user')),
            client_request_id TEXT, legacy_session_id TEXT UNIQUE,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(student_id, client_request_id)
        );
        INSERT INTO conversations VALUES ('conv-old', 'demo-student-001', '旧对话', 'user', NULL, NULL,
            '2026-10-01T00:00:00+00:00', '2026-10-01T00:00:00+00:00');
        CREATE TABLE learner_memories (
            id TEXT PRIMARY KEY, student_id TEXT NOT NULL,
            kind TEXT NOT NULL CHECK(kind IN ('misconception', 'mastery', 'preference')),
            topic TEXT NOT NULL, topic_key TEXT, summary TEXT NOT NULL, status TEXT NOT NULL,
            confidence REAL NOT NULL, user_corrected INTEGER NOT NULL DEFAULT 0,
            origin TEXT NOT NULL DEFAULT 'chat' CHECK(origin IN ('chat', 'diagnosis')),
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        INSERT INTO learner_memories VALUES ('lmem-old', 'demo-student-001', 'preference', '讲解方式', NULL,
            '希望先看例子', 'observed', 0.5, 0, 'chat', '2026-10-01T00:00:00+00:00', '2026-10-01T00:00:00+00:00');
    """)
    db.close()
    for _ in range(2):  # starting twice must be harmless
        with TestClient(create_app(settings, chat_model=FakeChat())) as client:
            conversation = client.get("/api/conversations/conv-old").json()
            assert conversation["title"] == "旧对话" and conversation["subject_id"] is None
            memory = client.get("/api/learner-memories").json()[0]
            assert memory["summary"] == "希望先看例子" and memory["subject_id"] is None and memory["tags"] == []
            assert new_chat(client)


def test_effect_field_creates_only_when_reinforcing(tmp_path):
    weakening_nothing = {"observations": [{
        "kind": "misconception", "topic": "栈", "summary": "认为栈是先进先出", "evidence": "栈就是先进先出",
        "reason": "错误陈述", "effect": "weakens", "related_memory_id": None,
    }]}
    reinforcing = {"observations": [{**weakening_nothing["observations"][0], "effect": "reinforces"}]}
    model = FakeChat(analyses=[weakening_nothing, reinforcing])
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=model)) as client:
        chat = new_chat(client)
        send(client, chat, "栈就是先进先出", "req-effect-01")
        assert client.get("/api/learner-memories").json() == []
        send(client, chat, "我还是觉得栈就是先进先出", "req-effect-02")
        assert [m["status"] for m in client.get("/api/learner-memories").json()] == ["suspected"]

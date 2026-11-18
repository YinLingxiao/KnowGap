"""B2 source origin: space vs general labels, source field, and legacy metadata."""

from fastapi.testclient import TestClient

from app.chat.agent import chat_messages, learning_context
from app.chat.prompts.common import COMMON_CONTEXT_PROMPT
from app.chat.store import ChatStore
from app.main import create_app
from app.memory.store import Store
from app.services.materials import MaterialStore
from tests.test_acceptance_support import isolated_settings
from tests.test_chat import FakeChat, send


STUDENT = "demo-student-001"
SUBJECT = "subj_origin"


def library(tmp_path, name: str = "materials.sqlite3"):
    store = Store(tmp_path / name)
    store.initialize()
    materials = MaterialStore(store)
    materials.initialize()
    return store, materials


def add_document(store, document_id: str, subject_id: str | None, chunk_id: str, content: str, page: int = 1):
    with store.connection() as db:
        db.execute(
            "INSERT INTO course_materials(id, student_id, title, kind, page_count, chunk_count, created_at, subject_id) "
            "VALUES (?, ?, ?, 'text', 1, 1, '2026-11-18T00:00:00+00:00', ?)",
            (document_id, STUDENT, f"{document_id}.txt", subject_id),
        )
        db.execute(
            "INSERT INTO course_chunks(id, document_id, content, page, start_line, end_line) "
            "VALUES (?, ?, ?, ?, NULL, NULL)",
            (chunk_id, document_id, content, page),
        )
        db.execute("INSERT INTO course_index(chunk_id, terms) VALUES (?, ?)",
                   (chunk_id, "抽样定理 抽样 定理"))


def test_scoped_search_labels_space_and_general_segments(tmp_path):
    store, materials = library(tmp_path)
    add_document(store, "doc_space", SUBJECT, "chunk_space", "抽样定理 空间说明")
    add_document(store, "doc_general", None, "chunk_general", "抽样定理 通用补充")

    found = materials.search_scoped(STUDENT, "抽样定理", 5, SUBJECT)

    assert [(source.label, source.source) for source in found] == [
        ("空间资料1", "space"),
        ("通用资料1", "general"),
    ]


def test_plain_search_keeps_neutral_label(tmp_path):
    store, materials = library(tmp_path)
    add_document(store, "doc_space", SUBJECT, "chunk_space", "抽样定理 空间说明")
    add_document(store, "doc_general", None, "chunk_general", "抽样定理 通用补充")

    found = materials.search(STUDENT, "抽样定理", 5)

    assert [source.label for source in found] == [f"资料{index}" for index in range(1, len(found) + 1)]
    by_document = {source.document_id: source for source in found}
    assert by_document["doc_space"].source == "space"
    assert by_document["doc_general"].source == "general"


def test_free_chat_scoped_search_keeps_neutral_label(tmp_path):
    store, materials = library(tmp_path)
    add_document(store, "doc_general", None, "chunk_general", "抽样定理 通用补充")

    found = materials.search_scoped(STUDENT, "抽样定理", 5, None)

    assert [(source.label, source.source) for source in found] == [("资料1", "general")]


def test_scoped_search_without_space_hit_starts_general_at_one(tmp_path):
    store, materials = library(tmp_path)
    add_document(store, "doc_general", None, "chunk_general", "抽样定理 通用补充")

    found = materials.search_scoped(STUDENT, "抽样定理", 5, SUBJECT)

    assert [(source.label, source.source) for source in found] == [("通用资料1", "general")]


def test_source_reference_returns_source_field(tmp_path):
    store, materials = library(tmp_path)
    add_document(store, "doc_space", SUBJECT, "chunk_space", "抽样定理 空间说明")
    add_document(store, "doc_general", None, "chunk_general", "抽样定理 通用补充")
    found = materials.search_scoped(STUDENT, "抽样定理", 5, SUBJECT)

    assert {source.model_dump()["source"] for source in found} == {"space", "general"}

    rows = [{"role": "user", "content": "抽样定理", "kind": "text", "status": "complete", "meta_json": "{}"}]
    context = learning_context(chat_messages(rows, [], None, found, conversation_role={"role": "chat"}))
    assert {source["source"] for source in context["course_sources"]} == {"space", "general"}


def test_legacy_message_meta_without_source_still_loads(tmp_path):
    settings = isolated_settings(tmp_path)
    with TestClient(create_app(settings, chat_model=FakeChat(["好。"]))) as client:
        conversation = client.post("/api/conversations", json={}).json()["id"]
        send(client, conversation, "你好", "req-legacy-0001")
        messages = client.get(f"/api/conversations/{conversation}").json()["messages"]
        assistant = next(message for message in messages if message["role"] == "assistant")

        chat = ChatStore(Store(settings.resolved_database_path()))
        chat.initialize()
        chat.merge_meta(assistant["id"], {"sources": [{
            "id": "chunk_old", "document_id": "doc_old", "title": "旧资料",
            "label": "资料1", "page": 3, "start_line": None, "end_line": None, "excerpt": "旧片段",
        }]})

        reloaded = client.get(f"/api/conversations/{conversation}").json()["messages"]
        legacy = next(message for message in reloaded if message["id"] == assistant["id"])

        assert legacy["sources"][0]["source"] is None
        assert legacy["sources"][0]["label"] == "资料1"


def test_prompt_declares_space_over_general():
    assert "以空间资料为准" in COMMON_CONTEXT_PROMPT
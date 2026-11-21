import asyncio
import io
import json
import sqlite3
from types import SimpleNamespace

import pytest
from docx import Document

import app.agent_tools as agent_tools
from app.agent_tools import material_search
from app.agent_tools.guard import ToolError
from app.chat.agent import chat_messages, learning_context
from app.chat.checkpoints import READ_ONLY_TOOLS, resume_state
from app.chat.coordination import dispatch
from app.chat.service import ChatService, ToolContext
from app.chat.store import ChatStore
from app.memory.store import Store
from app.services.file_store import FileStore
from app.services.materials import MaterialStore
from tests.test_chat import FakeChat, parse

STUDENT = "demo-student-001"
SUBJECT = "subject-current"
OTHER_SUBJECT = "subject-other"
GUIDANCE = "本轮自动检索的片段不足时，可多次调用 search_materials 更换关键词补充检索。"


def make_library(tmp_path, name="materials.sqlite3", with_files=False):
    store = Store(tmp_path / name)
    store.initialize()
    library = MaterialStore(store)
    library.initialize()
    files = None
    if with_files:
        files = FileStore(store)
        files.initialize()
        library.originals = files
    return store, library, files


def make_context(store, library, subject_id=None, files=None):
    chat = ChatStore(store)
    chat.initialize()
    ctx = ToolContext(None, chat, STUDENT, "conversation", subject_id=subject_id)
    ctx.library = library
    ctx.files = files
    ctx.generated = []
    return ctx


def add(library, title, content, subject_id=None, student_id=STUDENT):
    return library.add(student_id, title, content.encode(), subject_id)


def search(ctx, query, **arguments):
    return json.loads(material_search.run({"query": query, **arguments}, ctx))["results"]


class CountingLibrary:
    def __init__(self, error=None):
        self.calls = []
        self.error = error

    def search_scoped(self, student_id, query, limit, subject_id):
        self.calls.append((student_id, query, limit, subject_id))
        if self.error is not None:
            raise self.error
        return []


def fake_context(library):
    return SimpleNamespace(student_id=STUDENT, subject_id=SUBJECT, library=library)


def test_definition_registration_and_global_dispatch():
    definitions = [item for item in agent_tools.DEFINITIONS if item["function"]["name"] == "search_materials"]
    assert len(definitions) == 1
    function = definitions[0]["function"]
    parameters = function["parameters"]
    assert parameters["required"] == ["query"]
    assert set(parameters["properties"]) == {"query", "limit"}
    assert parameters["additionalProperties"] is False
    assert "maximum" not in parameters["properties"]["limit"]
    assert "片段" in function["description"]
    assert "read_document" in function["description"]
    assert "file_id" in function["description"] and "document_id" in function["description"]
    assert "search_materials" not in agent_tools.NEEDS_APPROVAL
    library = CountingLibrary()
    raw = asyncio.run(agent_tools.run("search_materials", {"query": "needle"}, fake_context(library)))
    assert json.loads(raw) == {"results": []}
    assert library.calls == [(STUDENT, "needle", 5, SUBJECT)]


@pytest.mark.parametrize("arguments", [
    {},
    {"query": None},
    {"query": 1},
    {"query": ""},
    {"query": "   "},
    {"query": "x" * 201},
    {"query": "needle", "limit": None},
    {"query": "needle", "limit": True},
    {"query": "needle", "limit": 0},
    {"query": "needle", "limit": -1},
    {"query": "needle", "limit": 1.5},
    {"query": "needle", "limit": "5"},
    {"query": "needle", "subject_id": OTHER_SUBJECT},
    {"query": "needle", "student_id": "another"},
    {"query": "needle", "extra": True},
])
def test_invalid_arguments_fail_before_search(arguments):
    library = CountingLibrary()
    with pytest.raises(ToolError):
        material_search.run(arguments, fake_context(library))
    assert library.calls == []


@pytest.mark.parametrize("raw_query,limit,expected_query,expected_limit", [
    (" x ", None, "x", 5),
    ("树", 1, "树", 1),
    ("x" * 200, 10, "x" * 200, 10),
    (" needle ", 99, "needle", 10),
])
def test_valid_arguments_are_normalized(raw_query, limit, expected_query, expected_limit):
    library = CountingLibrary()
    arguments = {"query": raw_query}
    if limit is not None:
        arguments["limit"] = limit
    assert json.loads(material_search.run(arguments, fake_context(library))) == {"results": []}
    assert library.calls == [(STUDENT, expected_query, expected_limit, SUBJECT)]


def test_missing_library_and_sqlite_errors_are_tool_errors():
    with pytest.raises(ToolError, match="不能检索资料"):
        material_search.run({"query": "needle"}, fake_context(None))
    library = CountingLibrary(sqlite3.OperationalError("locked"))
    with pytest.raises(ToolError, match="暂时不可用"):
        material_search.run({"query": "needle"}, fake_context(library))
    assert len(library.calls) == 1


def test_plain_conversation_returns_only_current_students_general_materials(tmp_path):
    store, library, _ = make_library(tmp_path)
    general = [add(library, f"general-{index}.md", f"needle general {index}") for index in range(2)]
    excluded = [
        add(library, "current.md", "needle current", SUBJECT),
        add(library, "other.md", "needle other", OTHER_SUBJECT),
        add(library, "foreign.md", "needle foreign", student_id="another-student"),
    ]
    ctx = make_context(store, library)
    found = search(ctx, "needle", limit=10)
    assert {item["document_id"] for item in found} == {item.id for item in general}
    assert [item["label"] for item in found] == ["资料1", "资料2"]
    assert not {item.id for item in excluded} & {item["document_id"] for item in found}


def test_subject_search_prioritizes_then_backfills_and_matches_automatic_scope(tmp_path):
    store, library, _ = make_library(tmp_path)
    own = [add(library, f"own-{index}.md", f"needle own {index}", SUBJECT) for index in range(2)]
    general = [add(library, f"general-{index}.md", f"needle general {index}") for index in range(2)]
    other = add(library, "other.md", "needle other", OTHER_SUBJECT)
    ctx = make_context(store, library, SUBJECT)
    found = search(ctx, "needle", limit=3)
    assert [item["label"] for item in found] == ["空间资料1", "空间资料2", "通用资料1"]
    assert {item["document_id"] for item in found[:2]} == {item.id for item in own}
    assert found[2]["document_id"] in {item.id for item in general}
    assert other.id not in {item["document_id"] for item in found}
    automatic = library.search_scoped(STUDENT, "needle", 3, SUBJECT)
    assert [(item["document_id"], item["label"]) for item in found] == [
        (item.document_id, item.label) for item in automatic
    ]
    enough = search(ctx, "needle", limit=2)
    assert {item["document_id"] for item in enough} == {item.id for item in own}
    assert all(item["label"].startswith("空间资料") for item in enough)


def test_subject_without_hits_uses_general_and_never_other_subjects(tmp_path):
    store, library, _ = make_library(tmp_path)
    general = add(library, "general.md", "generalone general")
    other = add(library, "other.md", "generalone other", OTHER_SUBJECT)
    ctx = make_context(store, library, SUBJECT)
    found = search(ctx, "generalone")
    assert [(item["document_id"], item["label"]) for item in found] == [(general.id, "通用资料1")]
    assert other.id not in {item["document_id"] for item in found}


def test_default_limit_cap_empty_result_and_independent_queries(tmp_path):
    store, library, _ = make_library(tmp_path)
    for index in range(11):
        add(library, f"general-{index}.md", f"needle item {index}")
    ctx = make_context(store, library)
    assert len(search(ctx, "needle")) == 5
    assert len(search(ctx, "needle", limit=99)) == 10
    assert search(ctx, "missing") == []
    first = add(library, "alpha.md", "alphakey alpha")
    second = add(library, "beta.md", "betakey beta")
    assert {item["document_id"] for item in search(ctx, "alphakey")} == {first.id}
    assert {item["document_id"] for item in search(ctx, "betakey")} == {second.id}


def test_result_fields_excerpt_and_global_json_remain_complete(tmp_path):
    store, library, _ = make_library(tmp_path)
    excerpt = "needle " + "后续原文" * 120
    material = add(library, "long.md", excerpt)
    ctx = make_context(store, library)
    found = search(ctx, "needle")
    assert len(found) == 1
    item = found[0]
    assert set(item) == {"label", "document_id", "title", "page", "excerpt"}
    assert item["document_id"] == material.id
    assert item["title"] == "long.md"
    assert item["page"] is None
    assert item["excerpt"] == excerpt[:300]
    for index in range(10):
        add(library, '"' * 130 + f"{index}.md", "needle " + '"' * 290)
    raw = asyncio.run(agent_tools.run("search_materials", {"query": "needle", "limit": 20}, ctx))
    assert len(raw) > agent_tools.MAX_RESULT
    payload = json.loads(raw)
    assert len(payload["results"]) == 10
    assert all(len(item["excerpt"]) <= 300 for item in payload["results"])
    assert not raw.endswith("输出已截断）")


def docx_bytes(text):
    document = Document()
    document.add_paragraph(text)
    output = io.BytesIO()
    document.save(output)
    return output.getvalue()


def test_document_id_connects_search_to_read_document(tmp_path):
    store, library, files = make_library(tmp_path, with_files=True)
    text = "needle " + "原文细节" * 120 + "摘录之后才能看到的结论"
    material = library.add(STUDENT, "lesson.docx", docx_bytes(text))
    ctx = make_context(store, library, files=files)
    raw = asyncio.run(agent_tools.run("search_materials", {"query": "needle"}, ctx))
    item = json.loads(raw)["results"][0]
    assert item["document_id"] == material.id
    assert "摘录之后才能看到的结论" not in item["excerpt"]
    original = asyncio.run(agent_tools.run("read_document", {
        "file_id": item["document_id"],
        "start": item["page"] or 1,
        "limit": 1,
    }, ctx))
    assert "【第 1 页】" in original
    assert "摘录之后才能看到的结论" in original


def make_service(tmp_path, model):
    store, library, _ = make_library(tmp_path, "chat.sqlite3")
    chat = ChatStore(store)
    chat.initialize()
    subject = chat.create_subject(STUDENT, "资料空间", "", "")
    main = chat.subject(subject.id, STUDENT).main_conversation_id
    service = ChatService(chat, lambda: model, library=library)
    return chat, library, service, subject.id, main


class ToolCallingChat(FakeChat):
    def __init__(self, arguments=None):
        super().__init__()
        self.arguments = arguments
        self.toolsets = {}
        self.tool_outputs = {}

    async def stream(self, messages, tools=None):
        role = learning_context(messages)["conversation_role"]["role"]
        self.toolsets.setdefault(role, {tool["function"]["name"] for tool in (tools or [])})
        if self.arguments is None or messages[-1]["role"] == "tool":
            if messages[-1]["role"] == "tool":
                self.tool_outputs[role] = messages[-1]["content"]
            yield "text", "检索完成。"
        else:
            yield "tool_calls", [{
                "id": f"search-{role}",
                "name": "search_materials",
                "arguments": json.dumps(self.arguments),
            }]
        yield "finish", "stop"


async def run_turn(service, conversation_id, user_id):
    generation = service.begin(STUDENT, conversation_id, user_id, [])
    events = [event async for event in service.events(generation)]
    return parse("".join(events))


def test_roles_receive_tool_and_model_calls_use_server_side_subject(tmp_path):
    async def scenario():
        model = ToolCallingChat({"query": "needle", "limit": 5})
        chat, library, service, subject_id, main = make_service(tmp_path, model)
        own = add(library, "own.md", "needle own", subject_id)
        general = add(library, "general.md", "needle general")
        other = add(library, "other.md", "needle other", OTHER_SUBJECT)
        source = chat.add_user_message(main, "准备资料支线", "setup-thread")
        thread, delivered = dispatch(chat, STUDENT, main, source, "资料检索", "检索资料", None)
        plain = chat.create_conversation(STUDENT, title=None, problem=None, client_request_id="plain")
        turns = [
            (main, chat.add_user_message(main, "查资料", "main-search")),
            (thread, delivered),
            (plain, chat.add_user_message(plain, "查资料", "chat-search")),
        ]
        for conversation_id, user_id in turns:
            events = await run_turn(service, conversation_id, user_id)
            assert any(name == "done" for name, _ in events)
        assert "search_materials" in model.toolsets["main"]
        assert "search_materials" in model.toolsets["thread"]
        assert "search_materials" in model.toolsets["chat"]
        assert {"dispatch_thread", "propose_threads"} <= model.toolsets["main"]
        assert "report_progress" in model.toolsets["thread"]
        assert "dispatch_thread" not in model.toolsets["thread"]
        assert not {"dispatch_thread", "propose_threads", "report_progress"} & model.toolsets["chat"]
        for role in ("main", "thread"):
            ids = {item["document_id"] for item in json.loads(model.tool_outputs[role])["results"]}
            assert own.id in ids and general.id in ids and other.id not in ids
        chat_ids = {item["document_id"] for item in json.loads(model.tool_outputs["chat"])["results"]}
        assert chat_ids == {general.id}
        search_definition = next(tool for tool in agent_tools.DEFINITIONS if tool["function"]["name"] == "search_materials")
        assert not {"student_id", "subject_id"} & set(search_definition["function"]["parameters"]["properties"])
        await service.close()
    asyncio.run(scenario())


def test_tool_argument_error_uses_existing_tool_error_channel(tmp_path):
    async def scenario():
        model = ToolCallingChat({"query": " "})
        chat, _, service, _, _ = make_service(tmp_path, model)
        conversation = chat.create_conversation(STUDENT, title=None, problem=None, client_request_id="errors")
        user = chat.add_user_message(conversation, "查资料", "bad-search")
        events = await run_turn(service, conversation, user)
        tool_end = next(data for name, data in events if name == "tool_end")
        assert tool_end["ok"] is False
        assert "关键词不能为空" in tool_end["output"]
        assert "关键词不能为空" in model.tool_outputs["chat"]
        assert any(name == "done" for name, _ in events)
        assert not any(name == "error" for name, _ in events)
        await service.close()
    asyncio.run(scenario())


def test_system_event_tools_remain_narrow(tmp_path):
    async def scenario():
        model = ToolCallingChat()
        chat, _, service, _, main = make_service(tmp_path, model)
        user = chat.add_user_message(main, "系统事件", "system-event")
        chat.merge_meta(user, {"system_event": {"type": "thread_report"}})
        events = await run_turn(service, main, user)
        assert any(name == "done" for name, _ in events)
        assert model.toolsets["main"] == {"propose_threads", "update_plan", "session_search", "stay_silent"}
        assert "search_materials" not in model.toolsets["main"]
        await service.close()
    asyncio.run(scenario())


def test_checkpoint_replay_policy_is_not_expanded():
    assert "search_materials" not in READ_ONLY_TOOLS
    checkpoint = {
        "version": 1,
        "role": "thread",
        "phase": "tools",
        "in_flight": True,
        "next_call": 0,
        "pending": [{"name": "search_materials"}],
    }
    available, reason = resume_state(checkpoint, "failed")
    assert available is False
    assert "结果尚未保存" in reason


def test_all_role_prompts_include_repeat_search_guidance():
    for role in ("main", "thread", "chat"):
        prompt = chat_messages(
            [{"role": "user", "content": "你好", "kind": "text", "status": "complete", "meta_json": "{}"}],
            [], None, [], conversation_role={"role": role}, mode=None,
        )[0]["content"]
        assert GUIDANCE in prompt
        assert "片段只是检索命中的几段，不是全文" in prompt
        assert "read_document" in prompt


def test_tool_hits_continue_turn_labels_and_join_cited_sources(tmp_path):
    store, library, _ = make_library(tmp_path)
    first = add(library, "first.md", "alpha needle")
    second = add(library, "second.md", "beta needle")
    ctx = make_context(store, library)
    ctx.sources = library.search_scoped(STUDENT, "alpha", 5, None)
    assert [(s.document_id, s.label) for s in ctx.sources] == [(first.id, "资料1")]
    found = search(ctx, "needle", limit=10)
    labels = {item["document_id"]: item["label"] for item in found}
    assert labels == {first.id: "资料1", second.id: "资料2"}
    assert [(s.document_id, s.label) for s in ctx.sources] == [(first.id, "资料1"), (second.id, "资料2")]
    again = search(ctx, "beta")
    assert [item["label"] for item in again] == ["资料2"]
    assert len(ctx.sources) == 2


def test_subject_tool_hits_number_within_their_own_family(tmp_path):
    store, library, _ = make_library(tmp_path)
    add(library, "own-a.md", "alpha", SUBJECT)
    own_b = add(library, "own-b.md", "gamma", SUBJECT)
    general = add(library, "general.md", "gamma")
    ctx = make_context(store, library, subject_id=SUBJECT)
    ctx.sources = library.search_scoped(STUDENT, "alpha", 5, SUBJECT)
    found = search(ctx, "gamma")
    assert {item["document_id"]: item["label"] for item in found} == {own_b.id: "空间资料2", general.id: "通用资料1"}


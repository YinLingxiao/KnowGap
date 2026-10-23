import json
import sqlite3

import httpx
from fastapi.testclient import TestClient
from pydantic import SecretStr

from app.agents.llm import ChatCompletionsChat
from app.chat.service import Generation
from app.main import create_app
from app.models.model_library_schemas import ModelEntry, ModelTags, Provider, ServiceModelSelection, make_model_key
from app.services.ai_settings import AISettings
from app.vision.settings import ServiceModels, VisionConfig
from tests.fakes.model_library import FakeModelLibrary
from tests.test_acceptance_support import isolated_settings
from tests.test_chat import FakeChat, send

VERTEX = "https://aiplatform.googleapis.com/v1/publishers/google/models"
DEEPSEEK = "https://api.deepseek.com/v1"
GEMINI = "google/gemini-3.5-flash"
FLASH = "deepseek-flash"
MEMORY = "memory-mini"
NOTICE = "原模型不可用，已改用默认模型"
SECRET = "synthetic-library-key"


def provider(provider_id, name, preset, base_url, *models):
    return Provider(
        id=provider_id, name=name, preset=preset, base_url=base_url, auth_mode="api_key",
        api_key=SecretStr(SECRET), models=list(models),
    )


def entry(model_id, enabled=True):
    return ModelEntry(id=model_id, name=model_id, enabled=enabled, tags=ModelTags(tools=True))


def library_of():
    vertex = provider("prov-11111111", "Vertex", "vertex", VERTEX, entry(GEMINI))
    deepseek = provider("prov-22222222", "DeepSeek", "deepseek", DEEPSEEK, entry(FLASH), entry(MEMORY))
    default = make_model_key(vertex.id, GEMINI)
    library = FakeModelLibrary(
        [vertex, deepseek], default_model=default,
        service_models=ServiceModelSelection(memory=make_model_key(deepseek.id, MEMORY)),
    )
    return library, {
        "gemini": default,
        "flash": make_model_key(deepseek.id, FLASH),
        "memory": make_model_key(deepseek.id, MEMORY),
    }


class BoundChat:
    def __init__(self, settings, sink):
        self.settings = settings
        self.sink = sink

    async def stream(self, messages, tools=None):
        self.sink.append(("chat", self.settings.llm_model, messages))
        yield "text", self.settings.llm_model
        yield "usage", {"prompt_tokens": 2, "completion_tokens": 1}
        yield "finish", "stop"

    async def complete_json(self, messages):
        self.sink.append(("json", self.settings.llm_model, messages))
        return {}


def attach(tmp_path, library, factory):
    app = create_app(isolated_settings(tmp_path), chat_model=FakeChat(["不应该走到注入模型"]))
    client = TestClient(app)
    client.__enter__()
    service = app.state.chat_service
    service.model_library = library
    service.model_factory = factory
    return client


def test_two_conversations_keep_their_own_models_and_record_usage(tmp_path):
    library, keys = library_of()
    sink = []
    client = attach(tmp_path, library, lambda settings: BoundChat(settings, sink))
    try:
        first = client.post("/api/conversations", json={}).json()
        second = client.post("/api/conversations", json={}).json()
        assert first["model_key"] is None and second["model_key"] is None
        assert client.put(f"/api/conversations/{first['id']}/model", json={"model_key": keys["gemini"]}).json()["model_key"] == keys["gemini"]
        assert client.put(f"/api/conversations/{second['id']}/model", json={"model_key": keys["flash"]}).json()["model_key"] == keys["flash"]
        assert client.put(f"/api/conversations/{second['id']}/model", json={"model_key": "prov-22222222/missing"}).status_code == 404
        send(client, first["id"], "只有甲", "req-model-a1")
        send(client, second["id"], "只有乙", "req-model-b1")
        chats = [(model, messages) for kind, model, messages in sink if kind == "chat"]
        assert [model for model, _ in chats] == [GEMINI, FLASH]
        assert "只有甲" in json.dumps(chats[0][1], ensure_ascii=False)
        assert "只有乙" not in json.dumps(chats[0][1], ensure_ascii=False)
        assert "只有乙" in json.dumps(chats[1][1], ensure_ascii=False)
        assert "只有甲" not in json.dumps(chats[1][1], ensure_ascii=False)
        assert all(model == MEMORY for kind, model, _ in sink if kind == "json")
        with client.app.state.chat_service.store.connection() as db:
            rows = db.execute(
                "SELECT purpose, model FROM model_usage WHERE conversation_id = ? ORDER BY created_at", (second["id"],),
            ).fetchall()
        assert ("chat", FLASH) in [(row["purpose"], row["model"]) for row in rows]
        assert ("analysis", MEMORY) in [(row["purpose"], row["model"]) for row in rows]
    finally:
        client.__exit__(None, None, None)


def test_thread_inherits_the_main_model_until_it_sets_its_own(tmp_path):
    library, keys = library_of()
    sink = []
    client = attach(tmp_path, library, lambda settings: BoundChat(settings, sink))
    try:
        space = client.post("/api/subjects", json={"name": "数据结构"}).json()
        main_id = space["main_conversation_id"]
        client.put(f"/api/conversations/{main_id}/model", json={"model_key": keys["flash"]})
        thread = client.post(f"/api/subjects/{space['id']}/threads", json={"client_request_id": "thread-model-01"}).json()
        assert thread["model_key"] == keys["flash"]
        send(client, thread["id"], "支线继承", "req-thread-01")
        client.put(f"/api/conversations/{thread['id']}/model", json={"model_key": keys["gemini"]})
        send(client, thread["id"], "支线自己的", "req-thread-02")
        send(client, main_id, "主线还是原来的", "req-main-0001")
        cleared = client.put(f"/api/conversations/{thread['id']}/model", json={"model_key": None}).json()
        assert cleared["model_key"] == keys["flash"]
        send(client, thread["id"], "又回到主线", "req-thread-03")
        assert [model for kind, model, _ in sink if kind == "chat"] == [FLASH, GEMINI, FLASH, FLASH]
    finally:
        client.__exit__(None, None, None)


def test_unavailable_model_falls_back_once(tmp_path):
    library, keys = library_of()
    flash = next(model for provider in library.providers if provider.id == "prov-22222222" for model in provider.models if model.id == FLASH)
    sink = []
    client = attach(tmp_path, library, lambda settings: BoundChat(settings, sink))
    try:
        conversation = client.post("/api/conversations", json={}).json()
        client.put(f"/api/conversations/{conversation['id']}/model", json={"model_key": keys["flash"]})
        flash.enabled = False
        first = send(client, conversation["id"], "第一次", "req-fallback1")
        notices = [data for name, data in first if name == "model_notice"]
        assert notices == [{"detail": NOTICE}]
        assert first[0][1]["model_notice"] == NOTICE
        assert first[0][0] == "start" and [name for name, _ in first].index("model_notice") < [name for name, _ in first].index("delta")
        assert client.get(f"/api/conversations/{conversation['id']}").json()["model_key"] == keys["flash"]
        second = send(client, conversation["id"], "第二次", "req-fallback2")
        assert "model_notice" not in [name for name, _ in second]
        assert [model for kind, model, _ in sink if kind == "chat"] == [GEMINI, GEMINI]
    finally:
        client.__exit__(None, None, None)


def test_switch_is_rejected_while_a_reply_is_generating(tmp_path):
    library, keys = library_of()
    client = attach(tmp_path, library, lambda settings: BoundChat(settings, []))
    try:
        conversation = client.post("/api/conversations", json={}).json()
        client.app.state.chat_service.active[conversation["id"]] = Generation(conversation["id"], "u", "a")
        response = client.put(f"/api/conversations/{conversation['id']}/model", json={"model_key": keys["flash"]})
        assert response.status_code == 409 and "生成" in response.json()["detail"]
        assert client.get(f"/api/conversations/{conversation['id']}").json()["model_key"] is None
        del client.app.state.chat_service.active[conversation["id"]]
        assert client.put(f"/api/conversations/{conversation['id']}/model", json={"model_key": keys["flash"]}).status_code == 200
    finally:
        client.__exit__(None, None, None)


def test_suggest_reply_uses_the_memory_model(tmp_path):
    library, keys = library_of()
    seen = []

    class SuggestChat(BoundChat):
        async def stream(self, messages, tools=None):
            seen.append(self.settings.llm_model)
            yield "text", "好，我们先从栈顶这一个位置开始，结合叠盘子的例子讲讲后进先出。"
            yield "finish", "stop"

    client = attach(tmp_path, library, lambda settings: SuggestChat(settings, []))
    try:
        conversation = client.post("/api/conversations", json={}).json()
        client.put(f"/api/conversations/{conversation['id']}/model", json={"model_key": keys["gemini"]})
        send(client, conversation["id"], "栈是什么", "req-suggest1")
        body = client.get(f"/api/conversations/{conversation['id']}/suggest-reply").json()
        assert seen == [GEMINI, MEMORY]
        assert body["suggestion"].startswith("好，我们先从栈顶")
    finally:
        client.__exit__(None, None, None)


def test_switched_provider_strips_private_tool_history(tmp_path):
    library, keys = library_of()
    library.service_models = ServiceModelSelection()
    captured = []

    def handler(request):
        body = json.loads(request.content)
        captured.append((str(request.url), body))
        path = request.url.path
        if path.endswith(":generateContent"):
            packet = {"candidates": [{"content": {"parts": [{"text": "{}"}]}, "finishReason": "STOP"}]}
            return httpx.Response(200, json=packet)
        if path.endswith(":streamGenerateContent"):
            packet = {"candidates": [{"content": {"parts": [{"text": "好"}]}, "finishReason": "STOP"}]}
            return httpx.Response(200, json=packet)
        return httpx.Response(200, json={
            "choices": [{"message": {"content": "好"}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 4, "completion_tokens": 1},
        })

    transport = httpx.MockTransport(handler)
    client = attach(tmp_path, library, lambda settings: ChatCompletionsChat(settings, transport))
    try:
        store = client.app.state.chat_service.store
        gemini_id = client.post("/api/conversations", json={}).json()["id"]
        openai_id = client.post("/api/conversations", json={}).json()["id"]
        signature = "opaque-signature"
        with store.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            store._insert(db, gemini_id, role="user", kind="text", content="第一问", status="complete")
            store._insert(db, gemini_id, role="assistant", kind="text", content="第一答", status="complete", meta={
                "tool_messages": [
                    {"role": "assistant", "content": "", "tool_calls": [{
                        "id": "call-g", "type": "function",
                        "function": {"name": "agenda_list", "arguments": "{}"},
                        "gemini_part": {"functionCall": {"name": "agenda_list", "args": {}, "id": "native-1"},
                                        "thoughtSignature": signature},
                    }]},
                    {"role": "tool", "tool_call_id": "call-g", "content": "{\"tasks\":[]}"},
                ],
            })
            store._insert(db, openai_id, role="user", kind="text", content="开放问", status="complete")
            store._insert(db, openai_id, role="assistant", kind="text", content="开放答", status="complete", meta={
                "tool_messages": [
                    {"role": "assistant", "content": "", "tool_calls": [{
                        "id": "call-o", "type": "function",
                        "function": {"name": "agenda_list", "arguments": "{\"status\":\"done\"}"},
                    }]},
                    {"role": "tool", "tool_call_id": "call-o", "content": "{\"tasks\":[]}"},
                ],
            })
        client.put(f"/api/conversations/{gemini_id}/model", json={"model_key": keys["flash"]})
        client.put(f"/api/conversations/{openai_id}/model", json={"model_key": keys["gemini"]})
        send(client, gemini_id, "第二问", "req-wire-gem1")
        send(client, openai_id, "再问一次", "req-wire-oa01")
        dumped = [(url, json.dumps(body, ensure_ascii=False)) for url, body in captured]
        openai_hits = [text for url, text in dumped if "/chat/completions" in url and "第一问" in text]
        assert openai_hits and all(signature not in text and "gemini_part" not in text and "thoughtSignature" not in text for text in openai_hits)
        assert any(body.get("model") == FLASH and "第一答" in json.dumps(body, ensure_ascii=False)
                   for url, body in captured if "/chat/completions" in url)
        vertex_hits = [text for url, text in dumped if "streamGenerateContent" in url and "开放问" in text]
        assert vertex_hits and all("skip_thought_signature_validator" in text and "gemini_part" not in text for text in vertex_hits)
        assert all("gemini_part" not in text for _, text in dumped)
    finally:
        client.__exit__(None, None, None)


def test_old_database_gains_a_null_model_key(tmp_path):
    settings = isolated_settings(tmp_path)
    path = settings.resolved_database_path()
    path.parent.mkdir(parents=True, exist_ok=True)
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
    """)
    db.close()
    chat_store = None
    for _ in range(2):
        with TestClient(create_app(settings, chat_model=FakeChat())) as client:
            body = client.get("/api/conversations/conv-old").json()
            assert body["title"] == "旧对话" and body["model_key"] is None
            chat_store = client.app.state.chat_service.store
    with chat_store.connection() as db:
        names = {row["name"] for row in db.execute("PRAGMA table_info(conversations)")}
    assert "model_key" in names and "model_notice_key" in names
    assert chat_store.set_conversation_model("conv-old", "demo-student-001", "prov-11111111/deepseek-flash")
    assert chat_store.conversation("conv-old", "demo-student-001").model_key == "prov-11111111/deepseek-flash"


def test_service_roles_prefer_library_refs(tmp_path):
    library, keys = library_of()
    library.service_models = ServiceModelSelection(logic=keys["flash"], vision=keys["gemini"], memory=keys["memory"])
    ai = AISettings(isolated_settings(tmp_path))
    env = VisionConfig(base_url="https://env.example/v1", model="env-vision", api_key=SecretStr("synthetic-env-key"), source="env")
    models = ServiceModels(ai, env=env, library=library)
    logic, source = models.logic_settings()
    assert source == "service_models" and logic.llm_model == FLASH and logic.llm_base_url == DEEPSEEK
    vision = models.vision_config()
    assert vision.source == "service_models" and vision.model == GEMINI and vision.base_url == VERTEX
    public = models.public()
    assert public["memory_model"]["effective"] == {"model": MEMORY, "source": "service_models"}
    assert SECRET not in json.dumps(public, ensure_ascii=False)
    library.service_models = ServiceModelSelection()
    assert models.vision_config().model == "env-vision" and models.vision_config().source == "env"
    assert models.logic_settings()[1] == "global"

    class ViaGetter:
        def get_service(self):
            return ServiceModelSelection(logic=keys["flash"])

        def effective_key(self, key):
            return library.effective_key(key)

        def service_settings(self, role):
            return library.service_settings(role)

    library.service_models = ServiceModelSelection(logic=keys["flash"])
    wrapped = ServiceModels(ai, env=env, library=ViaGetter())
    assert wrapped.logic_settings()[0].llm_model == FLASH

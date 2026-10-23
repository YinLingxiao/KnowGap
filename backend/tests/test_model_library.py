import json
import logging

import httpx
import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr

from app.agents.llm import ProviderError
from app.agents.vertex_config import adc_base_url
from app.config import Settings
from app.main import create_app
from app.models.model_library_schemas import (
    NO_MODEL_DETAIL, URL_KEY_RESET_DETAIL, ModelCreate, ModelLibraryFile, ModelUpdate, Provider, ProviderCreate,
    ProviderUpdate, ServiceModelSelection,
)
from app.models.schemas import TutorOutput
from app.services.model_library import ModelLibrary

SECRET = "synthetic-model-library-key"
PROJECT = "knowgap-adc-test"


def settings(tmp_path, **kwargs):
    values = {"llm_api_key": "", "llm_base_url": "", "llm_model": ""}
    values.update(kwargs)
    return Settings(_env_file=None, database_path=tmp_path / "data" / "test.sqlite3", **values)


def library_path(tmp_path):
    return tmp_path / "data" / "model-library.json"


def test_crud_secrets_refs_and_selector(tmp_path):
    with TestClient(create_app(settings(tmp_path))) as client:
        created = client.post("/api/models/providers", json={
            "name": "DeepSeek", "preset": "deepseek", "base_url": "https://api.deepseek.com/v1/",
            "auth_mode": "api_key", "api_key": SECRET,
        })
        assert created.status_code == 200, created.text
        assert SECRET not in created.text and "api_key" not in created.json()
        assert created.json()["has_api_key"] is True and created.json()["base_url"] == "https://api.deepseek.com/v1"
        provider_id = created.json()["id"]
        other = client.post("/api/models/providers", json={
            "name": "Other", "preset": "custom", "base_url": "https://other.example/v1",
            "auth_mode": "api_key", "api_key": "synthetic-other-key",
        }).json()
        flash = client.post(f"/api/models/providers/{provider_id}/models", json={"id": "deepseek-flash"})
        assert flash.status_code == 200, flash.text
        assert flash.json()["tags"] == {"reasoning": "none", "vision": False, "tools": False, "label": None}
        slash = "google/gemini-3.5-flash"
        assert client.post(f"/api/models/providers/{provider_id}/models", json={
            "id": slash, "name": "Gemini", "tags": {"reasoning": "low", "vision": True, "tools": True, "label": "新"},
        }).status_code == 200
        assert client.post(f"/api/models/providers/{other['id']}/models", json={"id": "other-model"}).status_code == 200
        assert client.post(f"/api/models/providers/{provider_id}/models", json={"id": "deepseek-flash"}).status_code == 409
        patched = client.patch(f"/api/models/providers/{provider_id}/models/{slash}", json={
            "tags": {"vision": False, "label": None},
        })
        assert patched.json()["tags"] == {"reasoning": "low", "vision": False, "tools": True, "label": None}
        flash_key = f"{provider_id}/deepseek-flash"
        slash_key = f"{provider_id}/{slash}"
        other_key = f"{other['id']}/other-model"
        assert client.put("/api/models/default", json={"key": flash_key}).json()["key"] == flash_key
        assert client.put("/api/models/service", json={
            "logic": slash_key, "vision": other_key, "memory": None,
        }).json() == {"logic": slash_key, "vision": other_key, "memory": None}
        listed = client.get("/api/models").json()
        assert {item["key"] for item in listed} == {flash_key, slash_key, other_key}
        assert next(item for item in listed if item["key"] == flash_key)["is_default"] is True
        assert SECRET not in client.get("/api/models/providers").text
        assert client.get("/api/models/providers").headers["cache-control"] == "no-store"
        removed = client.delete(f"/api/models/providers/{provider_id}/models/{slash}")
        assert removed.json()["affected"] == {"default_model": False, "service_models": ["logic"]}
        assert client.get("/api/models/service").json()["logic"] is None
        assert client.get("/api/models/default").json()["key"] == flash_key
        gone = client.delete(f"/api/models/providers/{other['id']}")
        assert gone.json()["affected"] == {"default_model": False, "service_models": ["vision"]}
        assert client.get("/api/models/service").json() == {"logic": None, "vision": None, "memory": None}
        cleared = client.delete(f"/api/models/providers/{provider_id}")
        assert cleared.json()["affected"]["default_model"] is True
        assert client.get("/api/models").json() == []
        assert client.get("/api/models/default").json()["key"] is None
        stored = json.loads(library_path(tmp_path).read_text(encoding="utf-8"))
        assert stored["providers"] == [] and SECRET not in library_path(tmp_path).read_text(encoding="utf-8")
        assert list(library_path(tmp_path).parent.glob(".model-library-*")) == []


def test_url_change_requires_a_new_key_and_errors_hide_it(tmp_path):
    with TestClient(create_app(settings(tmp_path))) as client:
        provider_id = client.post("/api/models/providers", json={
            "name": "DeepSeek", "preset": "deepseek", "base_url": "https://api.deepseek.com/v1",
            "auth_mode": "api_key", "api_key": SECRET,
        }).json()["id"]
        changed = client.patch(f"/api/models/providers/{provider_id}", json={"base_url": "https://other.example/v1"})
        assert changed.status_code == 422 and changed.json()["detail"] == URL_KEY_RESET_DETAIL
        assert SECRET not in changed.text
        kept = json.loads(library_path(tmp_path).read_text(encoding="utf-8"))
        assert kept["providers"][0]["api_key"] == SECRET
        renamed = client.patch(f"/api/models/providers/{provider_id}", json={"name": "Renamed", "api_key": None})
        assert renamed.status_code == 200 and renamed.json()["name"] == "Renamed"
        assert json.loads(library_path(tmp_path).read_text(encoding="utf-8"))["providers"][0]["api_key"] == SECRET
        malformed = client.post(
            "/api/models/providers", content='{"api_key":"' + SECRET,
            headers={"Content-Type": "application/json"},
        )
        assert malformed.status_code == 422 and malformed.json()["detail"] == "模型库请求格式无效。"
        assert SECRET not in malformed.text
        assert client.get("/api/models/providers", headers={"Origin": "https://evil.example"}).status_code == 403
    with TestClient(create_app(settings(tmp_path)), client=("192.0.2.1", 50000)) as remote:
        assert remote.get("/api/models/providers").status_code == 403


def test_adc_and_chatgpt_do_not_store_a_key(tmp_path):
    base = adc_base_url(PROJECT, "global")
    with TestClient(create_app(settings(tmp_path))) as client:
        adc = client.post("/api/models/providers", json={
            "name": "Vertex", "preset": "vertex", "base_url": base, "auth_mode": "adc",
            "project_id": PROJECT, "location": "global", "api_key": SECRET,
        })
        assert adc.status_code == 200, adc.text
        assert adc.json()["has_api_key"] is False and SECRET not in adc.text
        chat = client.post("/api/models/providers", json={
            "name": "ChatGPT", "preset": "chatgpt", "base_url": "https://api.openai.com/v1",
            "auth_mode": "chatgpt", "api_key": SECRET,
        })
        assert chat.status_code == 200 and chat.json()["has_api_key"] is False
        rejected = client.post("/api/models/providers", json={
            "name": "ChatGPT", "preset": "chatgpt", "base_url": "https://evil.example/v1",
            "auth_mode": "chatgpt", "api_key": SECRET,
        })
        assert rejected.status_code == 422 and SECRET not in rejected.text
        stored = library_path(tmp_path).read_text(encoding="utf-8")
        assert SECRET not in stored
        assert json.loads(stored)["providers"][0]["api_key"] == ""
        assert json.loads(stored)["providers"][1]["api_key"] == ""


FETCH_PADDING = 296


def test_fetch_filters_guesses_and_hides_upstream_bodies(monkeypatch, tmp_path, caplog):
    caplog.set_level(logging.WARNING)
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["auth"] = request.headers.get("authorization")
        if request.url.host == "boom.example":
            return httpx.Response(500, text=SECRET + " upstream")
        rows = [{"id": "deepseek-chat"}, {"id": "deepseek-reasoner"}, {"id": "text-embedding-3-small"},
                {"id": "tts-1"}, {"id": "whisper-1"}, {"id": "dall-e-3"}, {"id": "gpt-4o-mini"},
                {"id": "gemini-2.5-pro"}]
        rows.extend({"id": f"gpt-extra-{index}"} for index in range(FETCH_PADDING))
        return httpx.Response(200, json={"data": rows})

    transport = httpx.MockTransport(handler)
    real = httpx.Client

    def factory(*args, **kwargs):
        kwargs["transport"] = transport
        return real(*args, **kwargs)

    monkeypatch.setattr("app.services.model_library.httpx.Client", factory)
    with TestClient(create_app(settings(tmp_path))) as client:
        provider_id = client.post("/api/models/providers", json={
            "name": "DeepSeek", "preset": "deepseek", "base_url": "https://api.deepseek.com/v1",
            "auth_mode": "api_key", "api_key": SECRET,
        }).json()["id"]
        fetched = client.post(f"/api/models/providers/{provider_id}/fetch")
        assert fetched.status_code == 200, fetched.text
        assert captured["auth"] == f"Bearer {SECRET}"
        by_id = {item["id"]: item["tags"] for item in fetched.json()}
        assert "text-embedding-3-small" not in by_id and "tts-1" not in by_id
        assert "whisper-1" not in by_id and "dall-e-3" not in by_id
        assert by_id["deepseek-chat"] == {"reasoning": "none", "vision": False, "tools": True, "label": None}
        assert by_id["deepseek-reasoner"]["reasoning"] == "high"
        assert by_id["gpt-4o-mini"]["vision"] is True and by_id["gemini-2.5-pro"]["label"] == "Pro"
        assert len(fetched.json()) == 300
        assert client.get(f"/api/models/providers").json()[0]["models"] == []
        boom = client.post("/api/models/providers", json={
            "name": "Boom", "preset": "custom", "base_url": "https://boom.example/v1",
            "auth_mode": "api_key", "api_key": SECRET,
        }).json()["id"]
        failed = client.post(f"/api/models/providers/{boom}/fetch")
        assert failed.status_code == 502 and SECRET not in failed.text and "upstream" not in failed.text
        assert SECRET not in caplog.text
        vertex = client.post("/api/models/providers", json={
            "name": "Vertex", "preset": "vertex", "base_url": adc_base_url(PROJECT, "global"),
            "auth_mode": "adc", "project_id": PROJECT, "location": "global",
        }).json()["id"]

        def explode(*args, **kwargs):
            raise AssertionError("vertex fetch must not call the network")

        monkeypatch.setattr("app.services.model_library.httpx.Client", explode)
        builtin = client.post(f"/api/models/providers/{vertex}/fetch")
        assert builtin.status_code == 200 and builtin.json()[0]["id"] == "gemini-4-argon"
        client.app.state.model_library.chatgpt = type("Auth", (), {"models": lambda self: [
            {"id": "gpt-6.1-sol", "name": "Sol"}, {"id": "whisper-1", "name": "skip"},
        ]})()
        chat = client.post("/api/models/providers", json={
            "name": "ChatGPT", "preset": "chatgpt", "base_url": "https://api.openai.com/v1", "auth_mode": "chatgpt",
        }).json()["id"]
        listed = client.post(f"/api/models/providers/{chat}/fetch")
        assert [item["id"] for item in listed.json()] == ["gpt-6.1-sol"]


def test_model_probe_uses_the_selected_provider(monkeypatch, tmp_path):
    seen = []

    def generate(self, context):
        async def result():
            seen.append(self.settings.llm_model)
            return TutorOutput(assessment="correct", issue=None, confidence=0.9,
                               evidence=context["current_answer"], reply="正确。")
        return result()

    monkeypatch.setattr("app.agents.llm.ChatCompletionsTutor.generate", generate)
    with TestClient(create_app(settings(tmp_path))) as client:
        provider_id = client.post("/api/models/providers", json={
            "name": "DeepSeek", "preset": "deepseek", "base_url": "https://api.deepseek.com/v1",
            "auth_mode": "api_key", "api_key": SECRET,
        }).json()["id"]
        response = client.post(f"/api/models/providers/{provider_id}/test", json={"model_id": "deepseek-flash"})
        assert response.json() == {"status": "ok", "model": "deepseek-flash", "structured_output": True}
        assert seen == ["deepseek-flash"]
        assert client.get("/api/models/providers").json()[0]["models"] == []


def test_resolve_falls_back_until_nothing_is_usable(tmp_path):
    library = ModelLibrary(settings(tmp_path))
    primary = library.create_provider(provider_body("DeepSeek", "deepseek", "https://api.deepseek.com/v1"))
    other = library.create_provider(provider_body("Other", "custom", "https://other.example/v1", "synthetic-other-key"))
    flash = "google/gemini-3.5-flash"
    library.create_model(primary.id, ModelCreate(id=flash, name="Gemini"))
    library.create_model(primary.id, ModelCreate(id="gemini-lite", name="lite"))
    library.update_model(primary.id, "gemini-lite", ModelUpdate(enabled=False))
    library.create_model(other.id, ModelCreate(id="other-model", name="other"))
    default = library.set_default(f"{primary.id}/{flash}")
    assert library.resolve(None).llm_model == flash
    assert library.resolve(None).llm_api_key.get_secret_value() == SECRET
    assert library.effective_key(f"{primary.id}/gemini-lite") == default
    assert library.effective_key(f"{primary.id}/missing") == default
    library.set_service(ServiceModelSelection(vision=f"{other.id}/other-model"))
    assert library.service_settings("vision").llm_model == "other-model"
    assert library.service_settings("logic").llm_model == flash
    assert library.service_settings("memory").llm_model == flash
    library.set_default(f"{other.id}/other-model")
    library.update_provider(primary.id, ProviderUpdate(enabled=False))
    assert library.resolve(default).llm_model == "other-model"
    library.update_provider(other.id, ProviderUpdate(enabled=False))
    with pytest.raises(ProviderError) as raised:
        library.resolve(None)
    assert raised.value.status_code == 503 and raised.value.detail == NO_MODEL_DETAIL
    assert library.effective_key(None) is None
    with pytest.raises(ProviderError) as bad_role:
        library.service_settings("nope")
    assert bad_role.value.status_code == 422


def provider_body(name, preset, base_url, api_key=SECRET):
    return ProviderCreate(name=name, preset=preset, base_url=base_url, auth_mode="api_key", api_key=SecretStr(api_key))


def test_migration_from_legacy_file_only(tmp_path):
    data = tmp_path / "data"
    data.mkdir()
    legacy = data / "ai-settings.json"
    legacy.write_text(json.dumps({
        "base_url": "https://api.deepseek.com/v1", "model": "deepseek-flash",
        "api_key": "synthetic-file-key", "workspace": str(tmp_path),
    }, ensure_ascii=False), encoding="utf-8")
    before = legacy.read_bytes()
    library = ModelLibrary(settings(tmp_path))
    assert legacy.read_bytes() == before
    stored = json.loads(library_path(tmp_path).read_text(encoding="utf-8"))
    assert stored["version"] == 1
    assert stored["providers"][0]["preset"] == "deepseek"
    assert stored["providers"][0]["api_key"] == "synthetic-file-key"
    assert stored["providers"][0]["models"][0]["id"] == "deepseek-flash"
    assert stored["default_model"].endswith("/deepseek-flash")
    assert stored["service_models"] == {"logic": None, "vision": None, "memory": None}
    assert "workspace" not in json.dumps(stored)


def test_migration_carries_legacy_service_models_into_the_library(tmp_path):
    data = tmp_path / "data"
    data.mkdir()
    (data / "ai-settings.json").write_text(json.dumps({
        "base_url": "https://api.deepseek.com/v1", "model": "deepseek-chat", "api_key": "synthetic-main-key",
        "service_models": {
            "logic_model": {"base_url": "", "model": "deepseek-reasoner", "api_key": ""},
            "vision_model": {
                "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1", "model": "qwen-vl-max",
                "api_key": "synthetic-vision-key", "enabled": True,
            },
            "memory_model": {"model": "deepseek-chat", "enabled": True},
        },
    }, ensure_ascii=False), encoding="utf-8")
    library = ModelLibrary(settings(tmp_path))
    stored = json.loads(library_path(tmp_path).read_text(encoding="utf-8"))
    names = {item["base_url"]: item for item in stored["providers"]}
    main = names["https://api.deepseek.com/v1"]
    vision = names["https://dashscope.aliyuncs.com/compatible-mode/v1"]
    assert vision["api_key"] == "synthetic-vision-key"
    assert [item["id"] for item in vision["models"]] == ["qwen-vl-max"] and vision["models"][0]["tags"]["vision"] is True
    assert {item["id"] for item in main["models"]} == {"deepseek-chat", "deepseek-reasoner"}
    assert stored["service_models"] == {
        "logic": f"{main['id']}/deepseek-reasoner", "vision": f"{vision['id']}/qwen-vl-max", "memory": None,
    }
    assert library.service_settings("vision").llm_model == "qwen-vl-max"
    assert library.service_settings("vision").llm_api_key.get_secret_value() == "synthetic-vision-key"


def test_migration_ignores_disabled_legacy_vision_and_memory(tmp_path):
    data = tmp_path / "data"
    data.mkdir()
    (data / "ai-settings.json").write_text(json.dumps({
        "base_url": "https://api.deepseek.com/v1", "model": "deepseek-chat", "api_key": "synthetic-main-key",
        "service_models": {
            "vision_model": {
                "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1", "model": "qwen-vl-max",
                "api_key": "synthetic-vision-key", "enabled": False,
            },
            "memory_model": {"model": "deepseek-reasoner", "enabled": False},
        },
    }), encoding="utf-8")
    ModelLibrary(settings(tmp_path))
    stored = json.loads(library_path(tmp_path).read_text(encoding="utf-8"))
    assert len(stored["providers"]) == 1
    assert stored["service_models"] == {"logic": None, "vision": None, "memory": None}


def test_migration_from_env_only(tmp_path):
    library = ModelLibrary(settings(
        tmp_path, llm_base_url="https://api.deepseek.com/v1", llm_model="deepseek-flash",
        llm_api_key="synthetic-env-key",
    ))
    assert not (tmp_path / "data" / "ai-settings.json").exists()
    stored = json.loads(library_path(tmp_path).read_text(encoding="utf-8"))
    assert stored["providers"][0]["api_key"] == "synthetic-env-key"
    assert stored["providers"][0]["preset"] == "deepseek"
    assert library.resolve(None).llm_model == "deepseek-flash"
    with TestClient(create_app(settings(
        tmp_path, llm_base_url="https://api.deepseek.com/v1", llm_model="deepseek-flash",
        llm_api_key="synthetic-env-key",
    ))) as client:
        body = client.get("/api/ai/config").json()
        assert body["model"] == "deepseek-flash" and body["configured"] is True and body["has_api_key"] is True
        assert "synthetic-env-key" not in client.get("/api/ai/config").text


def test_migration_when_nothing_is_configured(tmp_path):
    library = ModelLibrary(settings(tmp_path))
    assert not library_path(tmp_path).exists()
    assert library.effective_key(None) is None
    with pytest.raises(ProviderError) as raised:
        library.resolve(None)
    assert raised.value.detail == NO_MODEL_DETAIL


def test_existing_library_is_not_rebuilt_from_legacy_settings(tmp_path):
    data = tmp_path / "data"
    data.mkdir()
    provider = Provider(
        id="prov-abcdef12", name="Kept", preset="custom", base_url="https://kept.example/v1",
        auth_mode="api_key", api_key=SecretStr("synthetic-kept-key"),
        models=[{"id": "kept-model", "name": "kept-model", "enabled": True, "tags": {}}],
    )
    path = library_path(tmp_path)
    path.write_text(json.dumps(ModelLibraryFile(
        providers=[provider], default_model="prov-abcdef12/kept-model",
    ).dump_stored(), ensure_ascii=False), encoding="utf-8")
    before = path.read_bytes()
    legacy = data / "ai-settings.json"
    legacy.write_text(json.dumps({
        "base_url": "https://old.example/v1", "model": "old-model", "api_key": "synthetic-old-key",
    }), encoding="utf-8")
    legacy_before = legacy.read_bytes()
    library = ModelLibrary(settings(
        tmp_path, llm_base_url="https://api.deepseek.com/v1", llm_model="deepseek-flash",
        llm_api_key="synthetic-env-key",
    ))
    assert path.read_bytes() == before
    assert legacy.read_bytes() == legacy_before
    assert library.resolve(None).llm_model == "kept-model"
    assert library.resolve(None).llm_api_key.get_secret_value() == "synthetic-kept-key"


def test_corrupt_library_is_not_overwritten(tmp_path):
    data = tmp_path / "data"
    data.mkdir()
    path = library_path(tmp_path)
    path.write_text("{", encoding="utf-8")
    with pytest.raises(RuntimeError, match="模型库"):
        ModelLibrary(settings(tmp_path))
    assert path.read_text(encoding="utf-8") == "{"


def test_legacy_config_still_reads_and_writes_the_default_provider(tmp_path):
    config = settings(tmp_path)
    with TestClient(create_app(config)) as client:
        assert client.put("/api/agent/settings", json={"workspace": str(tmp_path)}).status_code == 200
        saved = client.put("/api/ai/config", json={
            "base_url": "https://provider.example/v1/", "model": "tutor", "api_key": SECRET,
        })
        assert saved.status_code == 200 and SECRET not in saved.text
        assert saved.json()["model"] == "tutor" and saved.json()["has_api_key"] is True
        providers = client.get("/api/models/providers").json()
        assert len(providers) == 1 and providers[0]["models"][0]["id"] == "tutor"
        assert SECRET not in client.get("/api/models/providers").text
        assert client.put("/api/ai/config", json={
            "base_url": "https://provider.example/v1", "model": "next", "api_key": "",
        }).status_code == 200
        assert len(client.get("/api/models/providers").json()) == 1
        assert client.get("/api/models").json()[0]["model_id"] == "next"
        assert client.put("/api/ai/config", json={
            "base_url": "https://different.example/v1", "model": "next", "api_key": "",
        }).status_code == 422
        assert client.get("/api/agent/settings").json()["workspace"] == str(tmp_path)
    with TestClient(create_app(config)) as client:
        assert client.get("/api/ai/config").json()["model"] == "next"
        assert client.app.state.tutor.settings.llm_api_key.get_secret_value() == SECRET
        raw = json.loads(library_path(tmp_path).read_text(encoding="utf-8"))
        assert raw["providers"][0]["api_key"] == SECRET
        assert SECRET not in client.get("/api/ai/config").text


def test_vertex_express_preset_requires_the_native_root(tmp_path):
    native = "https://aiplatform.googleapis.com/v1/publishers/google/models"
    with TestClient(create_app(settings(tmp_path))) as client:
        wrong = client.post("/api/models/providers", json={
            "name": "Vertex", "preset": "vertex", "base_url": "https://aiplatform.googleapis.com",
            "auth_mode": "api_key", "api_key": SECRET,
        })
        assert wrong.status_code == 422 and SECRET not in wrong.text and "aiplatform.googleapis.com/v1/publishers" in wrong.text
        ok = client.post("/api/models/providers", json={
            "name": "Vertex", "preset": "vertex", "base_url": native, "auth_mode": "api_key", "api_key": SECRET,
        })
        assert ok.status_code == 200, ok.text
        broken = client.patch(f"/api/models/providers/{ok.json()['id']}", json={
            "base_url": "https://aiplatform.googleapis.com/v1/chat", "api_key": SECRET,
        })
        assert broken.status_code == 422 and SECRET not in broken.text
        assert client.get("/api/models/providers").json()[0]["base_url"] == native

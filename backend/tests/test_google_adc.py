"""ADC tests use synthetic credentials only; never discover the developer's real ADC."""

import asyncio
from datetime import datetime, timedelta, timezone
import json
import threading

import google.auth
from google.auth.exceptions import DefaultCredentialsError
from google.oauth2.credentials import Credentials
import httpx
import pytest
from fastapi.testclient import TestClient

from app.agents.llm import ChatCompletionsChat, ProviderError, is_vertex_native
from app.agents.vertex_config import adc_base_url
from app.main import create_app
from app.services.ai_settings import AISettings
from app.services.google_adc import _session, adc_headers
from app.vision.settings import ServiceModels, VisionConfig
from tests.test_acceptance_support import isolated_settings

PROJECT = "knowgap-adc-test"
BASE = adc_base_url(PROJECT, "global")
BODY = {"base_url": BASE, "model": "gemini-4-argon", "auth_mode": "adc", "project_id": PROJECT, "location": "global"}


@pytest.fixture(autouse=True)
def isolate_adc(monkeypatch):
    _session.cache_clear()
    def missing(**kwargs):
        raise DefaultCredentialsError("synthetic-private-token-and-path")
    monkeypatch.setattr(google.auth, "default", missing)
    yield
    _session.cache_clear()


def install_credentials(monkeypatch):
    credentials = Credentials(token=None, quota_project_id=PROJECT)
    refreshes, discoveries = [], []
    main_thread = threading.get_ident()
    def refresh(request):
        assert threading.get_ident() != main_thread
        refreshes.append(True)
        credentials.token = f"synthetic-access-token-{len(refreshes)}"
        credentials.expiry = datetime.now(timezone.utc).replace(tzinfo=None) + timedelta(hours=1)
    def default(**kwargs):
        assert kwargs["scopes"] == ["https://www.googleapis.com/auth/cloud-platform"]
        assert kwargs["quota_project_id"] == PROJECT
        discoveries.append(True)
        return credentials, PROJECT
    monkeypatch.setattr(credentials, "refresh", refresh)
    monkeypatch.setattr(google.auth, "default", default)
    return credentials, refreshes, discoveries


def test_adc_save_restart_does_not_read_credentials_or_store_tokens(tmp_path):
    settings = isolated_settings(tmp_path)
    with TestClient(create_app(settings)) as client:
        response = client.put("/api/ai/config", json={**BODY, "api_key": "do-not-persist-this"})
        assert response.status_code == 200, response.text
        result = response.json()
        assert result["configured"] and not result["has_api_key"]
        assert result["auth_mode"] == "adc" and result["project_id"] == PROJECT
        assert "do-not-persist-this" not in response.text
    path = settings.resolved_database_path().parent / "ai-settings.json"
    raw = path.read_text(encoding="utf-8")
    assert "do-not-persist-this" not in raw and json.loads(raw)["api_key"] == ""
    with TestClient(create_app(settings)) as client:
        assert client.get("/api/ai/config").json() == result
        assert client.app.state.tutor.settings.llm_api_key.get_secret_value() == ""


@pytest.mark.parametrize("patch", [
    {"base_url": "https://evil.example/v1"}, {"base_url": BASE + "?key=private"},
    {"base_url": BASE.replace("https:", "http:")}, {"project_id": "../private"},
    {"project_id": ""}, {"location": "global/../../evil"}, {"location": ""},
    {"base_url": BASE.replace("aiplatform", "us-central1-aiplatform")},
    {"base_url": "https://aiplatform.googleapis.com/v1/publishers/google/models"},
])
def test_adc_rejects_untrusted_or_inconsistent_endpoints(tmp_path, patch):
    with TestClient(create_app(isolated_settings(tmp_path))) as client:
        response = client.put("/api/ai/config", json={**BODY, **patch})
        assert response.status_code == 422
        assert not client.get("/api/ai/config").json()["configured"]


def test_api_key_mode_remains_default_and_switching_does_not_reuse_credentials(tmp_path):
    ai = AISettings(isolated_settings(tmp_path))
    api = {"base_url": "https://aiplatform.googleapis.com/v1/publishers/google/models", "model": "gemini-4-argon", "api_key": "synthetic-key"}
    assert ai.save(api)["auth_mode"] == "api_key"
    assert ai.save({**api, "api_key": ""})["has_api_key"]
    assert ai.save(BODY)["configured"]
    assert ai.current.llm_auth_mode == "adc" and not ai.current.llm_api_key.get_secret_value()
    from fastapi import HTTPException
    with pytest.raises(HTTPException):
        ai.candidate({**api, "api_key": ""})
    assert ai.save(api)["auth_mode"] == "api_key"
    assert ai.current.llm_project_id == ""


def test_adc_refreshes_once_under_concurrency_then_renews_expired_token(monkeypatch):
    creds, refreshes, discoveries = install_credentials(monkeypatch)
    async def run():
        first = await asyncio.gather(*[adc_headers(PROJECT, BASE + "/gemini-4-argon:generateContent") for _ in range(6)])
        assert all(headers["authorization"] == "Bearer synthetic-access-token-1" for headers in first)
        assert all(headers["x-goog-user-project"] == PROJECT for headers in first)
        creds.expiry = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(seconds=1)
        return await adc_headers(PROJECT, BASE + "/gemini-4-argon:generateContent")
    assert asyncio.run(run())["authorization"] == "Bearer synthetic-access-token-2"
    assert len(refreshes) == 2 and len(discoveries) == 1


def test_missing_adc_is_readable_redacted_and_can_recover_after_login(monkeypatch):
    with pytest.raises(ProviderError) as error:
        asyncio.run(adc_headers(PROJECT, BASE))
    assert "gcloud auth application-default login" in error.value.detail
    assert "synthetic-private" not in error.value.detail
    install_credentials(monkeypatch)
    assert asyncio.run(adc_headers(PROJECT, BASE))["authorization"].startswith("Bearer ")


@pytest.mark.parametrize("streaming", [False, True])
def test_adc_native_requests_use_bearer_not_api_key(tmp_path, monkeypatch, streaming):
    install_credentials(monkeypatch)
    settings = AISettings(isolated_settings(tmp_path)).candidate(BODY)
    def handler(request):
        assert request.url.host == "aiplatform.googleapis.com"
        assert request.url.path.startswith(f"/v1/projects/{PROJECT}/locations/global/publishers/google/models/")
        assert request.headers["authorization"] == "Bearer synthetic-access-token-1"
        assert request.headers["x-goog-user-project"] == PROJECT
        assert "x-goog-api-key" not in request.headers
        packet = {"candidates": [{"content": {"parts": [{"text": '{"ok":true}'}]}, "finishReason": "STOP"}]}
        if streaming:
            return httpx.Response(200, text=f"data: {json.dumps(packet)}\n\n", headers={"content-type": "text/event-stream"})
        return httpx.Response(200, json=packet)
    model = ChatCompletionsChat(settings, httpx.MockTransport(handler))
    async def run():
        if streaming:
            return [item async for item in model.stream([{"role": "user", "content": "hi"}])]
        return await model.complete_json([{"role": "user", "content": "hi"}])
    result = asyncio.run(run())
    assert ("finish", "stop") in result if streaming else result == {"ok": True}


def test_adc_connection_probe_never_saves_and_explains_missing_credentials(tmp_path):
    with TestClient(create_app(isolated_settings(tmp_path))) as client:
        response = client.post("/api/ai/test", json=BODY)
        assert response.status_code == 503
        assert "gcloud auth application-default login" in response.text
        assert "synthetic-private" not in response.text
        assert not client.get("/api/ai/config").json()["configured"]


def test_project_and_region_roots_and_inherited_service_settings(tmp_path):
    regional = adc_base_url(PROJECT, "us-central1")
    assert regional.startswith("https://us-central1-aiplatform.googleapis.com/") and "/locations/us-central1/" in regional
    assert is_vertex_native(BASE) and is_vertex_native(regional)
    ai = AISettings(isolated_settings(tmp_path))
    ai.save(BODY)
    models = ServiceModels(ai, env=VisionConfig())
    assert models.logic_settings()[0].llm_auth_mode == "adc"
    assert models.public()["logic_model"]["effective"]["configured"]
    assert models.vision_config().auth_mode == "adc" and models.vision_config().configured
    models.save({"logic_model": {"base_url": "https://other.example/v1", "model": "other", "api_key": "synthetic-other"}})
    assert models.logic_settings()[0].llm_auth_mode == "api_key"
    assert models.logic_settings()[0].llm_project_id == ""


def test_adc_permission_failure_does_not_fall_back_to_api_key(tmp_path, monkeypatch):
    install_credentials(monkeypatch)
    settings = AISettings(isolated_settings(tmp_path)).candidate(BODY)
    requests = []
    def handler(request):
        requests.append(request)
        return httpx.Response(403, json={"error": {"message": "synthetic-access-token-1"}})
    model = ChatCompletionsChat(settings, httpx.MockTransport(handler))
    with pytest.raises(ProviderError) as error:
        asyncio.run(model.complete_json([{"role": "user", "content": "hi"}]))
    assert "ADC" in error.value.detail and "项目" in error.value.detail
    assert "synthetic-access-token" not in error.value.detail and len(requests) == 1


def test_inherited_adc_image_extraction_uses_native_bearer_auth(tmp_path, monkeypatch):
    from app.vision.grounding import extract
    install_credentials(monkeypatch)
    ai = AISettings(isolated_settings(tmp_path))
    ai.save(BODY)
    vision = ServiceModels(ai, env=VisionConfig()).vision_config()
    def handler(request):
        assert request.headers["authorization"] == "Bearer synthetic-access-token-1"
        assert request.url.path.endswith(":generateContent")
        payload = json.loads(request.content)
        assert payload["contents"][0]["parts"][0]["inlineData"]["mimeType"] == "image/png"
        data = {"kind": "problem", "transcript": "一加一", "regions": [], "steps": 1, "category": "concept", "netlist": None}
        return httpx.Response(200, json={"candidates": [{"finishReason": "STOP", "content": {"parts": [{"text": json.dumps(data)}]}}]})
    result = asyncio.run(extract("data:image/png;base64,aGVsbG8=", vision, transport=httpx.MockTransport(handler)))
    assert result.transcript == "一加一"

from fastapi.testclient import TestClient
import pytest
import asyncio

from app.agents.llm import ChatCompletionsTutor, ProviderError

from app.config import Settings
from app.main import create_app


def settings(tmp_path):
    return Settings(_env_file=None, database_path=tmp_path / "data" / "test.sqlite3",
                    llm_api_key="", llm_base_url="", llm_model="")


def test_save_restart_and_secret_preservation(tmp_path):
    config = settings(tmp_path)
    with TestClient(create_app(config)) as client:
        assert client.get("/api/ai/config").json()["configured"] is False
        response = client.put("/api/ai/config", json={
            "base_url": "https://provider.example/v1/", "model": "tutor", "api_key": "test-secret",
        })
        assert response.status_code == 200
        assert "test-secret" not in response.text
        assert response.json()["has_api_key"] is True
        assert client.put("/api/ai/config", json={
            "base_url": "https://provider.example/v1", "model": "next", "api_key": "",
        }).status_code == 200
        assert client.app.state.tutor.settings.llm_model == "next"
        assert client.put("/api/ai/config", json={
            "base_url": "https://different.example/v1", "model": "next", "api_key": "",
        }).status_code == 422
    with TestClient(create_app(config)) as client:
        assert client.get("/api/ai/config").json()["model"] == "next"
        assert client.app.state.tutor.settings.llm_api_key.get_secret_value() == "test-secret"


def test_validation_and_local_origin_guard(tmp_path):
    with TestClient(create_app(settings(tmp_path))) as client:
        response = client.put("/api/ai/config", json={
            "base_url": "https://user:password@provider.example/v1", "model": "x", "api_key": "test-secret",
        })
        assert response.status_code == 422
        assert "test-secret" not in response.text and "password" not in response.text
        for method, path in [("GET", "/api/ai/config"), ("PUT", "/api/ai/config"), ("POST", "/api/ai/test")]:
            response = client.request(method, path, headers={"Origin": "https://evil.example"}, json={})
            assert response.status_code == 403
        response = client.options("/api/ai/config", headers={
            "Origin": "http://localhost:3000", "Access-Control-Request-Method": "PUT",
        })
        assert response.status_code == 200
    with TestClient(create_app(settings(tmp_path)), client=("192.0.2.1", 50000)) as client:
        assert client.get("/api/ai/config").status_code == 403


def test_connection_probe_does_not_save(monkeypatch, tmp_path):
    observed = []
    def generate(self, context):
        async def result():
            observed.append((self.settings.llm_model, context))
            from app.models.schemas import TutorOutput
            return TutorOutput(assessment="correct", issue=None, confidence=0.9,
                               evidence=context["current_answer"], reply="正确。")
        return result()
    monkeypatch.setattr("app.agents.llm.ChatCompletionsTutor.generate", generate)
    with TestClient(create_app(settings(tmp_path))) as client:
        response = client.post("/api/ai/test", json={
            "base_url": "https://provider.example/v1", "model": "probe", "api_key": "test-secret",
        })
        assert response.json() == {"status": "ok", "model": "probe", "structured_output": True}
        assert observed[0][0] == "probe"
        assert client.get("/api/ai/config").json()["configured"] is False
        assert client.get("/api/memories").json() == []
        assert not (tmp_path / "data" / "ai-settings.json").exists()


def test_save_failure_keeps_active_config(monkeypatch, tmp_path):
    with TestClient(create_app(settings(tmp_path))) as client:
        def fail(*args):
            raise OSError("private details")
        monkeypatch.setattr("app.services.ai_settings.os.replace", fail)
        response = client.put("/api/ai/config", json={
            "base_url": "https://provider.example/v1", "model": "x", "api_key": "test-secret",
        })
        assert response.status_code == 503
        assert "private details" not in response.text
        assert client.get("/api/ai/config").json()["configured"] is False


@pytest.mark.parametrize("method,path", [("PUT", "/api/ai/config"), ("POST", "/api/ai/test")])
@pytest.mark.parametrize("invalid_json", [True, False])
def test_malformed_configuration_never_echoes_key(tmp_path, method, path, invalid_json):
    secret = "synthetic-test-secret"
    with TestClient(create_app(settings(tmp_path))) as client:
        body = '{"api_key":"' + secret + '"' if invalid_json else '[{"api_key":"' + secret + '"}]'
        response = client.request(method, path, content=body, headers={"Content-Type": "application/json"})
        assert response.status_code == 422
        assert secret not in response.text
        assert isinstance(response.json()["detail"], str)
        assert client.get("/api/ai/config").json()["configured"] is False


def test_unicode_key_is_rejected_before_save(tmp_path):
    with TestClient(create_app(settings(tmp_path))) as client:
        response = client.put("/api/ai/config", json={
            "base_url": "https://provider.example/v1", "model": "tutor", "api_key": "中文密钥",
        })
        assert response.status_code == 422
        assert "中文密钥" not in response.text
        assert client.get("/api/ai/config").json()["configured"] is False


@pytest.mark.parametrize("failure", [ImportError("synthetic-private-key"), UnicodeEncodeError("ascii", "密钥", 0, 1, "invalid")])
def test_provider_configuration_errors_are_readable(monkeypatch, tmp_path, failure):
    def fail(*args, **kwargs):
        raise failure
    monkeypatch.setattr("app.agents.llm.httpx.AsyncClient", fail)
    config = settings(tmp_path).model_copy(update={"llm_base_url": "https://provider.example/v1", "llm_model": "tutor"})
    from pydantic import SecretStr
    config.llm_api_key = SecretStr("synthetic-private-key")
    with pytest.raises(ProviderError) as error:
        asyncio.run(ChatCompletionsTutor(config).generate({"current_answer": "测试"}))
    assert error.value.status_code == 503
    assert "synthetic-private-key" not in error.value.detail

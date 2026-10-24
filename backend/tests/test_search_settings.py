import json

import httpx
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient

from app.agents.llm import ProviderError
from app.main import create_app
from app.services.anysearch import AnySearchClient
from app.services.search_settings import SearchSettings, clean_key, saved_key
from tests.test_acceptance_support import isolated_settings

KEY = "as_sk_synthetic0123456789abcdef"


def ok_response(request):
    body = {"code": 0, "data": {"results": [{"url": "https://example.test/a", "title": "A", "snippet": "s"}]}}
    return httpx.Response(200, json=body)


def test_save_clear_and_status_never_expose_the_key(tmp_path):
    store = SearchSettings(isolated_settings(tmp_path))
    assert store.status() == {"has_key": False, "source": "none"}
    assert store.save(f"  {KEY}\n") == {"has_key": True, "source": "saved"}
    assert store.saved_key() == KEY and store.key() == KEY
    assert KEY in store.path.read_text(encoding="utf-8")
    assert store.save("") == {"has_key": False, "source": "none"}
    assert store.saved_key() == "" and "anysearch_api_key" not in json.loads(store.path.read_text(encoding="utf-8"))


def test_environment_key_is_used_when_nothing_is_saved_and_saved_wins(tmp_path):
    from pydantic import SecretStr

    settings = isolated_settings(tmp_path).model_copy(update={"anysearch_api_key": SecretStr("from-env")})
    store = SearchSettings(settings)
    assert store.status() == {"has_key": True, "source": "environment"} and store.key() == "from-env"
    store.save(KEY)
    assert store.status()["source"] == "saved" and store.key() == KEY


@pytest.mark.parametrize("bad", ["has space", "a\nb", "x" * 600, "ключ-secret", 123])
def test_invalid_keys_are_rejected_without_echoing_them(bad):
    with pytest.raises(HTTPException) as caught:
        clean_key(bad)
    assert caught.value.status_code == 422 and str(bad) not in caught.value.detail


def test_chat_search_prefers_the_saved_key_over_the_environment_key(tmp_path):
    from pydantic import SecretStr

    seen = []

    def handler(request):
        seen.append(request.headers.get("authorization"))
        return ok_response(request)

    settings = isolated_settings(tmp_path).model_copy(update={"anysearch_api_key": SecretStr("from-env")})
    store = SearchSettings(settings)
    client = AnySearchClient(settings, httpx.MockTransport(handler), key_source=store.saved_key)
    import asyncio

    asyncio.run(client.search("栈", 1))
    store.save(KEY)
    asyncio.run(client.search("栈", 1))
    assert seen == ["Bearer from-env", f"Bearer {KEY}"]


def test_problem_search_reads_the_saved_key_first(tmp_path, monkeypatch):
    from app.agent_tools.problem_search import _env

    monkeypatch.setenv("ANYSEARCH_API_KEY", "from-env")
    store = SearchSettings(isolated_settings(tmp_path))
    assert _env("ANYSEARCH_API_KEY") == "from-env"
    store.save(KEY)
    assert _env("ANYSEARCH_API_KEY") == KEY and saved_key() == KEY
    assert _env("TAVILY_API_KEY") != KEY


def test_endpoints_are_local_only_and_never_return_the_key(tmp_path):
    with TestClient(create_app(isolated_settings(tmp_path))) as client:
        assert client.get("/api/search/config").json() == {"has_key": False, "source": "none"}
        saved = client.put("/api/search/config", json={"anysearch_api_key": KEY})
        assert saved.status_code == 200 and saved.json() == {"has_key": True, "source": "saved"}
        got = client.get("/api/search/config")
        assert got.headers["cache-control"] == "no-store" and KEY not in got.text
        bad = client.put("/api/search/config", json={"anysearch_api_key": "has space"})
        assert bad.status_code == 422 and "has space" not in bad.text
        assert client.put("/api/search/config", content="[1]", headers={"content-type": "application/json"}).status_code == 422
        evil = {"Origin": "https://evil.example"}
        assert client.get("/api/search/config", headers=evil).status_code == 403
        assert client.put("/api/search/config", json={"anysearch_api_key": ""}, headers=evil).status_code == 403
        assert client.put("/api/search/config", json={"anysearch_api_key": ""}).json() == {"has_key": False, "source": "none"}


def test_test_endpoint_checks_the_typed_key_without_saving_it(tmp_path):
    from app.api.search_settings import search_settings_router

    seen = []

    def handler(request):
        seen.append(request.headers.get("authorization"))
        if request.headers.get("authorization") == "Bearer bad-key":
            return httpx.Response(401)
        if not request.headers.get("authorization"):
            return httpx.Response(402)
        return ok_response(request)

    settings = isolated_settings(tmp_path)
    store = SearchSettings(settings)
    app = FastAPI()

    @app.exception_handler(ProviderError)
    async def provider_error(request, exc):
        return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})

    app.include_router(search_settings_router(store, settings, lambda request: None, httpx.MockTransport(handler)))
    client = TestClient(app)
    assert client.post("/api/search/test", json={"anysearch_api_key": KEY}).json() == {"status": "ok", "results": 1}
    assert store.saved_key() == ""  # 测试不保存
    assert client.post("/api/search/test", json={"anysearch_api_key": "bad-key"}).status_code == 503
    quota = client.post("/api/search/test")  # 没填也没保存：匿名额度
    assert quota.status_code == 503 and "额度" in quota.json()["detail"]
    store.save(KEY)
    assert client.post("/api/search/test").json()["status"] == "ok"  # 没填就测当前生效的
    assert seen[-1] == f"Bearer {KEY}"

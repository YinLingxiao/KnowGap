"""ChatGPT plan OAuth and Responses tests. No real credentials or network calls."""

import asyncio
import base64
import json
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qs, urlsplit

from cryptography.hazmat.primitives.asymmetric import rsa
import httpx
import jwt
import pytest
from fastapi.testclient import TestClient

from app.agents.llm import ProviderError
from app.agents.openai_responses import OpenAIResponsesChat
from app.main import create_app
from app.services.ai_settings import AISettings
from app.services.chatgpt_auth import ChatGPTAuth, PLAN_SCOPE, RESOURCE, SCOPES
from tests.test_acceptance_support import isolated_settings

PROJECT = "synthetic-chatgpt"
REDIRECT = "http://127.0.0.1:1455/auth/callback"
ISSUER = "https://auth.openai.com"
CLIENT = "oaiapp_test"


class Clock:
    def __init__(self):
        self.now = 1_800_000_000.0

    def __call__(self):
        return self.now


def b64(value: int) -> str:
    raw = value.to_bytes((value.bit_length() + 7) // 8, "big")
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def make_key():
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    public = key.public_key().public_numbers()
    return key, {"kty": "RSA", "kid": "test-key", "use": "sig", "alg": "RS256",
                 "n": b64(public.n), "e": b64(public.e)}


def id_token(key, nonce, *, client=CLIENT, email="learner@example.com", issuer=ISSUER):
    now = datetime.now(timezone.utc)
    return jwt.encode({"iss": issuer, "aud": client, "sub": "subject-123", "email": email,
                       "nonce": nonce, "iat": now, "exp": now + timedelta(hours=1)},
                      key, algorithm="RS256", headers={"kid": "test-key"})


class OAuthServer:
    def __init__(self, key, jwk):
        self.key, self.jwk = key, jwk
        self.forms, self.requests = [], []
        self.access = 0
        self.nonce = None
        self.pending_nonce = None
        self.scope = " ".join(SCOPES)

    def handler(self, request):
        self.requests.append(request)
        path = request.url.path
        if path.endswith("/.well-known/openid-configuration"):
            return httpx.Response(200, json={"issuer": ISSUER, "jwks_uri": "https://auth.openai.com/test/jwks",
                                             "revocation_endpoint": "https://auth.openai.com/test/revoke"})
        if path == "/test/jwks":
            return httpx.Response(200, json={"keys": [self.jwk]})
        if path == "/test/revoke":
            self.forms.append(("revoke", request.content.decode()))
            return httpx.Response(200)
        if path.endswith("/oauth/token"):
            form = {key: values[0] for key, values in parse_qs(request.content.decode()).items()}
            self.forms.append((form.get("grant_type"), form))
            if form.get("grant_type") == "refresh_token":
                self.access += 1
                return httpx.Response(200, json={
                    "access_token": f"access-refreshed-{self.access}", "refresh_token": f"refresh-{self.access + 1}",
                    "id_token": id_token(self.key, "unused"), "expires_in": 3600, "token_type": "Bearer",
                    "scope": self.scope,
                })
            return httpx.Response(200, json={
                "access_token": "access-first", "refresh_token": "refresh-first",
                "id_token": id_token(self.key, self.nonce if self.nonce is not None else self.pending_nonce),
                "expires_in": 3600, "token_type": "Bearer",
                "scope": self.scope,
            })
        return httpx.Response(404)

    def complete_query(self, auth):
        # The test drives the same pending attempt created by begin().
        self.pending_nonce = auth.pending["nonce"]
        query = {"state": auth.pending["state"], "code": "synthetic-code", "client_id": CLIENT}
        return auth.complete(query)


@pytest.fixture
def oauth(tmp_path):
    key, jwk = make_key()
    server = OAuthServer(key, jwk)
    settings = isolated_settings(tmp_path)
    clock = Clock()
    auth = ChatGPTAuth(settings, httpx.MockTransport(server.handler), clock=clock,
                       path=tmp_path / "chatgpt-auth.json")
    return auth, server, clock, settings


def begin(auth, server=None):
    url = auth.begin(REDIRECT)["authorize_url"]
    parsed = urlsplit(url)
    params = {key: values[0] for key, values in parse_qs(parsed.query).items()}
    auth.pending.update({"state": params["state"]})
    if server is not None:
        server.pending_nonce = params["nonce"]
    return parsed, params


def test_begin_uses_dynamic_registration_pkce_and_stable_host(oauth):
    auth, server, clock, _ = oauth
    parsed, params = begin(auth, server)
    assert parsed.geturl().startswith("https://auth.openai.com/api/accounts/authorize?")
    assert params["client_id"] == "dynamic_agent_client"
    assert params["agent_name_hint"] == "KnowGap"
    assert params["response_type"] == "code" and params["redirect_uri"] == REDIRECT
    assert params["resource"] == RESOURCE
    assert params["code_challenge_method"] == "S256" and len(params["code_challenge"]) >= 43
    assert set(params["scope"].split()) == set(SCOPES)
    first_host = params["ext_agent_host_id"]
    assert first_host.startswith("urn:uuid:")
    auth.pending = None
    _, again = begin(auth, server)
    assert again["ext_agent_host_id"] == first_host
    assert auth.path.exists()


def test_callback_validates_state_pkce_id_token_scope_and_persists_without_exposing_tokens(oauth):
    auth, server, clock, _ = oauth
    begin(auth, server)
    status = server.complete_query(auth)
    form = server.forms[-1][1]
    assert form["code_verifier"] and form["redirect_uri"] == REDIRECT and form["resource"] == RESOURCE
    assert form["client_id"] == CLIENT and form["grant_type"] == "authorization_code"
    assert status["connected"] is True and status["plan_enabled"] is True
    assert status["email"] == "learner@example.com"
    assert "access_token" not in json.dumps(status) and "refresh_token" not in json.dumps(status)
    assert asyncio.run(auth.access_token()) == "access-first"
    assert auth.path.exists()
    raw = auth.path.read_text(encoding="utf-8")
    assert "access-first" in raw and "refresh-first" in raw  # protected local file, never API response


def test_state_client_denial_nonce_and_scope_errors_are_rejected(oauth):
    auth, server, clock, _ = oauth
    begin(auth, server)
    with pytest.raises(ProviderError, match="状态"):
        auth.complete({"state": "wrong", "code": "x", "client_id": CLIENT})
    auth.pending["state"] = begin(auth, server)[1]["state"]
    with pytest.raises(ProviderError, match="取消"):
        auth.complete({"state": auth.pending["state"], "error": "access_denied"})
    auth.pending = None
    begin(auth, server)
    with pytest.raises(ProviderError, match="首次注册"):
        auth.complete({"state": auth.pending["state"], "code": "x"})
    auth.pending = None
    server.nonce = "not-the-same"
    # The token endpoint signs the server's nonce, which differs from the pending attempt.
    begin(auth, server)
    with pytest.raises(ProviderError, match="nonce"):
        server.complete_query(auth)
    auth.pending = None
    begin(auth, server)
    server.nonce = auth.pending["nonce"]
    server.scope = "openid profile email offline_access resource.invoke"
    status = server.complete_query(auth)
    assert status["connected"] and not status["plan_enabled"]


def test_refresh_rotates_once_under_concurrency_and_handles_invalid_grant(oauth):
    auth, server, clock, _ = oauth
    begin(auth, server)
    server.complete_query(auth)
    clock.now += 3600
    async def refresh_many():
        return await asyncio.gather(*[auth.access_token() for _ in range(6)])
    values = asyncio.run(refresh_many())
    assert set(values) == {"access-refreshed-1"}
    assert server.access == 1
    assert json.loads(auth.path.read_text(encoding="utf-8"))["registrations"][CLIENT]["refresh_token"] == "refresh-2"
    clock.now += 3600
    server.handler = lambda request: httpx.Response(400, json={"error": "invalid_grant"})
    auth.transport = httpx.MockTransport(server.handler)
    with pytest.raises(ProviderError) as error:
        asyncio.run(auth.access_token())
    assert error.value.status_code == 401


def test_logout_revokes_and_clears_tokens_but_keeps_client_mapping(oauth):
    auth, server, clock, _ = oauth
    begin(auth, server)
    server.complete_query(auth)
    result = auth.logout()
    assert result["revoked"] is True and "token=refresh-first" in server.forms[-1][1]
    status = auth.status()
    assert not status["connected"] and status["reauth_required"]
    data = json.loads(auth.path.read_text(encoding="utf-8"))
    assert data["active_client_id"] == CLIENT and data["registrations"][CLIENT]["client_id"] == CLIENT
    assert data["registrations"][CLIENT]["access_token"] == ""
    assert "access-first" not in json.dumps(status)


def test_settings_defaults_are_unchanged_and_chatgpt_requires_login(tmp_path):
    ai = AISettings(isolated_settings(tmp_path))
    assert ai.status()["auth_mode"] == "api_key"
    saved = ai.save({"base_url": "https://api.openai.com/v1", "model": "gpt-6.1-sol", "auth_mode": "chatgpt"})
    assert saved["auth_mode"] == "chatgpt" and saved["has_api_key"] is False
    assert saved["configured"] is False
    class Fake:
        def status(self):
            return {"connected": True, "email": "a@example.com", "plan_enabled": True,
                    "reauth_required": False, "expires_at": 0, "accounts": [], "error": ""}
    ai.chatgpt = Fake()
    assert ai.status()["configured"] is True
    with pytest.raises(Exception):
        ai.candidate({"base_url": "https://evil.example/v1", "model": "x", "auth_mode": "chatgpt"})
    assert ai.save({"base_url": "https://api.openai.com/v1", "model": "gpt-6.1-sol", "auth_mode": "api_key",
                    "api_key": "synthetic-key"})["has_api_key"] is True
    assert ai.current.llm_auth_mode == "api_key"


# ---- Responses adapter ----
class FakeAuth:
    def __init__(self):
        self.force = []
        self.token = "access-first"

    async def access_token(self, force=False):
        self.force.append(force)
        if force:
            self.token = "access-second"
        return self.token


def chatgpt_settings(tmp_path, *, mode="chatgpt"):
    return isolated_settings(tmp_path).model_copy(update={
        "llm_api_key": "", "llm_base_url": "https://api.openai.com/v1",
        "llm_model": "gpt-6.1-sol", "llm_auth_mode": mode,
    })


def sse(*events):
    body = ""
    for kind, data in events:
        body += f"event: {kind}\ndata: {json.dumps(data)}\n\n"
    return body


def collect(tmp_path, handler, messages=None, tools=None, auth=None):
    async def run():
        model = OpenAIResponsesChat(chatgpt_settings(tmp_path), auth or FakeAuth(), httpx.MockTransport(handler))
        return [item async for item in model.stream(messages or [{"role": "user", "content": "hi"}], tools)]
    return asyncio.run(run())


def test_responses_request_shape_text_reasoning_tools_usage(tmp_path):
    def handler(request):
        assert request.method == "POST" and request.url.path == "/v1/responses"
        assert request.headers["authorization"] == "Bearer access-first"
        body = json.loads(request.content)
        assert body["store"] is False and body["stream"] is True
        assert body["input"] == [{"role": "user", "content": "hi"}]
        assert "messages" not in body and "temperature" not in body and "previous_response_id" not in body
        assert body["instructions"] == "规则一\n\n规则二"
        assert body["tools"][0]["type"] == "function" and body["tools"][0]["name"] == "agenda_list"
        return httpx.Response(200, text=sse(
            ("response.reasoning_summary_text.delta", {"delta": "先想"}),
            ("response.output_text.delta", {"delta": "你好"}),
            ("response.output_item.added", {"item": {"id": "fc", "type": "function_call", "call_id": "call_1",
                                                     "name": "agenda_list", "arguments": ""}}),
            ("response.function_call_arguments.delta", {"item_id": "fc", "delta": '{"status":"done"}'}),
            ("response.output_item.done", {"item": {"id": "fc", "type": "function_call", "call_id": "call_1",
                                                    "name": "agenda_list", "arguments": '{"status":"done"}'}}),
            ("response.completed", {"response": {"status": "completed", "output": [],
                                                 "usage": {"input_tokens": 10, "output_tokens": 4,
                                                           "input_tokens_details": {"cached_tokens": 3}}}}),
        ), headers={"content-type": "text/event-stream"})
    items = collect(tmp_path, handler, [{"role": "system", "content": "规则一"},
                                        {"role": "developer", "content": "规则二"},
                                        {"role": "user", "content": "hi"}],
                    [{"type": "function", "function": {"name": "agenda_list", "description": "列出",
                                                      "parameters": {"type": "object", "properties": {}}}}])
    assert ("reasoning", "先想") in items and ("text", "你好") in items
    calls = next(value for kind, value in items if kind == "tool_calls")
    assert calls[0]["id"] == "call_1" and json.loads(calls[0]["arguments"]) == {"status": "done"}
    assert ("usage", {"prompt_tokens": 10, "completion_tokens": 4,
                      "prompt_tokens_details": {"cached_tokens": 3}}) in items
    assert items[-1] == ("finish", "stop")


def test_responses_rejects_incomplete_stream_and_maps_usage_limit(tmp_path):
    with pytest.raises(ProviderError, match="提前结束"):
        collect(tmp_path, lambda _: httpx.Response(200, text=sse(("response.output_text.delta", {"delta": "半句"})),
                                                   headers={"content-type": "text/event-stream"}))
    def limited(_):
        return httpx.Response(429, json={"error": {"code": "subscription_sharing_usage_limit_exceeded"}},
                              headers={"x-request-id": "req_123"})
    with pytest.raises(ProviderError) as error:
        collect(tmp_path, limited)
    assert error.value.status_code == 402 and "额度" in error.value.detail and "req_123" in error.value.detail


def test_responses_retries_once_after_401_and_uses_refreshed_token(tmp_path):
    seen = []
    def handler(request):
        seen.append(request.headers["authorization"])
        if len(seen) == 1:
            return httpx.Response(401, json={"error": {"code": "invalid_user"}})
        return httpx.Response(200, text=sse(("response.output_text.delta", {"delta": "OK"}),
                                            ("response.completed", {"response": {"status": "completed", "usage": {}}})),
                              headers={"content-type": "text/event-stream"})
    auth = FakeAuth()
    items = collect(tmp_path, handler, auth=auth)
    assert seen == ["Bearer access-first", "Bearer access-second"]
    assert auth.force == [False, True]
    assert ("text", "OK") in items


def test_responses_json_mode_requires_completed_and_parses_object(tmp_path):
    def handler(request):
        body = json.loads(request.content)
        assert body["text"] == {"format": {"type": "json_object"}}
        assert body["store"] is False and body["stream"] is True
        return httpx.Response(200, text=sse(("response.output_text.delta", {"delta": '{"ok": true}'}),
                                            ("response.completed", {"response": {"status": "completed", "usage": {
                                                "input_tokens": 2, "output_tokens": 3}}})),
                              headers={"content-type": "text/event-stream"})
    async def run():
        model = OpenAIResponsesChat(chatgpt_settings(tmp_path), FakeAuth(), httpx.MockTransport(handler))
        return await model.complete_json_with_usage([{"role": "user", "content": "json"}])
    result, usage = asyncio.run(run())
    assert result == {"ok": True} and usage == {"prompt_tokens": 2, "completion_tokens": 3}
    assert OpenAIResponsesChat(chatgpt_settings(tmp_path), FakeAuth()).settings.llm_auth_mode == "chatgpt"


def test_chatgpt_status_endpoint_is_local_and_starts_disconnected(tmp_path):
    with TestClient(create_app(isolated_settings(tmp_path))) as client:
        response = client.get("/api/chatgpt/status")
        assert response.status_code == 200
        assert response.json()["connected"] is False
        assert client.get("/api/chatgpt/status", headers={"Origin": "https://evil.example"}).status_code == 403


def test_chatgpt_start_endpoint_returns_authorize_url_without_binding_in_tests(monkeypatch, tmp_path):
    monkeypatch.setattr("app.api.chatgpt.start_listener", lambda auth: REDIRECT)
    with TestClient(create_app(isolated_settings(tmp_path))) as client:
        response = client.post("/api/chatgpt/start")
        assert response.status_code == 200
        payload = response.json()
        assert payload["authorize_url"].startswith("https://auth.openai.com/api/accounts/authorize?")
        assert payload["base_url"] == "https://api.openai.com/v1"
        assert "client_id=dynamic_agent_client" in payload["authorize_url"]
        assert "state=" in payload["authorize_url"] and "code_challenge=" in payload["authorize_url"]
        assert client.get("/api/chatgpt/status").json()["connected"] is False


def test_loopback_callback_listener_accepts_query_and_serves_a_plain_page():
    import socket
    from app.services.chatgpt_oauth_listener import start_listener

    class Fake:
        listener = None
        query = None

        def complete(self, query):
            self.query = query
            return {}

    auth = Fake()
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    redirect = start_listener(auth, preferred_port=port)
    try:
        response = httpx.get(redirect + "?state=synthetic&code=synthetic-code", timeout=5)
        assert response.status_code == 200
        assert "授权完成" in response.text
        assert auth.query == {"state": "synthetic", "code": "synthetic-code"}
        assert response.headers["cache-control"] == "no-store"
    finally:
        auth.listener.shutdown()
        auth.listener.server_close()


def test_non_chatgpt_settings_are_not_routed_to_responses(tmp_path):
    model = OpenAIResponsesChat(chatgpt_settings(tmp_path).model_copy(update={"llm_base_url": "https://example.test/v1"}),
                                FakeAuth())
    with pytest.raises(ProviderError, match="配置无效"):
        asyncio.run(model.complete_json([{"role": "user", "content": "x"}]))

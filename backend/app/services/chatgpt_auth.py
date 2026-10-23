"""ChatGPT plan OAuth for the local OSS flow. Tokens never leave the backend."""

import asyncio
import base64
import hashlib
import json
import os
import secrets
import tempfile
import threading
import time
from pathlib import Path
from urllib.parse import urlencode, urlsplit
from uuid import uuid4

import httpx
import jwt

from app.agents.llm import ProviderError
from app.config import Settings

AUTHORIZE_URL = "https://auth.openai.com/api/accounts/authorize"
TOKEN_URL = "https://auth.openai.com/api/accounts/oauth/token"
DISCOVERY_URL = "https://auth.openai.com/.well-known/openid-configuration"
RESOURCE = "https://api.openai.com/v1"
PLAN_SCOPE = "chatgpt.tokens.use.direct"
SCOPES = ("openid", "profile", "email", "offline_access", "resource.invoke", PLAN_SCOPE)
AGENT_NAME = "KnowGap"
REFRESH_EARLY_SECONDS = 300


def _b64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _pkce() -> tuple[str, str]:
    verifier = _b64url(secrets.token_bytes(48))
    return verifier, _b64url(hashlib.sha256(verifier.encode("ascii")).digest())


def _scopes(raw) -> list[str]:
    return sorted({item for item in str(raw or "").replace(",", " ").split() if item})


def _valid_loopback(uri: str) -> bool:
    try:
        url = urlsplit(uri)
        port = url.port
    except ValueError:
        return False
    return (url.scheme == "http" and url.hostname == "127.0.0.1" and bool(port)
            and url.path == "/auth/callback" and not url.query and not url.fragment
            and not url.username and not url.password)


class ChatGPTAuth:
    def __init__(self, settings: Settings, transport: httpx.BaseTransport | None = None,
                 clock=time.time, path: Path | None = None):
        self.path = path or settings.resolved_database_path().parent / "chatgpt-auth.json"
        self.transport = transport
        self.clock = clock
        self.lock = threading.RLock()
        self.pending: dict | None = None
        self.listener = None
        self.last_error = ""
        self._discovery: dict | None = None
        self._discovery_at = 0.0

    # ---- storage ----
    def _load(self) -> dict:
        if not self.path.exists():
            data = {"host_id": f"urn:uuid:{uuid4()}", "active_client_id": "", "registrations": {}}
            # The host ID must be stable before the first sign-in.
            self._write(data)
            return data
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            raise RuntimeError("无法读取本机 ChatGPT 授权文件，请检查 chatgpt-auth.json。") from None
        if not isinstance(data, dict) or not isinstance(data.get("registrations", {}), dict):
            raise RuntimeError("本机 ChatGPT 授权文件格式无效。")
        changed = False
        if not data.get("host_id"):
            data["host_id"] = f"urn:uuid:{uuid4()}"
            changed = True
        if "active_client_id" not in data:
            data["active_client_id"] = ""
            changed = True
        if "registrations" not in data:
            data["registrations"] = {}
            changed = True
        if changed:
            self._write(data)
        return data

    def _write(self, data: dict) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = None
        try:
            fd, temporary = tempfile.mkstemp(dir=self.path.parent, prefix=".chatgpt-auth-")
            with os.fdopen(fd, "w", encoding="utf-8") as output:
                json.dump(data, output, ensure_ascii=False)
                output.flush()
                os.fsync(output.fileno())
            try:
                os.chmod(temporary, 0o600)
            except OSError:
                pass
            os.replace(temporary, self.path)
        except OSError:
            raise ProviderError(503, "ChatGPT 授权保存失败，请检查后端数据目录权限。") from None
        finally:
            if temporary and Path(temporary).exists():
                Path(temporary).unlink()

    # ---- browser flow ----
    def begin(self, redirect_uri: str, *, client_id: str | None = None) -> dict:
        if not _valid_loopback(redirect_uri):
            raise ProviderError(503, "ChatGPT 回调地址必须是 127.0.0.1 的 /auth/callback 回环地址。")
        with self.lock:
            try:
                data = self._load()
            except RuntimeError as exc:
                raise ProviderError(503, str(exc)) from None
            selected = client_id or data.get("active_client_id") or ""
            registration = data["registrations"].get(selected) if selected else None
            state, nonce = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
            verifier, challenge = _pkce()
            params = {
                "client_id": selected or "dynamic_agent_client",
                "response_type": "code",
                "redirect_uri": redirect_uri,
                "scope": " ".join(SCOPES),
                "resource": RESOURCE,
                "state": state,
                "nonce": nonce,
                "code_challenge_method": "S256",
                "code_challenge": challenge,
                "ext_agent_host_id": data["host_id"],
            }
            if registration:
                if registration.get("id_token"):
                    params["id_token_hint"] = registration["id_token"]
                if registration.get("email"):
                    params["login_hint"] = registration["email"]
            else:
                params["agent_name_hint"] = AGENT_NAME
            self.pending = {"state": state, "nonce": nonce, "verifier": verifier, "redirect_uri": redirect_uri,
                            "client_id": selected, "is_new": not bool(selected), "created": self.clock()}
            self.last_error = ""
            return {"authorize_url": f"{AUTHORIZE_URL}?{urlencode(params)}", "expires_in": 600}

    def complete(self, query: dict) -> dict:
        with self.lock:
            attempt = self.pending
            if not attempt or self.clock() - attempt["created"] > 600:
                raise ProviderError(400, "ChatGPT 授权已过期，请重新发起登录。")
            if not secrets.compare_digest(str(query.get("state", "")), attempt["state"]):
                raise ProviderError(400, "ChatGPT 授权状态校验失败，请重新发起登录。")
            if query.get("error"):
                if query["error"] == "access_denied":
                    raise ProviderError(403, "你取消了 ChatGPT 授权。")
                raise ProviderError(400, "ChatGPT 授权未完成，请重新发起登录。")
            code = str(query.get("code", ""))
            if not code:
                raise ProviderError(400, "ChatGPT 授权回调缺少授权码。")
            issued = str(query.get("client_id", "")) if attempt["is_new"] else attempt["client_id"]
            if attempt["is_new"]:
                if not issued or issued == "dynamic_agent_client":
                    raise ProviderError(400, "ChatGPT 首次注册未返回有效的客户端 ID，请重新登录。")
            elif query.get("client_id") and query["client_id"] != attempt["client_id"]:
                raise ProviderError(400, "ChatGPT 回调的客户端与当前账号不一致，请重新登录。")
            token = self._token_request({
                "grant_type": "authorization_code", "client_id": issued, "code": code,
                "code_verifier": attempt["verifier"], "redirect_uri": attempt["redirect_uri"],
                "resource": RESOURCE,
            })
            if not token.get("id_token"):
                raise ProviderError(502, "ChatGPT 授权响应缺少身份令牌，请重新登录。")
            claims = self._validate_id_token(token, issued, attempt["nonce"])
            scopes = _scopes(token.get("scope"))
            saved_at = self.clock()
            expires_in = token.get("expires_in") if type(token.get("expires_in")) is int else 3600
            record = {
                "email": str(claims.get("email") or ""), "subject": str(claims.get("sub") or ""),
                "client_id": issued, "id_token": token.get("id_token") or "",
                "access_token": token.get("access_token") or "", "refresh_token": token.get("refresh_token") or "",
                "token_type": token.get("token_type") or "Bearer", "scopes": scopes, "saved_at": saved_at,
                "expires_at": saved_at + max(60, min(expires_in, 24 * 3600)),
            }
            try:
                data = self._load()
            except RuntimeError as exc:
                raise ProviderError(503, str(exc)) from None
            data["registrations"][issued] = record
            data["active_client_id"] = issued
            self._write(data)
            self.pending = None
            return self.status()

    def _token_request(self, form: dict) -> dict:
        try:
            with httpx.Client(timeout=30, transport=self.transport) as client:
                response = client.post(TOKEN_URL, data=form)
        except httpx.HTTPError:
            raise ProviderError(503, "无法连接 ChatGPT 授权服务，请检查网络后重试。") from None
        if not response.is_success:
            try:
                body = response.json()
                code = (body.get("error") or {}).get("code") if isinstance(body.get("error"), dict) else body.get("error")
            except (ValueError, AttributeError):
                code = ""
            if code in {"invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired",
                        "refresh_token_invalidated", "refresh_token_reused"}:
                raise ProviderError(401, "ChatGPT 授权已失效，请重新连接。")
            raise ProviderError(502, f"ChatGPT 授权服务返回异常（HTTP {response.status_code}），请稍后重试。")
        try:
            body = response.json()
        except ValueError:
            raise ProviderError(502, "ChatGPT 授权服务返回了无法解析的响应。") from None
        if not isinstance(body, dict) or not body.get("access_token"):
            raise ProviderError(502, "ChatGPT 授权响应不完整，请重新登录。")
        return body

    def _openid(self) -> dict:
        if self._discovery and self.clock() - self._discovery_at < 3600:
            return self._discovery
        try:
            with httpx.Client(timeout=20, transport=self.transport) as client:
                response = client.get(DISCOVERY_URL)
            response.raise_for_status()
            data = response.json()
            if not isinstance(data.get("jwks_uri"), str):
                raise ValueError()
        except (httpx.HTTPError, ValueError, AttributeError):
            raise ProviderError(503, "无法读取 ChatGPT 的登录配置，请检查网络后重试。") from None
        self._discovery, self._discovery_at = data, self.clock()
        return data

    def _validate_id_token(self, token: dict, client_id: str, nonce: str) -> dict:
        discovery = self._openid()
        try:
            with httpx.Client(timeout=20, transport=self.transport) as client:
                response = client.get(discovery["jwks_uri"])
            response.raise_for_status()
            keys = response.json().get("keys") or []
            header = jwt.get_unverified_header(token["id_token"])
            key = next((item for item in keys if item.get("kid") == header.get("kid")), None)
            if not key:
                raise ValueError()
            public = jwt.algorithms.RSAAlgorithm.from_jwk(json.dumps(key))
            claims = jwt.decode(token["id_token"], public, algorithms=["RS256"], audience=client_id,
                                issuer=discovery.get("issuer", "https://auth.openai.com"), leeway=60,
                                options={"require": ["exp", "iat", "aud", "iss", "sub"]})
        except (httpx.HTTPError, ValueError, TypeError, KeyError, jwt.PyJWTError):
            raise ProviderError(401, "ChatGPT 身份令牌校验失败，请重新登录。") from None
        if not secrets.compare_digest(str(claims.get("nonce", "")), nonce):
            raise ProviderError(401, "ChatGPT 身份令牌的 nonce 不匹配，请重新登录。")
        return claims

    # ---- tokens ----
    def _active(self, data: dict | None = None) -> tuple[dict, dict]:
        try:
            data = data or self._load()
        except RuntimeError as exc:
            raise ProviderError(503, str(exc)) from None
        registration = data["registrations"].get(data.get("active_client_id") or "")
        if not registration:
            raise ProviderError(503, "尚未连接 ChatGPT，请在「设置 → 模型接入」中使用 ChatGPT 登录。")
        return data, registration

    def _refresh_locked(self, data: dict, record: dict) -> str:
        if not record.get("refresh_token"):
            raise ProviderError(401, "ChatGPT 授权已失效，请重新连接。")
        body = self._token_request({
            "grant_type": "refresh_token", "client_id": record["client_id"],
            "refresh_token": record["refresh_token"], "resource": RESOURCE,
        })
        saved_at = self.clock()
        expires_in = body.get("expires_in") if type(body.get("expires_in")) is int else 3600
        record.update({
            "access_token": body["access_token"], "refresh_token": body.get("refresh_token") or record["refresh_token"],
            "id_token": body.get("id_token") or record.get("id_token", ""),
            "expires_at": saved_at + max(60, min(expires_in, 24 * 3600)), "saved_at": saved_at,
            "scopes": _scopes(body.get("scope")) or record.get("scopes", []),
        })
        data["registrations"][record["client_id"]] = record
        self._write(data)
        return record["access_token"]

    def _access_token_sync(self, force: bool = False) -> str:
        with self.lock:
            data, record = self._active()
            if not record.get("access_token"):
                raise ProviderError(401, "ChatGPT 授权已失效，请重新连接。")
            if force or record.get("expires_at", 0) - self.clock() <= REFRESH_EARLY_SECONDS:
                return self._refresh_locked(data, record)
            return record["access_token"]

    async def access_token(self, force: bool = False) -> str:
        return await asyncio.to_thread(self._access_token_sync, force)

    def status(self) -> dict:
        with self.lock:
            try:
                data, record = self._active()
            except (ProviderError, RuntimeError) as exc:
                return {"connected": False, "email": "", "plan_enabled": False, "reauth_required": False,
                        "accounts": [], "error": str(exc) if isinstance(exc, RuntimeError) else self.last_error}
            accounts = [{"client_id": key, "email": value.get("email", ""), "active": key == data["active_client_id"]}
                        for key, value in data["registrations"].items()]
            return {
                "connected": bool(record.get("access_token")), "email": record.get("email", ""),
                "plan_enabled": PLAN_SCOPE in record.get("scopes", []),
                "reauth_required": not bool(record.get("access_token")),
                "expires_at": record.get("expires_at", 0), "accounts": accounts, "error": self.last_error,
            }

    def models(self) -> list[dict]:
        token = self._access_token_sync()
        try:
            with httpx.Client(timeout=30, transport=self.transport) as client:
                response = client.get(f"{RESOURCE}/models", headers={"Authorization": f"Bearer {token}"})
        except httpx.HTTPError:
            raise ProviderError(503, "无法读取 ChatGPT 可用模型，请检查网络后重试。") from None
        if not response.is_success:
            raise ProviderError(402 if response.status_code == 429 else 502,
                                "无法读取 ChatGPT 可用模型，请检查授权状态后重试。")
        try:
            body = response.json()
            raw = body.get("models") if isinstance(body, dict) and isinstance(body.get("models"), list) else body.get("data", [])
            result = []
            for item in raw if isinstance(raw, list) else []:
                if not isinstance(item, dict):
                    continue
                slug = item.get("slug") or item.get("id")
                if isinstance(slug, str) and item.get("visibility", "list") in {"list", "public"}:
                    result.append({"id": slug, "name": item.get("display_name") or slug})
            return result
        except (ValueError, AttributeError):
            raise ProviderError(502, "ChatGPT 模型列表格式无法解析。") from None

    def logout(self) -> dict:
        with self.lock:
            data, record = self._active()
            revoked, warning = False, ""
            if record.get("refresh_token"):
                try:
                    discovery = self._openid()
                    endpoint = discovery.get("revocation_endpoint")
                    if endpoint:
                        with httpx.Client(timeout=20, transport=self.transport) as client:
                            response = client.post(endpoint, data={
                                "token": record["refresh_token"], "token_type_hint": "refresh_token",
                                "client_id": record["client_id"],
                            })
                        revoked = response.is_success
                except (ProviderError, httpx.HTTPError):
                    revoked = False
                if not revoked:
                    warning = "已在本地断开，但未能确认 OpenAI 端已撤销授权；可在 ChatGPT 设置的已连接应用中移除。"
            record.update({"access_token": "", "refresh_token": "", "id_token": "", "expires_at": 0})
            data["registrations"][record["client_id"]] = record
            self._write(data)
            return {"revoked": revoked, "warning": warning}

    def close(self) -> None:
        listener = self.listener
        self.listener = None
        if listener:
            try:
                listener.shutdown()
                listener.server_close()
            except Exception:
                pass

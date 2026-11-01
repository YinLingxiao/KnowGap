"""Local demo model configuration; secrets never appear in public responses."""

import json
import os
import tempfile
import time
from pathlib import Path
from threading import RLock
from typing import Literal
from urllib.parse import urlsplit

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, SecretStr, ValidationError

from app.config import Settings
from app.agents.vertex_config import adc_base_url
from app.services.model_library import ModelLibrary

RAW_READ_ATTEMPTS = 4


class ConfigurationInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    base_url: str
    model: str
    api_key: SecretStr | None = None
    auth_mode: Literal["api_key", "adc", "chatgpt"] = "api_key"
    project_id: str = ""
    location: str = "global"


class AISettings:
    def __init__(self, settings: Settings):
        self.path = settings.resolved_database_path().parent / "ai-settings.json"
        self.lock = RLock()
        self.current = settings
        self.chatgpt = None
        if self.path.exists():
            try:
                raw = json.loads(self.path.read_text(encoding="utf-8"))
                if isinstance(raw, dict) and raw.get("base_url") and raw.get("model"):
                    self.current = self.candidate({key: raw[key] for key in (
                        "base_url", "model", "api_key", "auth_mode", "project_id", "location",
                    ) if key in raw})
            except (OSError, ValueError, HTTPException, KeyError, TypeError):
                raise RuntimeError("无法读取本地 AI 配置，请检查 ai-settings.json。") from None
        self.library = ModelLibrary(settings)
        self.library.on_change = self._sync_current
        self._sync_current()

    def _sync_current(self) -> None:
        from app.agents.llm import ProviderError
        library = getattr(self, "library", None)
        if library is None or not library.path.exists():
            return
        try:
            resolved = library.resolve(None)
        except ProviderError:
            resolved = None
        if resolved is None:
            self.current = self.current.model_copy(update={
                "llm_base_url": "", "llm_model": "", "llm_api_key": SecretStr(""),
                "llm_auth_mode": "api_key", "llm_project_id": "", "llm_location": "global",
            })
            return
        self.current = self.current.model_copy(update={
            "llm_base_url": resolved.llm_base_url, "llm_model": resolved.llm_model,
            "llm_api_key": resolved.llm_api_key, "llm_auth_mode": resolved.llm_auth_mode,
            "llm_project_id": resolved.llm_project_id, "llm_location": resolved.llm_location,
        })

    def candidate(self, body: dict) -> Settings:
        if getattr(self, "library", None) is not None:
            self._sync_current()
        try:
            data = ConfigurationInput.model_validate(body)
            base = data.base_url.strip().rstrip("/")
            url = urlsplit(base)
            valid = (url.scheme in {"http", "https"} and bool(url.hostname)
                     and not url.username and not url.password and not url.query and not url.fragment)
            _ = url.port
            model = data.model.strip()
            project = data.project_id.strip() if data.auth_mode == "adc" else ""
            location = data.location.strip() if data.auth_mode == "adc" else "global"
            key = data.api_key.get_secret_value().strip() if data.api_key is not None else ""
            if data.auth_mode == "adc":
                if base != adc_base_url(project, location):
                    raise ValueError()
                # ADC credentials come only from google-auth, never from this form or a stored API key.
                key = ""
            elif data.auth_mode == "chatgpt":
                if base != "https://api.openai.com/v1":
                    raise ValueError()
                # ChatGPT OAuth tokens live in their own protected file; never reuse an API key.
                key = ""
            # Empty password fields preserve the existing secret for the SAME provider only.
            if data.auth_mode == "api_key" and self.current.llm_auth_mode == "api_key" and not key and base == self.current.llm_base_url.strip().rstrip("/"):
                key = self.current.llm_api_key.get_secret_value()
            if not valid or not model or len(model) > 200 or (data.auth_mode == "api_key" and not key) or len(key) > 4096:
                raise ValueError()
            if not key.isascii() or any(ord(c) < 32 or ord(c) == 127 for c in base + model + key):
                raise ValueError()
        except (ValidationError, ValueError, TypeError):
            raise HTTPException(422, "模型配置无效：API Key 模式需填写地址、模型和密钥；ADC 模式需填写有效的 Google Cloud 项目 ID、区域及对应原生地址；ChatGPT 套餐模式只支持 https://api.openai.com/v1。更换服务地址时需重新填写密钥。") from None
        return self.current.model_copy(update={
            "llm_base_url": base, "llm_model": model, "llm_api_key": SecretStr(key),
            "llm_auth_mode": data.auth_mode, "llm_project_id": project, "llm_location": location,
        })

    def _raw(self) -> dict:
        with self.lock:
            # On Windows a concurrent os.replace can briefly make the file unreadable;
            # retry instead of reporting an empty config (which drops the workspace).
            for attempt in range(RAW_READ_ATTEMPTS):
                if not self.path.exists():
                    return {}
                try:
                    data = json.loads(self.path.read_text(encoding="utf-8"))
                    break
                except OSError:
                    if attempt == RAW_READ_ATTEMPTS - 1:
                        return {}
                    time.sleep(0.02 * (attempt + 1))
                except ValueError:
                    return {}
            return data if isinstance(data, dict) else {}

    def _write(self, payload: dict) -> None:
        with self.lock:
            self._write_locked(payload)

    def _write_locked(self, payload: dict) -> None:
        temporary = None
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            fd, temporary = tempfile.mkstemp(dir=self.path.parent, prefix=".ai-settings-")
            with os.fdopen(fd, "w", encoding="utf-8") as output:
                json.dump(payload, output, ensure_ascii=False)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, self.path)
        except OSError:
            raise HTTPException(503, "AI 配置保存失败，请检查后端数据目录权限。") from None
        finally:
            if temporary and Path(temporary).exists():
                Path(temporary).unlink()

    def agent_config(self) -> dict:
        raw = self._raw()
        effort = raw.get("reasoning_effort")
        if effort not in {"off", "low", "medium", "high"}:
            effort = "medium"
        return {
            "workspace": raw.get("workspace") or "",
            "auto_approve": bool(raw.get("auto_approve")),
            "memory_write_approval": bool(raw.get("memory_write_approval")),
            "reasoning_effort": effort,
            "coordinator_wakeup": bool(raw.get("coordinator_wakeup", True)),
        }

    def save_agent(self, body: dict) -> dict:
        with self.lock:
            payload = self._raw()
            if "workspace" in body:
                workspace = body.get("workspace", "")
                if not isinstance(workspace, str) or len(workspace) > 500:
                    raise HTTPException(422, "工作区路径无效。")
                workspace = workspace.strip()
                if workspace and not Path(workspace).is_dir():
                    raise HTTPException(422, "工作区必须是已存在的文件夹。")
                payload["workspace"] = workspace
            if "auto_approve" in body:
                payload["auto_approve"] = bool(body.get("auto_approve"))
            if "memory_write_approval" in body:
                payload["memory_write_approval"] = bool(body.get("memory_write_approval"))
            if "reasoning_effort" in body:
                effort = body.get("reasoning_effort")
                if effort not in {"off", "low", "medium", "high"}:
                    raise HTTPException(422, "思考深度选项无效。")
                payload["reasoning_effort"] = effort
            if "coordinator_wakeup" in body:
                payload["coordinator_wakeup"] = bool(body.get("coordinator_wakeup"))
            self._write(payload)
        return self.agent_config()

    def status(self) -> dict:
        with self.lock:
            self._sync_current()
            settings = self.current
            has_key = settings.llm_auth_mode == "api_key" and bool(settings.llm_api_key.get_secret_value())
            chatgpt = self.chatgpt.status() if self.chatgpt is not None else {
                "connected": False, "email": "", "plan_enabled": False, "reauth_required": False,
                "accounts": [], "error": "",
            }
            usable = settings.llm_configured
            if settings.llm_auth_mode == "chatgpt":
                usable = usable and bool(chatgpt.get("connected") and chatgpt.get("plan_enabled"))
            return {"base_url": settings.llm_base_url, "model": settings.llm_model,
                    "has_api_key": has_key,
                    "auth_mode": settings.llm_auth_mode, "project_id": settings.llm_project_id,
                    "location": settings.llm_location, "chatgpt": chatgpt,
                    "configured": usable}

    def save(self, body: dict) -> dict:
        with self.lock:
            candidate = self.candidate(body)
            payload = self._raw()
            payload.update({"base_url": candidate.llm_base_url, "model": candidate.llm_model,
                            "api_key": candidate.llm_api_key.get_secret_value(),
                            "auth_mode": candidate.llm_auth_mode, "project_id": candidate.llm_project_id,
                            "location": candidate.llm_location})
            self._write(payload)
            self.library.apply_legacy(candidate)
            self.current = candidate
            return self.status()

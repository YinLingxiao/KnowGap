"""Local demo model configuration; secrets never appear in public responses."""

import json
import os
import tempfile
from pathlib import Path
from threading import RLock
from urllib.parse import urlsplit

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, SecretStr, ValidationError

from app.config import Settings


class ConfigurationInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    base_url: str
    model: str
    api_key: SecretStr | None = None


class AISettings:
    def __init__(self, settings: Settings):
        self.path = settings.resolved_database_path().parent / "ai-settings.json"
        self.lock = RLock()
        self.current = settings
        if self.path.exists():
            try:
                self.current = self.candidate(json.loads(self.path.read_text(encoding="utf-8")))
            except (OSError, ValueError, HTTPException):
                raise RuntimeError("无法读取本地 AI 配置，请检查 ai-settings.json。") from None

    def candidate(self, body: dict) -> Settings:
        try:
            data = ConfigurationInput.model_validate(body)
            base = data.base_url.strip().rstrip("/")
            url = urlsplit(base)
            valid = (url.scheme in {"http", "https"} and bool(url.hostname)
                     and not url.username and not url.password and not url.query and not url.fragment)
            _ = url.port
            model = data.model.strip()
            key = data.api_key.get_secret_value().strip() if data.api_key is not None else ""
            # Empty password fields preserve the existing secret for the SAME provider only.
            if not key and base == self.current.llm_base_url.strip().rstrip("/"):
                key = self.current.llm_api_key.get_secret_value()
            if not valid or not model or len(model) > 200 or not key or len(key) > 4096:
                raise ValueError()
            if not key.isascii() or any(ord(c) < 32 or ord(c) == 127 for c in base + model + key):
                raise ValueError()
        except (ValidationError, ValueError, TypeError):
            raise HTTPException(422, "请填写有效的 API 根地址、模型名称和 API Key；更换服务地址时需重新填写密钥。") from None
        return self.current.model_copy(update={
            "llm_base_url": base, "llm_model": model, "llm_api_key": SecretStr(key),
        })

    def status(self) -> dict:
        with self.lock:
            settings = self.current
            has_key = bool(settings.llm_api_key.get_secret_value())
            return {"base_url": settings.llm_base_url, "model": settings.llm_model,
                    "has_api_key": has_key,
                    "configured": has_key and bool(settings.llm_base_url and settings.llm_model)}

    def save(self, body: dict) -> dict:
        with self.lock:
            candidate = self.candidate(body)
            payload = {"base_url": candidate.llm_base_url, "model": candidate.llm_model,
                       "api_key": candidate.llm_api_key.get_secret_value()}
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
            self.current = candidate
            return self.status()

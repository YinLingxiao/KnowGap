"""Service-model configuration: which model is the eyes, which is the brain, plus feature switches.

Stored under `service_models` in the existing ai-settings.json; every other key in that file is kept,
and writes take AISettings' own lock so the two writers never lose each other's changes.
VISION_* in backend/.env is the fallback for the vision model. Secrets never leave the backend:
the public view only reports whether a key is configured.
"""

import json
import time
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, SecretStr, ValidationError
from pydantic_settings import BaseSettings, SettingsConfigDict

from app.config import BACKEND_ROOT, REPO_ROOT, Settings
from app.vision._fs import atomic_write_json
from app.vision.schemas import BBOX_FORMATS, ServiceModelsConfig

SECTION = "service_models"
MODEL_SECTIONS = ("logic_model", "vision_model")
FLAGS = ("suggest_reply_enabled", "dual_model_relay", "circuit_confirm_first")
INVALID = "服务模型配置无效：请检查 API 地址、模型名称和 API Key；更换服务地址时需要重新填写密钥。"


class VisionConfig(BaseModel):
    """Resolved settings for one vision-model call."""

    model_config = ConfigDict(frozen=True)

    base_url: str = ""
    model: str = ""
    api_key: SecretStr = SecretStr("")
    bbox_format: str = "xyxy_1000"
    # Non-streaming: the read timeout covers the whole generation, and dense pages take a while.
    timeout_seconds: float = 120
    # The VLM only transcribes and boxes. Qwen's thinking doubled latency and timed out in testing.
    disable_thinking: bool = True
    source: str = "none"  # service_models | env | logic | none

    @property
    def configured(self) -> bool:
        return bool(self.base_url and self.model and self.api_key.get_secret_value())


class _VisionEnv(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="VISION_", env_file=(REPO_ROOT / ".env", BACKEND_ROOT / ".env"),
        env_file_encoding="utf-8", extra="ignore",
    )

    base_url: str = ""
    model: str = ""
    api_key: SecretStr = SecretStr("")
    bbox_format: str = "xyxy_1000"
    timeout_seconds: float = Field(default=120, gt=0, le=180)
    disable_thinking: bool = True


def config_from_env() -> VisionConfig:
    env = _VisionEnv()
    if env.bbox_format not in BBOX_FORMATS:
        # A wrong convention silently misplaces every circle, so fail loudly at startup.
        raise RuntimeError(f"VISION_BBOX_FORMAT 必须是 {', '.join(BBOX_FORMATS)} 之一。")
    return VisionConfig(
        base_url=env.base_url.strip().rstrip("/"), model=env.model.strip(), api_key=env.api_key,
        bbox_format=env.bbox_format, timeout_seconds=env.timeout_seconds,
        disable_thinking=env.disable_thinking, source="env",
    )


def _valid_base(base: str) -> bool:
    try:
        url = urlsplit(base)
        _ = url.port
    except ValueError:
        return False
    return (url.scheme in {"http", "https"} and bool(url.hostname)
            and not url.username and not url.password and not url.query and not url.fragment)


def _plain(cfg: ServiceModelsConfig) -> dict:
    data = cfg.model_dump()
    for name in MODEL_SECTIONS:
        data[name]["api_key"] = getattr(cfg, name).api_key.get_secret_value()
    return data


def _check_endpoint(section: dict) -> dict:
    base = str(section.get("base_url") or "").strip().rstrip("/")
    model = str(section.get("model") or "").strip()
    key = str(section.get("api_key") or "").strip()
    if any(ord(c) < 32 or ord(c) == 127 for c in base + model + key):
        raise HTTPException(422, INVALID)
    if base and (not _valid_base(base) or not model or not key):
        raise HTTPException(422, INVALID)
    if key and (not base or not key.isascii() or len(key) > 4096):
        raise HTTPException(422, INVALID)
    return {**section, "base_url": base, "model": model, "api_key": key}


class ServiceModels:
    def __init__(self, ai_settings, env: VisionConfig | None = None):
        self.ai = ai_settings  # app.services.ai_settings.AISettings
        self.env = env if env is not None else config_from_env()

    @property
    def path(self) -> Path:
        return self.ai.path

    def _read_file(self) -> dict:
        """The whole ai-settings.json. Raises rather than returning {}, so a save never drops other keys."""
        for attempt in range(4):
            if not self.path.exists():
                return {}
            try:
                data = json.loads(self.path.read_text(encoding="utf-8"))
                return data if isinstance(data, dict) else {}
            except OSError:
                # A concurrent os.replace on Windows can briefly make the file unreadable.
                time.sleep(0.02 * (attempt + 1))
            except ValueError:
                raise HTTPException(503, "本地 AI 配置文件已损坏，请检查 ai-settings.json。") from None
        raise HTTPException(503, "暂时无法读取本地 AI 配置，请稍后重试。")

    @staticmethod
    def _parse(raw) -> ServiceModelsConfig:
        try:
            return ServiceModelsConfig.model_validate(raw) if isinstance(raw, dict) else ServiceModelsConfig()
        except ValidationError:
            return ServiceModelsConfig()  # older or hand-edited file: fall back to defaults

    def config(self) -> ServiceModelsConfig:
        return self._parse(self._read_file().get(SECTION))

    def save(self, body) -> dict:
        if not isinstance(body, dict) or set(body) - {*MODEL_SECTIONS, "memory_model", *FLAGS}:
            raise HTTPException(422, INVALID)
        with self.ai.lock:
            payload = self._read_file()
            merged = _plain(self._parse(payload.get(SECTION)))
            for name in (*MODEL_SECTIONS, "memory_model"):
                if name not in body:
                    continue
                incoming = body[name]
                if incoming is None:
                    merged[name] = {}
                    continue
                if not isinstance(incoming, dict):
                    raise HTTPException(422, INVALID)
                # Display-only fields from GET may be echoed back by the settings panel.
                incoming = {k: v for k, v in incoming.items() if k not in {"api_key_configured", "effective"}}
                old = merged[name]
                section = {**old, **incoming}
                if name in MODEL_SECTIONS:
                    if incoming.get("api_key") is not None and not isinstance(incoming.get("api_key"), str):
                        raise HTTPException(422, INVALID)
                    if not str(incoming.get("api_key") or "").strip():
                        # A blank key keeps the saved secret, but only for the SAME provider address.
                        same = (str(section.get("base_url") or "").strip().rstrip("/")
                                == str(old.get("base_url") or "").strip().rstrip("/"))
                        section["api_key"] = old.get("api_key", "") if same else ""
                    section = _check_endpoint(section)
                merged[name] = section
            for flag in FLAGS:
                if flag in body:
                    if not isinstance(body[flag], bool):
                        raise HTTPException(422, INVALID)
                    merged[flag] = body[flag]
            try:
                cfg = ServiceModelsConfig.model_validate(merged)
            except ValidationError:
                raise HTTPException(422, INVALID) from None
            payload[SECTION] = _plain(cfg)
            try:
                atomic_write_json(self.path, payload)
            except OSError:
                raise HTTPException(503, "服务模型配置保存失败，请检查后端数据目录权限。") from None
        return self.public()

    # ---- resolution ----
    def logic_settings(self, cfg: ServiceModelsConfig | None = None) -> tuple[Settings, str]:
        cfg = cfg or self.config()
        base: Settings = self.ai.current
        logic = cfg.logic_model
        if not logic.model:
            return base, "global"
        if logic.base_url:
            return base.model_copy(update={"llm_base_url": logic.base_url, "llm_model": logic.model,
                                           "llm_api_key": logic.api_key}), "service_models"
        return base.model_copy(update={"llm_model": logic.model}), "service_models"

    def vision_config(self, cfg: ServiceModelsConfig | None = None) -> VisionConfig:
        cfg = cfg or self.config()
        vision = cfg.vision_model
        common = {"timeout_seconds": self.env.timeout_seconds, "disable_thinking": self.env.disable_thinking}
        if vision.enabled and vision.model:
            if vision.base_url:
                endpoint = {"base_url": vision.base_url, "api_key": vision.api_key}
            else:
                logic, _ = self.logic_settings(cfg)
                endpoint = {"base_url": logic.llm_base_url.strip().rstrip("/"), "api_key": logic.llm_api_key}
            return VisionConfig(model=vision.model, bbox_format=vision.bbox_format, source="service_models",
                                **endpoint, **common)
        if self.env.configured:
            return self.env
        logic, _ = self.logic_settings(cfg)
        return VisionConfig(base_url=logic.llm_base_url.strip().rstrip("/"), model=logic.llm_model.strip(),
                            api_key=logic.llm_api_key, bbox_format=vision.bbox_format, source="logic",
                            timeout_seconds=self.env.timeout_seconds, disable_thinking=False)

    def public(self) -> dict:
        cfg = self.config()
        logic, logic_source = self.logic_settings(cfg)
        vision = self.vision_config(cfg)
        memory_model = cfg.memory_model.model if cfg.memory_model.enabled and cfg.memory_model.model else logic.llm_model
        logic_ready = bool(logic.llm_api_key.get_secret_value() and logic.llm_base_url.strip() and logic.llm_model.strip())
        return {
            "logic_model": {
                "base_url": cfg.logic_model.base_url, "model": cfg.logic_model.model,
                "api_key_configured": bool(cfg.logic_model.api_key.get_secret_value()),
                "effective": {"model": logic.llm_model, "source": logic_source, "configured": logic_ready},
            },
            "vision_model": {
                "base_url": cfg.vision_model.base_url, "model": cfg.vision_model.model,
                "enabled": cfg.vision_model.enabled, "bbox_format": cfg.vision_model.bbox_format,
                "api_key_configured": bool(cfg.vision_model.api_key.get_secret_value()),
                "effective": {"model": vision.model, "source": vision.source, "configured": vision.configured,
                              "bbox_format": vision.bbox_format},
            },
            "memory_model": {
                "model": cfg.memory_model.model, "enabled": cfg.memory_model.enabled,
                "effective": {"model": memory_model,
                              "source": "service_models" if memory_model != logic.llm_model else "logic"},
            },
            **{flag: getattr(cfg, flag) for flag in FLAGS},
        }

"""模型库：多服务商、多模型。密钥只写入 model-library.json。"""

import json
import logging
import os
import re
import tempfile
import time
from pathlib import Path
from threading import RLock

import httpx
from fastapi import HTTPException
from pydantic import SecretStr, ValidationError

from app.agents.llm import ProviderError, is_vertex_native
from app.config import Settings
from app.models.model_library_schemas import (
    NO_MODEL_DETAIL, URL_KEY_RESET_DETAIL, SERVICE_ROLES, PROVIDER_ID, AffectedRefs, CatalogModel,
    DeleteProviderResult, ModelCandidate, ModelCreate, ModelEntry, ModelLibraryFile, ModelTags,
    ModelUpdate, Provider, ProviderCreate, ProviderPublic, ProviderUpdate, ServiceModelSelection,
    ServiceRole, make_model_key, new_provider_id, parse_model_key,
)

logger = logging.getLogger(__name__)

FETCH_LIMIT = 300
FETCH_TIMEOUT = 20.0
FETCH_BYTES = 1_500_000
VERTEX_MODELS = (
    "gemini-4-argon",
    "gemini-2.5-pro",
    "gemini-2.5-flash",
    "gemini-2.0-flash",
)
_PRESET_URLS = {
    "https://api.deepseek.com/v1": ("deepseek", "DeepSeek"),
    "https://dashscope.aliyuncs.com/compatible-mode/v1": ("qwen", "通义千问"),
    "https://ark.cn-beijing.volces.com/api/v3": ("ark", "火山方舟"),
    "https://api.moonshot.cn/v1": ("moonshot", "Kimi"),
    "https://open.bigmodel.cn/api/paas/v4": ("zhipu", "智谱 GLM"),
    "https://api.openai.com/v1": ("openai", "OpenAI"),
}
_NON_CHAT = re.compile(
    r"(?:embed|tts|whisper|dall-?e|diffusion|(?:^|[-_./])image(?:[-_./]|$)|moderation|realtime|transcri|"
    r"(?:^|[-_./])speech(?:[-_./]|$)|(?:^|[-_./])audio(?:[-_./]|$)|rerank|(?:^|[-_./])clip(?:[-_./]|$))",
    re.I,
)
_HIGH = re.compile(
    r"(?:reasoner|thinking|(?:^|[-_./])r1(?:[-_./]|$)|(?:^|[-_./])o[134](?:[-_./]|$))",
    re.I,
)
_VISION = re.compile(
    r"(?:vision|(?:^|[-_./])vl(?:[-_./]|$)|(?:^|[-_./])4o(?:[-_./]|$)|omni)",
    re.I,
)
_TOOLS = re.compile(r"(?:deepseek|gpt|gemini|qwen|glm|moonshot|kimi|claude)", re.I)
_PRO = re.compile(r"(?:^|[-_./])pro(?:[-_./]|$)", re.I)
_LEGACY_KEYS = ("base_url", "model", "api_key", "auth_mode", "project_id", "location")


def guess_tags(model_id: str) -> ModelTags:
    name = model_id.strip()
    return ModelTags(
        reasoning="high" if _HIGH.search(name) else "none",
        vision=bool(_VISION.search(name)),
        tools=bool(_TOOLS.search(name)),
        label="Pro" if _PRO.search(name) else None,
    )


def infer_preset(base_url: str, auth_mode: str) -> tuple[str, str]:
    if auth_mode == "chatgpt":
        return "chatgpt", "ChatGPT 套餐"
    if is_vertex_native(base_url):
        return "vertex", "Google Vertex AI"
    return _PRESET_URLS.get(base_url, ("custom", "自定义"))


VERTEX_URL_DETAIL = "Vertex Express 请使用原生地址 https://aiplatform.googleapis.com/v1/publishers/google/models，不要追加模型名或其他路径。"


def _check_vertex_url(preset: str, auth_mode: str, base_url: str) -> None:
    # ADC roots are already pinned to the project by _candidate; an Express key needs the native root,
    # otherwise requests silently go to /chat/completions and only fail with a 404 at chat time.
    if preset == "vertex" and auth_mode == "api_key" and not is_vertex_native(base_url):
        raise HTTPException(422, VERTEX_URL_DETAIL)


def _blank() -> Settings:
    return Settings(
        _env_file=None, llm_api_key="", llm_base_url="", llm_model="",
        llm_auth_mode="api_key", llm_project_id="", llm_location="global",
    )


def _candidate(current: Settings, body: dict) -> Settings:
    from app.services.ai_settings import AISettings
    holder = object.__new__(AISettings)
    holder.current = current
    return AISettings.candidate(holder, body)


def _settings(provider: Provider, model_id: str) -> Settings:
    return Settings(
        _env_file=None,
        llm_base_url=provider.base_url,
        llm_model=model_id,
        llm_api_key=provider.api_key,
        llm_auth_mode=provider.auth_mode,
        llm_project_id=provider.project_id,
        llm_location=provider.location or "global",
    )


def _usable(data: ModelLibraryFile, model_key: str | None) -> tuple[Provider, ModelEntry] | None:
    if not model_key:
        return None
    try:
        provider_id, model_id = parse_model_key(model_key)
    except ValueError:
        return None
    if PROVIDER_ID.fullmatch(provider_id) is None:
        return None
    provider = next((item for item in data.providers if item.id == provider_id and item.enabled), None)
    if provider is None:
        return None
    model = next((item for item in provider.models if item.id == model_id and item.enabled), None)
    if model is None:
        return None
    return provider, model


def _select(data: ModelLibraryFile, model_key: str | None) -> tuple[Provider, ModelEntry] | None:
    found = _usable(data, model_key)
    if found is not None:
        return found
    return _usable(data, data.default_model)


def _items(payload: object) -> list:
    if isinstance(payload, dict):
        raw = payload.get("data")
        if not isinstance(raw, list):
            raw = payload.get("models")
        return raw if isinstance(raw, list) else []
    return payload if isinstance(payload, list) else []


def _candidates(payload: object, secret: str) -> list[ModelCandidate]:
    result: list[ModelCandidate] = []
    seen: set[str] = set()
    for item in _items(payload):
        if len(result) >= FETCH_LIMIT:
            break
        if isinstance(item, str):
            model_id, raw_name = item, item
        elif isinstance(item, dict):
            model_id = item.get("id") or item.get("slug") or item.get("name")
            raw_name = item.get("display_name") or item.get("name") or model_id
        else:
            continue
        if not isinstance(model_id, str) or _NON_CHAT.search(model_id):
            continue
        if secret and secret in model_id:
            continue
        name = raw_name if isinstance(raw_name, str) else model_id
        if secret and isinstance(name, str) and secret in name:
            name = model_id
        entry = _entry(model_id, name)
        if entry is None or entry.id in seen:
            continue
        seen.add(entry.id)
        result.append(ModelCandidate(id=entry.id, name=entry.name, tags=entry.tags))
    return result


def _entry(model_id: str, name: str) -> ModelEntry | None:
    tags = guess_tags(model_id)
    try:
        return ModelEntry(id=model_id, name=name, tags=tags)
    except ValidationError:
        try:
            return ModelEntry(id=model_id, name=model_id.strip(), tags=tags)
        except ValidationError:
            return None


def _builtin_vertex() -> list[ModelCandidate]:
    return [ModelCandidate(id=model_id, name=model_id, tags=guess_tags(model_id)) for model_id in VERTEX_MODELS]


class ModelLibrary:
    def __init__(self, settings: Settings):
        self.path = settings.resolved_database_path().parent / "model-library.json"
        self.env = settings
        self.lock = RLock()
        self.chatgpt = None
        self.on_change = None
        self._state = self._load_or_migrate()

    def resolve(self, model_key: str | None) -> Settings:
        with self.lock:
            found = _select(self._state, model_key)
            if found is None:
                raise ProviderError(503, NO_MODEL_DETAIL)
            return _settings(found[0], found[1].id)

    def effective_key(self, model_key: str | None) -> str | None:
        with self.lock:
            found = _select(self._state, model_key)
            if found is None:
                return None
            return make_model_key(found[0].id, found[1].id)

    def service_settings(self, role: ServiceRole) -> Settings:
        if role not in SERVICE_ROLES:
            raise ProviderError(422, "服务模型角色无效。")
        with self.lock:
            key = getattr(self._state.service_models, role)
        return self.resolve(key)

    def public_providers(self) -> list[ProviderPublic]:
        with self.lock:
            return [item.public() for item in self._state.providers]

    def catalog(self) -> list[CatalogModel]:
        with self.lock:
            data = self._state
            items = []
            for provider in data.providers:
                if not provider.enabled:
                    continue
                for model in provider.models:
                    if not model.enabled:
                        continue
                    key = make_model_key(provider.id, model.id)
                    items.append(CatalogModel(
                        key=key, provider_id=provider.id, provider_name=provider.name,
                        model_id=model.id, name=model.name, tags=model.tags.model_copy(deep=True),
                        is_default=key == data.default_model,
                    ))
            return items

    def create_provider(self, body: ProviderCreate) -> Provider:
        key = body.api_key.get_secret_value() if body.api_key is not None else ""
        checked = _candidate(_blank(), {
            "base_url": body.base_url, "model": "placeholder-model", "api_key": key,
            "auth_mode": body.auth_mode, "project_id": body.project_id, "location": body.location,
        })
        _check_vertex_url(body.preset, checked.llm_auth_mode, checked.llm_base_url)
        with self.lock:
            data = self._state.model_copy(deep=True)
            provider = Provider(
                id=self._new_id(data), name=body.name, preset=body.preset,
                base_url=checked.llm_base_url, auth_mode=checked.llm_auth_mode,
                api_key=SecretStr(checked.llm_api_key.get_secret_value() if body.auth_mode == "api_key" else ""),
                project_id=checked.llm_project_id if body.auth_mode == "adc" else body.project_id,
                location=(checked.llm_location if body.auth_mode == "adc" else body.location) or "global",
            )
            data.providers.append(provider)
            self._commit(data)
            return provider

    def update_provider(self, provider_id: str, patch: ProviderUpdate) -> Provider:
        with self.lock:
            data = self._state.model_copy(deep=True)
            provider = self._provider(data, provider_id)
            next_auth = provider.auth_mode if patch.auth_mode is None else patch.auth_mode
            next_url = provider.base_url if patch.base_url is None else patch.base_url
            next_project = provider.project_id if patch.project_id is None else patch.project_id
            next_location = provider.location if patch.location is None else patch.location
            supplied = patch.supplied_api_key()
            if next_auth == "api_key" and next_url != provider.base_url and not (supplied or "").strip():
                raise HTTPException(422, URL_KEY_RESET_DETAIL)
            if next_auth == "api_key" and supplied is not None and not supplied.strip():
                raise HTTPException(422, "API Key 模式需要填写密钥。")
            if next_auth == "api_key" and supplied is None and not provider.api_key.get_secret_value().strip():
                raise HTTPException(422, "API Key 模式需要填写密钥。")
            key_arg = "" if next_auth != "api_key" else (supplied if supplied is not None else "")
            checked = _candidate(_settings(provider, "placeholder-model"), {
                "base_url": next_url, "model": "placeholder-model", "api_key": key_arg,
                "auth_mode": next_auth, "project_id": next_project, "location": next_location,
            })
            _check_vertex_url(provider.preset, checked.llm_auth_mode, checked.llm_base_url)
            if patch.name is not None:
                provider.name = patch.name
            provider.base_url = checked.llm_base_url
            provider.auth_mode = checked.llm_auth_mode
            provider.api_key = SecretStr(checked.llm_api_key.get_secret_value() if next_auth == "api_key" else "")
            if next_auth == "adc":
                provider.project_id = checked.llm_project_id
                provider.location = checked.llm_location or "global"
            else:
                provider.project_id = next_project
                provider.location = next_location or "global"
            if patch.enabled is not None:
                provider.enabled = patch.enabled
            self._commit(data)
            return provider

    def delete_provider(self, provider_id: str) -> DeleteProviderResult:
        with self.lock:
            data = self._state.model_copy(deep=True)
            provider = self._provider(data, provider_id)
            data.providers = [item for item in data.providers if item.id != provider.id]
            affected = self._clear_provider(data, provider.id)
            self._commit(data)
            return DeleteProviderResult(affected=affected)

    def create_model(self, provider_id: str, body: ModelCreate) -> ModelEntry:
        with self.lock:
            data = self._state.model_copy(deep=True)
            provider = self._provider(data, provider_id)
            if any(item.id == body.id for item in provider.models):
                raise HTTPException(409, "这个服务商下已经有相同的模型。")
            entry = ModelEntry(id=body.id, name=body.name or body.id, tags=body.tags or ModelTags())
            provider.models.append(entry)
            self._commit(data)
            return entry

    def update_model(self, provider_id: str, model_id: str, patch: ModelUpdate) -> ModelEntry:
        with self.lock:
            data = self._state.model_copy(deep=True)
            model = self._model(self._provider(data, provider_id), model_id)
            if patch.name is not None:
                model.name = patch.name
            if patch.enabled is not None:
                model.enabled = patch.enabled
            if patch.tags is not None:
                model.tags = patch.tags.apply(model.tags)
            self._commit(data)
            return model

    def delete_model(self, provider_id: str, model_id: str) -> DeleteProviderResult:
        with self.lock:
            data = self._state.model_copy(deep=True)
            provider = self._provider(data, provider_id)
            model = self._model(provider, model_id)
            provider.models = [item for item in provider.models if item.id != model.id]
            affected = self._clear_key(data, make_model_key(provider.id, model.id))
            self._commit(data)
            return DeleteProviderResult(affected=affected)

    def fetch(self, provider_id: str) -> list[ModelCandidate]:
        with self.lock:
            provider = self._provider(self._state, provider_id).model_copy(deep=True)
        if provider.auth_mode == "chatgpt" or provider.preset == "chatgpt":
            return self._fetch_chatgpt()
        if provider.auth_mode == "adc" or provider.preset == "vertex" or is_vertex_native(provider.base_url):
            return _builtin_vertex()
        return self._fetch_openai(provider)

    def settings_for(self, provider_id: str, model_id: str) -> Settings:
        with self.lock:
            provider = self._provider(self._state, provider_id)
            if _entry(model_id, model_id) is None:
                raise HTTPException(422, "模型 ID 无效。")
            if provider.auth_mode == "api_key" and not provider.api_key.get_secret_value().strip():
                raise HTTPException(422, "API Key 模式需要填写密钥。")
            return _settings(provider, model_id.strip())

    def get_default(self) -> str | None:
        with self.lock:
            return self._state.default_model

    def set_default(self, key: str) -> str:
        with self.lock:
            data = self._state.model_copy(deep=True)
            found = _usable(data, key)
            if found is None:
                self._require_existing(data, key)
                raise HTTPException(422, "这个服务商或模型未启用。")
            data.default_model = make_model_key(found[0].id, found[1].id)
            self._commit(data)
            return data.default_model

    def get_service(self) -> ServiceModelSelection:
        with self.lock:
            return self._state.service_models.model_copy(deep=True)

    def set_service(self, selection: ServiceModelSelection) -> ServiceModelSelection:
        with self.lock:
            data = self._state.model_copy(deep=True)
            stored = {}
            for role in SERVICE_ROLES:
                key = getattr(selection, role)
                if key is None:
                    stored[role] = None
                    continue
                provider, model = self._require_existing(data, key)
                stored[role] = make_model_key(provider.id, model.id)
            data.service_models = ServiceModelSelection.model_validate(stored)
            self._commit(data)
            return data.service_models

    def apply_legacy(self, candidate: Settings) -> None:
        with self.lock:
            data = self._state.model_copy(deep=True)
            provider, model_id = self._default_parts(data)
            preset, _title = infer_preset(candidate.llm_base_url, candidate.llm_auth_mode)
            if provider is None:
                created = self._provider_from_settings(candidate, data)
                data.providers.append(created)
                data.default_model = make_model_key(created.id, candidate.llm_model)
                self._commit(data)
                return
            old_key = make_model_key(provider.id, model_id) if model_id else None
            provider.base_url = candidate.llm_base_url
            provider.auth_mode = candidate.llm_auth_mode
            provider.api_key = SecretStr(candidate.llm_api_key.get_secret_value())
            provider.project_id = candidate.llm_project_id
            provider.location = candidate.llm_location or "global"
            provider.preset = preset
            provider.enabled = True
            new_id = candidate.llm_model
            existing = next((item for item in provider.models if item.id == new_id), None)
            if existing is not None:
                existing.enabled = True
                data.default_model = make_model_key(provider.id, existing.id)
            else:
                current = next((item for item in provider.models if model_id and item.id == model_id), None)
                if current is None:
                    provider.models.append(ModelEntry(id=new_id, name=new_id, enabled=True, tags=guess_tags(new_id)))
                    data.default_model = make_model_key(provider.id, new_id)
                else:
                    current.id = new_id
                    current.name = new_id
                    current.enabled = True
                    new_key = make_model_key(provider.id, new_id)
                    self._retarget(data, old_key, new_key)
                    data.default_model = new_key
            self._commit(data)

    def _load_or_migrate(self) -> ModelLibraryFile:
        if self.path.exists():
            return self._read_file()
        source = self._migration_source()
        roles = self._legacy_service_roles()
        if source is None and not roles:
            return ModelLibraryFile()
        data = ModelLibraryFile()
        if source is not None:
            provider = self._provider_from_settings(source, data)
            data.providers.append(provider)
            data.default_model = make_model_key(provider.id, source.llm_model)
        self._migrate_service_roles(data, roles)
        self._atomic(data.dump_stored(), startup=True)
        return data

    def _legacy_service_roles(self) -> list[tuple[ServiceRole, str, str, str]]:
        """Service models the old ai-settings.json used: (role, base_url, model, api_key)."""
        path = self.path.parent / "ai-settings.json"
        try:
            raw = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
        except (OSError, ValueError):
            return []
        sections = raw.get("service_models") if isinstance(raw, dict) else None
        if not isinstance(sections, dict):
            return []
        found: list[tuple[ServiceRole, str, str, str]] = []
        for name, role in (("logic_model", "logic"), ("vision_model", "vision"), ("memory_model", "memory")):
            section = sections.get(name)
            if not isinstance(section, dict):
                continue
            model = str(section.get("model") or "").strip()
            # The old vision and memory sections were opt-in; importing a disabled one would switch it on.
            if not model or (role != "logic" and not section.get("enabled")):
                continue
            found.append((role, str(section.get("base_url") or "").strip(), model, str(section.get("api_key") or "").strip()))
        return found

    def _migrate_service_roles(self, data: ModelLibraryFile, roles: list[tuple[ServiceRole, str, str, str]]) -> None:
        """Carry per-role models into the library so the new selectors show what is really in use."""
        chosen: dict[str, str] = {}
        for role, base_url, model, api_key in roles:
            provider: Provider | None
            if base_url:
                try:
                    candidate = _candidate(self.env, {
                        "base_url": base_url, "model": model, "api_key": api_key, "auth_mode": "api_key",
                    })
                except HTTPException:
                    continue
                provider = next((
                    item for item in data.providers
                    if item.auth_mode == "api_key" and item.base_url == candidate.llm_base_url
                    and item.api_key.get_secret_value() == candidate.llm_api_key.get_secret_value()
                ), None)
                if provider is None:
                    provider = self._provider_from_settings(candidate, data)
                    provider.models = []
                    data.providers.append(provider)
            else:
                # No endpoint of its own: the old code used the main model's endpoint with another model name.
                provider, _ = self._default_parts(data)
                if provider is None:
                    continue
            entry = next((item for item in provider.models if item.id == model), None)
            if entry is None:
                entry = ModelEntry(id=model, name=model, tags=guess_tags(model))
                provider.models.append(entry)
            if role == "vision":
                entry.tags.vision = True
            key = make_model_key(provider.id, model)
            # A service model that equals the default is the same as "follow the default".
            if key != data.default_model:
                chosen[role] = key
        if chosen:
            data.service_models = ServiceModelSelection.model_validate({**data.service_models.model_dump(), **chosen})

    def _migration_source(self) -> Settings | None:
        legacy = self._from_legacy_file()
        if legacy is not None:
            return legacy
        return self._from_env()

    def _from_legacy_file(self) -> Settings | None:
        path = self.path.parent / "ai-settings.json"
        if not path.exists():
            return None
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        if not isinstance(raw, dict) or not raw.get("base_url") or not raw.get("model"):
            return None
        try:
            return _candidate(self.env, {key: raw[key] for key in _LEGACY_KEYS if key in raw})
        except HTTPException:
            return None

    def _from_env(self) -> Settings | None:
        if not (self.env.llm_base_url.strip() and self.env.llm_model.strip()):
            return None
        try:
            return _candidate(_blank(), {
                "base_url": self.env.llm_base_url, "model": self.env.llm_model,
                "api_key": self.env.llm_api_key.get_secret_value(), "auth_mode": self.env.llm_auth_mode,
                "project_id": self.env.llm_project_id, "location": self.env.llm_location,
            })
        except HTTPException:
            return None

    def _provider_from_settings(self, candidate: Settings, data: ModelLibraryFile) -> Provider:
        preset, title = infer_preset(candidate.llm_base_url, candidate.llm_auth_mode)
        return Provider(
            id=self._new_id(data), name=title, preset=preset, base_url=candidate.llm_base_url,
            auth_mode=candidate.llm_auth_mode, api_key=SecretStr(candidate.llm_api_key.get_secret_value()),
            project_id=candidate.llm_project_id, location=candidate.llm_location or "global",
            models=[ModelEntry(id=candidate.llm_model, name=candidate.llm_model, tags=guess_tags(candidate.llm_model))],
        )

    def _read_file(self) -> ModelLibraryFile:
        raw = None
        for attempt in range(4):
            try:
                raw = json.loads(self.path.read_text(encoding="utf-8"))
                break
            except OSError:
                if attempt == 3:
                    raise RuntimeError("无法读取本地模型库，请检查 model-library.json。") from None
                time.sleep(0.02 * (attempt + 1))
            except ValueError:
                raise RuntimeError("无法读取本地模型库，请检查 model-library.json。") from None
        if not isinstance(raw, dict):
            raise RuntimeError("无法读取本地模型库，请检查 model-library.json。")
        try:
            return ModelLibraryFile.model_validate(raw)
        except ValidationError:
            raise RuntimeError("无法读取本地模型库，请检查 model-library.json。") from None

    def _atomic(self, payload: dict, *, startup: bool = False) -> None:
        temporary = None
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            fd, temporary = tempfile.mkstemp(dir=self.path.parent, prefix=".model-library-")
            try:
                os.chmod(temporary, 0o600)
            except OSError:
                pass
            with os.fdopen(fd, "w", encoding="utf-8") as output:
                json.dump(payload, output, ensure_ascii=False)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, self.path)
            temporary = None
            try:
                os.chmod(self.path, 0o600)
            except OSError:
                pass
        except OSError:
            message = "模型库保存失败，请检查后端数据目录权限。"
            if startup:
                raise RuntimeError(message) from None
            raise HTTPException(503, message) from None
        finally:
            if temporary and Path(temporary).exists():
                Path(temporary).unlink()

    def _commit(self, data: ModelLibraryFile) -> None:
        self._atomic(data.dump_stored())
        self._state = data
        if self.on_change is not None:
            self.on_change()

    def _new_id(self, data: ModelLibraryFile) -> str:
        used = {item.id for item in data.providers}
        for _ in range(8):
            provider_id = new_provider_id()
            if provider_id not in used:
                return provider_id
        raise HTTPException(503, "暂时无法分配服务商 ID，请重试。")

    def _provider(self, data: ModelLibraryFile, provider_id: str) -> Provider:
        if PROVIDER_ID.fullmatch(provider_id or "") is None:
            raise HTTPException(404, "找不到这个服务商。")
        found = next((item for item in data.providers if item.id == provider_id), None)
        if found is None:
            raise HTTPException(404, "找不到这个服务商。")
        return found

    def _model(self, provider: Provider, model_id: str) -> ModelEntry:
        found = next((item for item in provider.models if item.id == model_id), None)
        if found is None:
            raise HTTPException(404, "找不到这个模型。")
        return found

    def _require_existing(self, data: ModelLibraryFile, key: str) -> tuple[Provider, ModelEntry]:
        try:
            provider_id, model_id = parse_model_key(key)
        except ValueError:
            raise HTTPException(422, "模型键必须是“服务商 ID/模型 ID”。") from None
        if PROVIDER_ID.fullmatch(provider_id) is None:
            raise HTTPException(422, "模型键必须是“服务商 ID/模型 ID”。")
        provider = next((item for item in data.providers if item.id == provider_id), None)
        if provider is None:
            raise HTTPException(404, "找不到这个服务商。")
        model = next((item for item in provider.models if item.id == model_id), None)
        if model is None:
            raise HTTPException(404, "找不到这个模型。")
        return provider, model

    def _clear_key(self, data: ModelLibraryFile, key: str) -> AffectedRefs:
        affected = AffectedRefs()
        if data.default_model == key:
            data.default_model = None
            affected.default_model = True
        roles = []
        for role in SERVICE_ROLES:
            if getattr(data.service_models, role) == key:
                setattr(data.service_models, role, None)
                roles.append(role)
        affected.service_models = roles
        return affected

    def _clear_provider(self, data: ModelLibraryFile, provider_id: str) -> AffectedRefs:
        prefix = f"{provider_id}/"
        affected = AffectedRefs()
        if data.default_model and data.default_model.startswith(prefix):
            data.default_model = None
            affected.default_model = True
        roles = []
        for role in SERVICE_ROLES:
            key = getattr(data.service_models, role)
            if key and key.startswith(prefix):
                setattr(data.service_models, role, None)
                roles.append(role)
        affected.service_models = roles
        return affected

    @staticmethod
    def _retarget(data: ModelLibraryFile, old_key: str | None, new_key: str) -> None:
        if not old_key or old_key == new_key:
            return
        if data.default_model == old_key:
            data.default_model = new_key
        for role in SERVICE_ROLES:
            if getattr(data.service_models, role) == old_key:
                setattr(data.service_models, role, new_key)

    def _default_parts(self, data: ModelLibraryFile) -> tuple[Provider | None, str | None]:
        if not data.default_model:
            return None, None
        try:
            provider_id, model_id = parse_model_key(data.default_model)
        except ValueError:
            return None, None
        provider = next((item for item in data.providers if item.id == provider_id), None)
        if provider is None:
            return None, None
        return provider, model_id

    def _fetch_chatgpt(self) -> list[ModelCandidate]:
        if self.chatgpt is None:
            raise HTTPException(503, "ChatGPT 套餐尚未连接。")
        try:
            raw = self.chatgpt.models()
        except ProviderError:
            raise
        except Exception:
            logger.warning("拉取 ChatGPT 模型列表失败")
            raise HTTPException(502, "无法读取 ChatGPT 可用模型，请检查授权状态后重试。") from None
        return _candidates(raw, "")

    def _fetch_openai(self, provider: Provider) -> list[ModelCandidate]:
        secret = provider.api_key.get_secret_value().strip()
        if provider.auth_mode == "api_key" and not secret:
            raise HTTPException(422, "请先填写密钥再拉取模型。")
        headers = {"Accept": "application/json"}
        if secret:
            headers["Authorization"] = f"Bearer {secret}"
        try:
            with httpx.Client(timeout=FETCH_TIMEOUT, follow_redirects=False) as client:
                response = client.get(f"{provider.base_url}/models", headers=headers)
        except httpx.HTTPError:
            logger.warning("拉取模型列表失败")
            raise HTTPException(502, "无法连接服务商，请检查地址和网络后重试。") from None
        if response.is_redirect or response.status_code in {401, 403}:
            detail = "服务商拒绝了访问，请检查密钥或认证方式。" if response.status_code in {401, 403} else "无法连接服务商，请检查地址和网络后重试。"
            raise HTTPException(502, detail)
        if not response.is_success:
            logger.warning("拉取模型列表失败（HTTP %s）", response.status_code)
            raise HTTPException(502, "暂时无法拉取模型列表，请检查密钥和地址后重试。")
        if len(response.content) > FETCH_BYTES:
            raise HTTPException(502, "服务商返回的模型列表过大。")
        try:
            payload = response.json()
        except ValueError:
            raise HTTPException(502, "服务商返回的模型列表无法解析。") from None
        return _candidates(payload, secret)

"""模型库契约。Agent A 负责存储和路由，Agent B 只依赖 ModelLibraryProtocol。

模型键是 ``<provider_id>/<model_id>``，只按第一个 ``/`` 切开；模型 ID 本身可以含 ``/``。
路由要写成 ``/providers/{provider_id}/models/{model_id:path}``。
``Provider`` 写入 model-library.json 时用 ``dump_stored()``；HTTP 响应只用 ``public()``。
``model_dump()`` 会抹掉密钥。写操作的校验错误不能回显请求体，避免带出 api_key。
"""

import re
from typing import Annotated, Literal, Protocol

from pydantic import BaseModel, ConfigDict, Field, SecretStr, SerializationInfo, field_serializer, field_validator

from app.config import Settings

ProviderPreset = Literal["openai", "deepseek", "qwen", "ark", "moonshot", "zhipu", "vertex", "chatgpt", "custom"]
AuthMode = Literal["api_key", "adc", "chatgpt"]
ReasoningLevel = Literal["none", "low", "medium", "high"]
ModelLabel = Literal["新", "Pro"]
ServiceRole = Literal["logic", "vision", "memory"]
SERVICE_ROLES: tuple[ServiceRole, ...] = ("logic", "vision", "memory")
PROVIDER_ID = re.compile(r"^prov-[0-9a-f]{8}$")
NO_MODEL_DETAIL = "没有可用的模型。请在设置里添加服务商、启用模型，并设为默认模型。"
URL_KEY_RESET_DETAIL = "更换服务地址时需要重新填写密钥。"


def _controls(value: str) -> bool:
    return any(ord(char) < 32 or ord(char) == 127 for char in value)


def parse_model_key(value: str) -> tuple[str, str]:
    text = value.strip()
    provider_id, sep, model_id = text.partition("/")
    provider_id = provider_id.strip()
    model_id = model_id.strip()
    if not sep or not provider_id or not model_id:
        raise ValueError("模型键必须是“服务商 ID/模型 ID”。")
    return provider_id, model_id


def make_model_key(provider_id: str, model_id: str) -> str:
    provider_id, model_id = provider_id.strip(), model_id.strip()
    if not provider_id or not model_id or "/" in provider_id:
        raise ValueError("服务商 ID 不能为空或包含“/”，模型 ID 也不能为空。")
    return f"{provider_id}/{model_id}"


def new_provider_id() -> str:
    import secrets
    return f"prov-{secrets.token_hex(4)}"


def _clean_model_id(value: str) -> str:
    text = value.strip()
    if not text or len(text) > 200 or _controls(text):
        raise ValueError("模型 ID 无效。")
    return text


def _clean_model_key(value: str) -> str:
    provider_id, model_id = parse_model_key(value)
    if PROVIDER_ID.fullmatch(provider_id) is None:
        raise ValueError("模型键必须是“服务商 ID/模型 ID”。")
    return make_model_key(provider_id, _clean_model_id(model_id))


def _clean_base_url(value: str) -> str:
    text = value.strip().rstrip("/")
    if not text or len(text) > 500 or _controls(text):
        raise ValueError("服务地址无效。")
    return text


def _clean_name(value: str, limit: int) -> str:
    text = value.strip()
    if not text or len(text) > limit or _controls(text):
        raise ValueError("名称无效。")
    return text


def _clean_secret(value: SecretStr | None) -> SecretStr | None:
    if value is None:
        return None
    text = value.get_secret_value().strip()
    if text and (not text.isascii() or len(text) > 4096 or _controls(text)):
        raise ValueError("API Key 无效。")
    return SecretStr(text)


def _blank_key(value: object) -> object:
    if isinstance(value, str) and not value.strip():
        return None
    return value


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ModelTags(StrictModel):
    reasoning: ReasoningLevel = "none"
    vision: bool = False
    tools: bool = False
    label: ModelLabel | None = None

    @field_validator("label", mode="before")
    @classmethod
    def empty_label(cls, value: object) -> object:
        if value is None or value == "":
            return None
        return value


class ModelTagsPatch(StrictModel):
    reasoning: ReasoningLevel | None = None
    vision: bool | None = None
    tools: bool | None = None
    label: ModelLabel | None = None

    @field_validator("label", mode="before")
    @classmethod
    def empty_label(cls, value: object) -> object:
        if value == "":
            return None
        return value

    def apply(self, current: ModelTags) -> ModelTags:
        data = current.model_dump()
        for name in self.model_fields_set:
            data[name] = getattr(self, name)
        return ModelTags.model_validate(data)


class ModelEntry(StrictModel):
    id: str
    name: str
    enabled: bool = True
    tags: ModelTags = Field(default_factory=ModelTags)

    @field_validator("id")
    @classmethod
    def model_id(cls, value: str) -> str:
        return _clean_model_id(value)

    @field_validator("name")
    @classmethod
    def model_name(cls, value: str) -> str:
        return _clean_name(value, 200)


class Provider(StrictModel):
    id: str
    name: str
    preset: ProviderPreset
    base_url: str
    auth_mode: AuthMode
    api_key: SecretStr = SecretStr("")
    project_id: str = ""
    location: str = "global"
    enabled: bool = True
    models: list[ModelEntry] = Field(default_factory=list)

    @field_validator("id")
    @classmethod
    def provider_id(cls, value: str) -> str:
        if PROVIDER_ID.fullmatch(value) is None:
            raise ValueError("服务商 ID 无效。")
        return value

    @field_validator("name")
    @classmethod
    def provider_name(cls, value: str) -> str:
        return _clean_name(value, 80)

    @field_validator("base_url")
    @classmethod
    def provider_base_url(cls, value: str) -> str:
        return _clean_base_url(value)

    @field_validator("api_key")
    @classmethod
    def provider_api_key(cls, value: SecretStr) -> SecretStr:
        cleaned = _clean_secret(value)
        return cleaned if cleaned is not None else SecretStr("")

    @field_validator("project_id")
    @classmethod
    def provider_project(cls, value: str) -> str:
        text = value.strip()
        if len(text) > 120 or _controls(text):
            raise ValueError("项目 ID 无效。")
        return text

    @field_validator("location")
    @classmethod
    def provider_location(cls, value: str) -> str:
        text = value.strip() or "global"
        if len(text) > 64 or _controls(text):
            raise ValueError("区域无效。")
        return text

    @field_serializer("api_key")
    def redact_api_key(self, value: SecretStr, info: SerializationInfo) -> str:
        if info.context and info.context.get("include_secrets"):
            return value.get_secret_value()
        return ""

    def dump_stored(self) -> dict:
        return self.model_dump(mode="json", context={"include_secrets": True})

    def public(self) -> "ProviderPublic":
        return ProviderPublic(
            id=self.id, name=self.name, preset=self.preset, base_url=self.base_url, auth_mode=self.auth_mode,
            has_api_key=bool(self.api_key.get_secret_value().strip()), project_id=self.project_id,
            location=self.location, enabled=self.enabled, models=[item.model_copy(deep=True) for item in self.models],
        )


class ProviderPublic(StrictModel):
    id: str
    name: str
    preset: ProviderPreset
    base_url: str
    auth_mode: AuthMode
    has_api_key: bool
    project_id: str = ""
    location: str = "global"
    enabled: bool = True
    models: list[ModelEntry] = Field(default_factory=list)


class ProviderCreate(StrictModel):
    name: str
    preset: ProviderPreset
    base_url: str
    auth_mode: AuthMode
    api_key: SecretStr | None = None
    project_id: str = ""
    location: str = "global"

    @field_validator("name")
    @classmethod
    def create_name(cls, value: str) -> str:
        return _clean_name(value, 80)

    @field_validator("base_url")
    @classmethod
    def create_base_url(cls, value: str) -> str:
        return _clean_base_url(value)

    @field_validator("api_key")
    @classmethod
    def create_api_key(cls, value: SecretStr | None) -> SecretStr | None:
        return _clean_secret(value)

    @field_validator("project_id")
    @classmethod
    def create_project(cls, value: str) -> str:
        text = value.strip()
        if len(text) > 120 or _controls(text):
            raise ValueError("项目 ID 无效。")
        return text

    @field_validator("location")
    @classmethod
    def create_location(cls, value: str) -> str:
        text = value.strip() or "global"
        if len(text) > 64 or _controls(text):
            raise ValueError("区域无效。")
        return text


class ProviderUpdate(StrictModel):
    """未出现的字段保持不变。api_key 未出现或为 null 时不改密钥。

    base_url 发生变化且认证方式为 api_key 时，必须同时提交新密钥。
    """

    name: str | None = None
    base_url: str | None = None
    auth_mode: AuthMode | None = None
    api_key: SecretStr | None = None
    project_id: str | None = None
    location: str | None = None
    enabled: bool | None = None

    @field_validator("name")
    @classmethod
    def update_name(cls, value: str | None) -> str | None:
        return None if value is None else _clean_name(value, 80)

    @field_validator("base_url")
    @classmethod
    def update_base_url(cls, value: str | None) -> str | None:
        return None if value is None else _clean_base_url(value)

    @field_validator("api_key")
    @classmethod
    def update_api_key(cls, value: SecretStr | None) -> SecretStr | None:
        return _clean_secret(value)

    @field_validator("project_id")
    @classmethod
    def update_project(cls, value: str | None) -> str | None:
        if value is None:
            return None
        text = value.strip()
        if len(text) > 120 or _controls(text):
            raise ValueError("项目 ID 无效。")
        return text

    @field_validator("location")
    @classmethod
    def update_location(cls, value: str | None) -> str | None:
        if value is None:
            return None
        text = value.strip() or "global"
        if len(text) > 64 or _controls(text):
            raise ValueError("区域无效。")
        return text

    def supplied_api_key(self) -> str | None:
        if "api_key" not in self.model_fields_set or self.api_key is None:
            return None
        return self.api_key.get_secret_value()


class ModelCreate(StrictModel):
    id: str
    name: str | None = None
    tags: ModelTags | None = None

    @field_validator("id")
    @classmethod
    def create_id(cls, value: str) -> str:
        return _clean_model_id(value)

    @field_validator("name")
    @classmethod
    def create_name(cls, value: str | None) -> str | None:
        return None if value is None else _clean_name(value, 200)


class ModelUpdate(StrictModel):
    enabled: bool | None = None
    name: str | None = None
    tags: ModelTagsPatch | None = None

    @field_validator("name")
    @classmethod
    def update_name(cls, value: str | None) -> str | None:
        return None if value is None else _clean_name(value, 200)


class ModelCandidate(StrictModel):
    id: str
    name: str
    tags: ModelTags = Field(default_factory=ModelTags)


class TestModelRequest(StrictModel):
    model_id: str

    @field_validator("model_id")
    @classmethod
    def test_model_id(cls, value: str) -> str:
        return _clean_model_id(value)


class ModelTestResult(StrictModel):
    status: Literal["ok"] = "ok"
    model: str
    structured_output: bool


class CatalogModel(StrictModel):
    key: str
    provider_id: str
    provider_name: str
    model_id: str
    name: str
    tags: ModelTags
    is_default: bool


class DefaultModelState(StrictModel):
    key: str | None = None

    @field_validator("key", mode="before")
    @classmethod
    def blank(cls, value: object) -> object:
        return _blank_key(value)

    @field_validator("key")
    @classmethod
    def shaped(cls, value: str | None) -> str | None:
        return None if value is None else _clean_model_key(value)


class DefaultModelUpdate(StrictModel):
    key: str

    @field_validator("key")
    @classmethod
    def shaped(cls, value: str) -> str:
        return _clean_model_key(value)


class ServiceModelSelection(StrictModel):
    logic: str | None = None
    vision: str | None = None
    memory: str | None = None

    @field_validator("logic", "vision", "memory", mode="before")
    @classmethod
    def blank(cls, value: object) -> object:
        return _blank_key(value)

    @field_validator("logic", "vision", "memory")
    @classmethod
    def shaped(cls, value: str | None) -> str | None:
        return None if value is None else _clean_model_key(value)


class ConversationModelUpdate(StrictModel):
    model_key: str | None = None

    @field_validator("model_key", mode="before")
    @classmethod
    def blank(cls, value: object) -> object:
        return _blank_key(value)

    @field_validator("model_key")
    @classmethod
    def shaped(cls, value: str | None) -> str | None:
        return None if value is None else _clean_model_key(value)


class AffectedRefs(StrictModel):
    default_model: bool = False
    service_models: list[ServiceRole] = Field(default_factory=list)


class DeleteProviderResult(StrictModel):
    affected: AffectedRefs


class ModelLibraryFile(StrictModel):
    version: Literal[1] = 1
    providers: list[Provider] = Field(default_factory=list)
    default_model: str | None = None
    service_models: ServiceModelSelection = Field(default_factory=ServiceModelSelection)

    @field_validator("default_model", mode="before")
    @classmethod
    def blank_default(cls, value: object) -> object:
        return _blank_key(value)

    @field_validator("default_model")
    @classmethod
    def shaped_default(cls, value: str | None) -> str | None:
        return None if value is None else _clean_model_key(value)

    def dump_stored(self) -> dict:
        return self.model_dump(mode="json", context={"include_secrets": True})


class ModelLibraryProtocol(Protocol):
    def resolve(self, model_key: str | None) -> Settings:
        """返回填好 llm_* 的 Settings。

        model_key 为 None，或指向已删除、已停用的模型时，回退到默认模型。
        默认模型也不可用时抛出 ProviderError(503, NO_MODEL_DETAIL)。
        """

    def effective_key(self, model_key: str | None) -> str | None:
        """resolve 实际会使用的模型键。没有任何可用模型时返回 None，不抛错。"""

    def service_settings(self, role: ServiceRole) -> Settings:
        """service_models.<role> 为 None 时等同 resolve(None)。"""

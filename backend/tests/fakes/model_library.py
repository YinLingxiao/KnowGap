"""内存中的 ModelLibraryProtocol。不读盘、不联网，供 Agent B 在存储合并前测试。"""

from app.agents.llm import ProviderError
from app.config import Settings
from app.models.model_library_schemas import (
    NO_MODEL_DETAIL, PROVIDER_ID, ModelEntry, Provider, ServiceModelSelection, ServiceRole, make_model_key, parse_model_key,
)


class FakeModelLibrary:
    def __init__(
        self,
        providers: list[Provider] | None = None,
        default_model: str | None = None,
        service_models: ServiceModelSelection | None = None,
    ) -> None:
        self.providers = providers if providers is not None else []
        self.default_model = default_model or None
        self.service_models = service_models if service_models is not None else ServiceModelSelection()

    def _usable(self, model_key: str | None) -> tuple[Provider, ModelEntry] | None:
        if not model_key:
            return None
        try:
            provider_id, model_id = parse_model_key(model_key)
        except ValueError:
            return None
        if PROVIDER_ID.fullmatch(provider_id) is None:
            return None
        provider = next((item for item in self.providers if item.id == provider_id and item.enabled), None)
        if provider is None:
            return None
        model = next((item for item in provider.models if item.id == model_id and item.enabled), None)
        if model is None:
            return None
        return provider, model

    def effective_key(self, model_key: str | None) -> str | None:
        found = self._usable(model_key)
        if found is not None:
            return make_model_key(found[0].id, found[1].id)
        fallback = self._usable(self.default_model)
        if fallback is None:
            return None
        return make_model_key(fallback[0].id, fallback[1].id)

    def resolve(self, model_key: str | None) -> Settings:
        key = self.effective_key(model_key)
        found = self._usable(key)
        if found is None:
            raise ProviderError(503, NO_MODEL_DETAIL)
        provider, model = found
        return Settings(
            _env_file=None,
            llm_base_url=provider.base_url,
            llm_model=model.id,
            llm_api_key=provider.api_key,
            llm_auth_mode=provider.auth_mode,
            llm_project_id=provider.project_id,
            llm_location=provider.location,
        )

    def service_settings(self, role: ServiceRole) -> Settings:
        if role not in ("logic", "vision", "memory"):
            raise ProviderError(422, "服务模型角色无效。")
        return self.resolve(getattr(self.service_models, role))

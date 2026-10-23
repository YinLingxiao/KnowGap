import json

import pytest
from pydantic import SecretStr, ValidationError

from app.agents.llm import ProviderError
from app.models.model_library_schemas import (
    NO_MODEL_DETAIL, URL_KEY_RESET_DETAIL, AffectedRefs, CatalogModel, DeleteProviderResult, ModelEntry, ModelLibraryFile,
    ModelTags, ModelTagsPatch, Provider, ProviderCreate, ProviderPublic, ProviderUpdate, ServiceModelSelection,
    make_model_key, parse_model_key,
)
from tests.fakes.model_library import FakeModelLibrary

SECRET = "synthetic-library-key"
FLASH = "google/gemini-3.5-flash"


def provider(*models: ModelEntry, enabled: bool = True, preset: str = "vertex") -> Provider:
    return Provider(
        id="prov-abcdef12", name="Vertex", preset=preset,
        base_url="https://aiplatform.googleapis.com/v1/publishers/google/models",
        auth_mode="api_key", api_key=SecretStr(SECRET), enabled=enabled, models=list(models),
    )


def entry(model_id: str = FLASH, enabled: bool = True) -> ModelEntry:
    return ModelEntry(id=model_id, name="Gemini", enabled=enabled, tags=ModelTags(tools=True))


def test_model_key_keeps_slashes_inside_the_model_id():
    key = make_model_key("prov-abcdef12", FLASH)
    assert key == f"prov-abcdef12/{FLASH}"
    assert parse_model_key(key) == ("prov-abcdef12", FLASH)
    assert parse_model_key("  prov-abcdef12/a/b/c  ") == ("prov-abcdef12", "a/b/c")
    for value in ("", "noslash", "/model", "prov-abcdef12/", "/"):
        with pytest.raises(ValueError, match="模型键"):
            parse_model_key(value)
    with pytest.raises(ValueError, match="服务商 ID"):
        make_model_key("prov/id", "model")


def test_public_provider_never_contains_the_stored_key():
    stored = provider(entry())
    public = stored.public().model_dump(mode="json")
    assert "api_key" not in public
    assert "api_key" not in ProviderPublic.model_fields
    assert public["has_api_key"] is True
    assert SECRET not in json.dumps(stored.model_dump(mode="json"), ensure_ascii=False)
    assert stored.dump_stored()["api_key"] == SECRET
    library = ModelLibraryFile(
        providers=[stored], default_model=make_model_key(stored.id, FLASH),
        service_models=ServiceModelSelection(),
    )
    raw = library.dump_stored()
    assert raw["providers"][0]["api_key"] == SECRET
    assert SECRET not in json.dumps(library.model_dump(mode="json"), ensure_ascii=False)
    restored = ModelLibraryFile.model_validate(raw)
    assert restored.providers[0].api_key.get_secret_value() == SECRET
    assert "密钥" in URL_KEY_RESET_DETAIL


def test_provider_update_omitted_key_is_distinct_from_a_submitted_key():
    omitted = ProviderUpdate.model_validate({"name": "Next"})
    assert omitted.supplied_api_key() is None
    submitted = ProviderUpdate.model_validate({"api_key": "next-synthetic-key"})
    assert submitted.supplied_api_key() == "next-synthetic-key"
    assert ProviderUpdate.model_validate({"api_key": None}).supplied_api_key() is None
    with pytest.raises(ValidationError):
        ProviderCreate.model_validate({
            "name": "Vertex", "preset": "vertex", "base_url": "https://example.com/v1",
            "auth_mode": "api_key", "api_key": SECRET, "unexpected": True,
        })


def test_tag_patch_replaces_only_fields_present_in_the_request():
    current = ModelTags(reasoning="high", vision=True, tools=True, label="Pro")
    patched = ModelTagsPatch.model_validate({"vision": False, "label": None}).apply(current)
    assert patched.model_dump() == {"reasoning": "high", "vision": False, "tools": True, "label": None}


def test_fake_library_resolves_slash_model_ids_and_falls_back():
    primary = provider(entry(), entry("gemini-lite", enabled=False))
    other = Provider(
        id="prov-1234abcd", name="DeepSeek", preset="deepseek", base_url="https://api.deepseek.com/v1",
        auth_mode="api_key", api_key=SecretStr("synthetic-other-key"),
        models=[ModelEntry(id="deepseek-flash", name="deepseek-flash")],
    )
    default = make_model_key(primary.id, FLASH)
    library = FakeModelLibrary([primary, other], default_model=default, service_models=ServiceModelSelection(
        vision=make_model_key(other.id, "deepseek-flash"),
    ))
    resolved = library.resolve(None)
    assert resolved.llm_model == FLASH
    assert resolved.llm_base_url == primary.base_url
    assert resolved.llm_auth_mode == "api_key"
    assert resolved.llm_api_key.get_secret_value() == SECRET
    requested = make_model_key(other.id, "deepseek-flash")
    assert library.effective_key(requested) == requested
    assert library.resolve(requested).llm_model == "deepseek-flash"
    assert library.effective_key(make_model_key(primary.id, "gemini-lite")) == default
    assert library.effective_key("prov-abcdef12/missing") == default
    assert library.service_settings("vision").llm_model == "deepseek-flash"
    assert library.service_settings("logic").llm_model == FLASH
    assert library.service_settings("memory").llm_model == FLASH
    disabled = ServiceModelSelection(logic=make_model_key(primary.id, "gemini-lite"))
    library.service_models = disabled
    assert library.service_settings("logic").llm_model == FLASH
    library.default_model = make_model_key(primary.id, "gemini-lite")
    with pytest.raises(ProviderError) as raised:
        library.resolve(make_model_key(primary.id, "gemini-lite"))
    assert raised.value.status_code == 503
    assert raised.value.detail == NO_MODEL_DETAIL
    assert library.effective_key(None) is None
    library.default_model = requested
    assert library.effective_key(make_model_key(primary.id, "gemini-lite")) == requested
    primary.enabled = False
    assert library.resolve(default).llm_model == "deepseek-flash"
    catalog = CatalogModel(
        key=default, provider_id=primary.id, provider_name=primary.name, model_id=FLASH,
        name="Gemini", tags=ModelTags(), is_default=True,
    )
    assert catalog.model_id == FLASH
    result = DeleteProviderResult(affected=AffectedRefs(default_model=True, service_models=["logic", "vision"]))
    assert result.model_dump() == {"affected": {"default_model": True, "service_models": ["logic", "vision"]}}

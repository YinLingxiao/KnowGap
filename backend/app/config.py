"""Backend-only configuration; no provider or secret is assumed."""

from pathlib import Path
from typing import Literal

from pydantic import AliasChoices, Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(REPO_ROOT / ".env", BACKEND_ROOT / ".env"),
        env_file_encoding="utf-8", extra="ignore", populate_by_name=True,
    )

    database_path: Path = BACKEND_ROOT / "data" / "knowgap.sqlite3"
    llm_api_key: SecretStr = Field(
        default=SecretStr(""),
        validation_alias=AliasChoices("LLM_API_KEY", "OPENAI_API_KEY"),
    )
    llm_base_url: str = Field(
        default="", validation_alias=AliasChoices("LLM_BASE_URL", "OPENAI_BASE_URL")
    )
    llm_model: str = ""
    llm_auth_mode: Literal["api_key", "adc", "chatgpt"] = "api_key"
    llm_project_id: str = ""
    llm_location: str = "global"
    llm_timeout_seconds: float = Field(default=90, gt=0, le=120)
    anysearch_api_key: SecretStr = SecretStr('')
    anysearch_timeout_seconds: float = Field(default=20, gt=0, le=60)
    cors_origins: list[str] = ["http://localhost:3000", "http://127.0.0.1:3000"]
    smtp_host: str = ""
    smtp_port: int = 465
    smtp_user: str = ""
    smtp_password: SecretStr = SecretStr("")
    smtp_from: str = ""

    def resolved_database_path(self) -> Path:
        path = self.database_path.expanduser()
        return path if path.is_absolute() else BACKEND_ROOT / path

    @property
    def llm_configured(self) -> bool:
        if not (self.llm_base_url.strip() and self.llm_model.strip()):
            return False
        if self.llm_auth_mode == "chatgpt":
            return self.llm_base_url.strip().rstrip("/") == "https://api.openai.com/v1"
        if self.llm_auth_mode == "adc":
            from app.agents.vertex_config import adc_base_url
            try:
                return self.llm_base_url.strip().rstrip("/") == adc_base_url(self.llm_project_id, self.llm_location)
            except ValueError:
                return False
        return bool(self.llm_api_key.get_secret_value())

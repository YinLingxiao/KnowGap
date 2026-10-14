from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app


def test_health(tmp_path) -> None:
    settings = Settings(
        _env_file=None, database_path=tmp_path / "health.sqlite3",
        llm_api_key="", llm_base_url="", llm_model="",
    )
    with TestClient(create_app(settings)) as client:
        response = client.get("/health")
        assert response.status_code == 200
        assert response.json() == {"status": "ok"}

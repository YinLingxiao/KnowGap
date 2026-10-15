import argparse
import logging
import os
from logging.handlers import RotatingFileHandler
from pathlib import Path

import uvicorn
from fastapi.staticfiles import StaticFiles

from app.config import Settings
from app.main import create_app


def configure_logging(directory: Path) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    handler = RotatingFileHandler(directory / "backend.log", maxBytes=2_000_000,
                                  backupCount=3, encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    logging.basicConfig(level=logging.INFO, handlers=[handler], force=True)
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        log = logging.getLogger(name)
        log.handlers.clear()
        log.propagate = True


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--static", default="")
    args = parser.parse_args()
    settings = Settings()
    data = os.environ.get("KNOWGAP_DATA_DIR", "").strip()
    if data:
        settings = settings.model_copy(update={"database_path": Path(data) / "knowgap.sqlite3"})
    configure_logging(settings.resolved_database_path().parent / "logs")
    app = create_app(settings)
    static = Path(args.static) if args.static else None
    if static and static.is_dir():
        app.mount("/", StaticFiles(directory=static, html=True), name="frontend")
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="info", log_config=None)


if __name__ == "__main__":
    main()

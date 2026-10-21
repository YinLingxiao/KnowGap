import argparse
import logging
import os
from logging.handlers import RotatingFileHandler
from pathlib import Path

import uvicorn
from fastapi.staticfiles import StaticFiles

from app.config import Settings
from app.main import create_app


class ExportStaticFiles(StaticFiles):
    """托管 Next.js `output: "export"` 的产物。

    导出结果是 `quick.html` 而不是 `quick/index.html`，而 `StaticFiles(html=True)`
    只会补目录下的 index.html，`/quick` 这类无扩展名路由会直接 404。
    桌面壳请求的是 `/quick.html`，但浏览器里访问 `/quick`、或以后新增导出路由时
    仍需要一个回退，所以这里把无扩展名路径映射到同名 `.html` 文件。
    """

    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        # StaticFiles 对不存在的文件返回 404 Response（不抛异常），所以按状态码判断。
        if response.status_code != 404 or not path or Path(path).suffix:
            return response
        candidate = f"{path.rstrip('/')}.html"
        if (Path(self.directory) / candidate).is_file():
            return await super().get_response(candidate, scope)
        return response


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
    data = os.environ.get("KNOWGAP_DATA_DIR", "").strip()
    user_env = Path(data) / ".env" if data else None
    settings = Settings(_env_file=user_env) if user_env and user_env.is_file() else Settings()
    if data:
        settings = settings.model_copy(update={"database_path": Path(data) / "knowgap.sqlite3"})
    configure_logging(settings.resolved_database_path().parent / "logs")
    logging.getLogger("knowgap.desktop").info(
        "启动：端口=%s 数据目录=%s 静态资源=%s", args.port, data or "<默认>", args.static or "<无>"
    )
    app = create_app(settings)
    static = Path(args.static) if args.static else None
    if static and static.is_dir():
        app.mount("/", ExportStaticFiles(directory=static, html=True), name="frontend")
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="info", log_config=None)


if __name__ == "__main__":
    main()

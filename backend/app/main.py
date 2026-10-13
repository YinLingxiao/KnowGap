"""KnowGap FastAPI 应用入口。"""

from fastapi import FastAPI

app = FastAPI(title="KnowGap API", version="0.1.0")


@app.get("/health")
def health() -> dict[str, str]:
    """健康检查端点。"""
    return {"status": "ok"}

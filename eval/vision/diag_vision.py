"""Diagnose why the vision model times out. Never prints API keys.

Run: backend/.venv/Scripts/python.exe -I eval/vision/diag_vision.py
"""

import asyncio
import base64
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))

import httpx  # noqa: E402

from app.vision.settings import config_from_env  # noqa: E402

SAMPLE = ROOT / "eval" / "vision" / "samples" / "cee_c1-16b.png"


async def call(label: str, content, extra: dict | None = None) -> None:
    cfg = config_from_env()
    payload = {"model": cfg.model, "temperature": 0, "max_tokens": 300,
               "messages": [{"role": "user", "content": content}], **(extra or {})}
    started = time.monotonic()
    try:
        async with httpx.AsyncClient(timeout=120) as client:
            response = await client.post(f"{cfg.base_url}/chat/completions", json=payload,
                                         headers={"Authorization": f"Bearer {cfg.api_key.get_secret_value()}"})
    except httpx.TimeoutException:
        print(f"[{label}] TIMEOUT after {time.monotonic() - started:.0f}s")
        return
    elapsed = time.monotonic() - started
    try:
        body = response.json()
    except ValueError:
        print(f"[{label}] HTTP {response.status_code} {elapsed:.1f}s non-JSON: {response.text[:200]}")
        return
    if not response.is_success:
        print(f"[{label}] HTTP {response.status_code} {elapsed:.1f}s error: {str(body)[:300]}")
        return
    choice = body["choices"][0]
    message = choice.get("message") or {}
    reasoning = message.get("reasoning_content") or ""
    print(f"[{label}] OK {elapsed:.1f}s finish={choice.get('finish_reason')} usage={body.get('usage')}")
    print(f"   reasoning_chars={len(reasoning)} content={str(message.get('content'))[:160]!r}")


async def main() -> None:
    image = "data:image/png;base64," + base64.b64encode(SAMPLE.read_bytes()).decode()
    image_part = [{"type": "image_url", "image_url": {"url": image}},
                  {"type": "text", "text": "用一句话描述这张图里有什么。"}]
    await asyncio.gather(
        call("text", "回复两个字：你好"),
        call("image", image_part),
        call("image+no_thinking", image_part, {"enable_thinking": False}),
    )


if __name__ == "__main__":
    asyncio.run(main())

"""Minimal connectivity check for the two runtime models, through the real backend code paths.

Run from anywhere:  backend/.venv/Scripts/python.exe -X utf8 -I eval/vision/smoke.py
Never prints API keys.
"""

import asyncio
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))

from app.agents.llm import ChatCompletionsChat, ProviderError  # noqa: E402
from app.config import Settings  # noqa: E402
from app.vision.grounding import extract  # noqa: E402
from app.vision.settings import config_from_env  # noqa: E402

# A generated 1x1 transparent PNG: connectivity only, no local evaluation material is uploaded.
TINY_PNG = ("data:image/png;base64,"
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")


async def logic() -> None:
    settings = Settings()
    started = time.monotonic()
    try:
        result, usage = await ChatCompletionsChat(settings).complete_json_with_usage([
            {"role": "system", "content": "只输出一个 JSON 对象，字段为 answer。"},
            {"role": "user", "content": "1+1 等于几？"},
        ])
        print(f"[logic] {settings.llm_model}: OK {time.monotonic() - started:.1f}s result={result} usage={usage}")
    except ProviderError as exc:
        print(f"[logic] {settings.llm_model}: FAIL {exc.status_code} {exc.detail}")


async def vision() -> None:
    config = config_from_env()
    started = time.monotonic()
    try:
        result = await extract(TINY_PNG, config, width=1, height=1)
    except ProviderError as exc:
        print(f"[vision] {config.model}: FAIL {exc.status_code} {exc.detail}")
        return
    print(f"[vision] {config.model}: OK {time.monotonic() - started:.1f}s kind={result.kind} "
          f"category={result.category} steps={result.steps} regions={len(result.regions)}")
    print("  transcript:", result.transcript[:200].replace("\n", " / "))
    for region in result.regions[:12]:
        print(f"  {region.id} {list(region.bbox)} {region.text[:40]}")
    print("  netlist:", json.dumps(result.netlist, ensure_ascii=False)[:900])


async def main() -> None:
    await asyncio.gather(logic(), vision())


if __name__ == "__main__":
    asyncio.run(main())

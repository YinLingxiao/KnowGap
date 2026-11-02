r"""Local streaming acceptance demo. Uses synthetic replies and a separate database.

Run from backend: .venv\Scripts\python.exe scripts\streaming_demo.py
Frontend: NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:8017, port 3017, /dev/streaming-interaction
"""

import asyncio
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
DEMO = ROOT / "data" / "streaming-demo"
DEMO.mkdir(parents=True, exist_ok=True)
os.environ["DATABASE_PATH"] = str(DEMO / "bootstrap.sqlite3")

from app.config import Settings
from app.main import create_app


class DemoModel:
    async def stream(self, messages, tools=None):
        question = next((message["content"] for message in reversed(messages) if message["role"] == "user"), "栈")
        yield "reasoning", "这是本地模拟回复，用于检查交互，不调用任何模型 API。"
        text = f"关于「{question[:80]}」\n\n"
        text += "栈可以想成一摞盘子：最后放上去的盘子，最先被拿走。\n\n"
        for index in range(1, 13):
            text += f"### 第 {index} 步：观察前后变化\n\n先放入 A，再放入 B。此时 B 在最上方，取出时先拿到 B，再拿到 A。可以向上滚动、选中这句话，或在下方继续提问。\n\n"
        text += "| 操作 | 栈内内容 |\n| --- | --- |\n| 放入 A | A |\n| 放入 B | A、B |\n| 取出 | A |\n\n"
        text += "```python\nstack = []\nstack.append('A')\nstack.append('B')\nprint(stack.pop())  # B\n```\n\n模拟回复完成。"
        for index in range(0, len(text), 24):
            yield "text", text[index:index + 24]
            await asyncio.sleep(0.18)
        yield "finish", "stop"

    async def complete_json(self, messages):
        return {}


if __name__ == "__main__":
    import uvicorn
    settings = Settings(_env_file=None, database_path=DEMO / "demo.sqlite3",
                        llm_api_key="", llm_base_url="", llm_model="",
                        cors_origins=["http://127.0.0.1:3017", "http://localhost:3017"])
    uvicorn.run(create_app(settings, chat_model=DemoModel()), host="127.0.0.1", port=8017)

"""端到端：上传讲义 → 聊天里要题 → 模型调用 search_good_problems → 回复里的 micro_quiz 被核对并重写来源。

不联网、不配搜索 key：联网 provider 自动跳过，只走讲义库这一路（与当前没有 API Key 的实际环境一致）。
"""

import json

import pytest
from fastapi.testclient import TestClient

from app.agent_tools import problem_search as ps
from app.chat.skills import problem_drill_skill as drill
from app.main import create_app
from tests.test_acceptance_support import isolated_settings
from tests.test_chat import context_of, parse
from tests.test_problem_search import KP, PAGE, PROBLEM_2

ASK = "找几道定积分换元法的好题练手"


@pytest.fixture(autouse=True)
def no_keys(monkeypatch):
    ps.clear_cache()
    drill.clear_state()
    monkeypatch.setattr(ps, "_env", lambda name: "")
    yield
    ps.clear_cache()
    drill.clear_state()


class DrillChat:
    """第 1 轮调用搜题工具；第 2 轮读工具结果出一道题。invent=True 时编造 candidate_id。"""

    def __init__(self, invent=False):
        self.invent = invent
        self.calls, self.tools, self.extract_calls = [], [], []

    async def stream(self, messages, tools=None):
        self.calls.append(messages)
        self.tools.append([t["function"]["name"] for t in tools or []])
        if len(self.calls) == 1:
            yield "tool_calls", [{"id": "call-search", "name": ps.TOOL_NAME,
                                  "arguments": json.dumps({"knowledge_point": KP, "count": 2}, ensure_ascii=False)}]
            yield "finish", "tool_calls"
            return
        result = json.loads(next(m for m in reversed(messages) if m["role"] == "tool")["content"])
        choice = next(c for c in result["candidates"] if c["type"] == "选择")
        widget = {
            "type": "micro_quiz", "question": choice["stem"], "options": choice["options"],
            "answerIndex": choice["answer_index"], "explanation": "令 u=1-x，积分限同步变换。",
            "meta": {"candidate_id": "cand_invented" if self.invent else choice["candidate_id"],
                     "pattern_id": choice["pattern"], "knowledge_point": KP, "fingerprint": choice["fingerprint"],
                     # 模型自己写的出处，应被服务端按检索记录覆盖
                     "source": {"label": "2023 考研数学一 第5题", "url": "https://evil.example.com/"}},
        }
        text = "先做这道：\n```knowgap-widget\n" + json.dumps(widget, ensure_ascii=False) + "\n```\n做完告诉我你的选择。"
        for start in range(0, len(text), 40):
            yield "text", text[start:start + 40]
        yield "finish", "stop"

    async def complete_json(self, messages):
        if messages[0]["content"] == ps.EXTRACT_PROMPT:
            payload = json.loads(messages[1]["content"])
            self.extract_calls.append(payload)
            return {"problems": [PROBLEM_2] if "例2" in payload["page_text"] else []}
        return {}  # 学习分析


def run_chat(tmp_path, model, ask=ASK):
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=model)) as client:
        uploaded = client.post("/api/materials", files={"file": ("定积分讲义.md", PAGE.encode(), "text/plain")})
        assert uploaded.status_code == 201, uploaded.text
        conversation = client.post("/api/conversations", json={}).json()["id"]
        response = client.post(f"/api/conversations/{conversation}/messages",
                               json={"content": ask, "client_request_id": "req-drill-0001"})
        assert response.status_code == 200, response.text
        events = parse(response.text)
        stored = client.get(f"/api/conversations/{conversation}").json()["messages"][-1]
    return events, stored


def widgets(text):
    return [json.loads(m.group(1)) for m in drill.WIDGET_RE.finditer(text)]


def test_drill_end_to_end_with_lecture_only(tmp_path):
    model = DrillChat()
    events, stored = run_chat(tmp_path, model)

    # 路由：练习意图挂载 problem_drill，两个新工具都在可用列表里
    assert "problem_drill" in context_of(model.calls[0])["active_skill"]
    assert {ps.TOOL_NAME, drill.VERIFY_TOOL} <= set(model.tools[0])

    # 工具真的执行了：讲义被检索、送去抽题，返回了可溯源的候选题
    tool_end = next(data for name, data in events if name == "tool_end")
    output = json.loads(tool_end["output"])
    assert tool_end["name"] == ps.TOOL_NAME and output["status"] in {"ok", "partial"}
    assert model.extract_calls and output["candidates"][0]["source"]["origin_type"] == "讲义例题"

    # 存储的回复（done 事件里的就是它）：微测卡保留，来源按检索记录重写
    done = next(data for name, data in events if name == "done")["message"]
    assert done["content"] == stored["content"] and stored["status"] == "complete"
    [quiz] = widgets(stored["content"])
    meta = quiz["meta"]
    assert meta["verified"] is True and meta["source"]["kind"] == "original"
    assert meta["source"]["origin_type"] == "讲义例题" and meta["source"]["url"] is None
    assert "evil.example.com" not in stored["content"] and "2023" not in meta["source"]["label"]
    assert stored["content"].startswith("先做这道：") and stored["content"].endswith("做完告诉我你的选择。")


class SilentChat(DrillChat):
    """真实小模型的常见表现：只说一句「我去找题」就结束，不调用任何工具。"""

    async def stream(self, messages, tools=None):
        self.calls.append(messages)
        self.tools.append([t["function"]["name"] for t in tools or []])
        yield "text", "好的，我来为你找几道定积分换元法的好题。请稍等。"
        yield "finish", "stop"


def test_server_searches_when_model_skips_the_tool(tmp_path):
    model = SilentChat()
    events, stored = run_chat(tmp_path, model)
    # 服务端在模型第一轮之前代为调用了搜题，模型看到的上下文里已有结果
    tool_end = next(data for name, data in events if name == "tool_end")
    assert tool_end["name"] == ps.TOOL_NAME and json.loads(tool_end["arguments"])["knowledge_point"] == KP
    assert any(m["role"] == "tool" for m in model.calls[0])
    assert len(model.calls) == 1  # 搜题不占模型轮次
    # 模型没写占位符，服务端补上了测验卡
    [quiz] = widgets(stored["content"])
    assert quiz["meta"]["source"]["origin_type"] == "讲义例题" and "检索到的原题" in stored["content"]


class InventingChat(DrillChat):
    """知识点太宽、服务端不代为搜题时，小模型不追问，直接编一道「改编题」。"""

    async def stream(self, messages, tools=None):
        self.calls.append(messages)
        yield "text", "好的，先做这道例1的改编题：[[quiz:var_0000000000000000]] 请作答。"
        yield "finish", "stop"


def test_broad_request_without_search_asks_for_specific_topic(tmp_path):
    events, stored = run_chat(tmp_path, InventingChat(), "来几道题考考我微积分")
    assert not any(name == "tool_end" for name, _ in events)  # 知识点太宽，服务端不代为搜题
    assert stored["content"] == drill.ASK_SPECIFIC_NOTE


def test_invented_candidate_is_hidden(tmp_path):
    _, stored = run_chat(tmp_path, DrillChat(invent=True))
    assert widgets(stored["content"]) == []
    assert "已隐藏" in stored["content"] and "cand_invented" not in stored["content"]

"""web_search：通用联网搜索工具。全部用假的搜索服务，不发真实请求。"""

import asyncio
import json
from types import SimpleNamespace

from app import agent_tools
from app.agent_tools import web_search
from app.agents.llm import ProviderError
from app.chat.checkpoints import READ_ONLY_TOOLS
from app.models.schemas import WebSearchResponse, WebSource


class FakeSearch:
    def __init__(self, results=None, error=None):
        self.results, self.error, self.calls = results or [], error, []

    async def search(self, query, limit=5):
        self.calls.append((query, limit))
        if self.error:
            raise self.error
        return WebSearchResponse(query=query, results=self.results)


def source(n):
    return WebSource(id=f"s{n}", label=f"S{n}", title=f"标题  {n}", url=f"https://example.com/{n}", snippet=f"摘要\n第 {n} 条")


def call(arguments, ctx):
    return json.loads(asyncio.run(web_search.run(arguments, ctx)))


def test_ok_returns_labelled_normalised_results():
    ctx = SimpleNamespace(web_search_client=FakeSearch([source(1), source(2)]))
    data = call({"query": "  栈   的 定义 "}, ctx)
    assert data["status"] == "ok"
    assert data["query"] == "栈 的 定义"
    assert [item["label"] for item in data["results"]] == ["网1", "网2"]
    assert data["results"][0]["title"] == "标题 1"
    assert data["results"][0]["snippet"] == "摘要 第 1 条"
    assert [item["url"] for item in data["results"]] == ["https://example.com/1", "https://example.com/2"]


def test_no_results_has_status_and_note():
    ctx = SimpleNamespace(web_search_client=FakeSearch([]))
    data = call({"query": "不存在的东西"}, ctx)
    assert data["status"] == "no_result"
    assert data["results"] == []
    assert data["note"]


def test_provider_error_passes_its_message_through():
    message = "AnySearch 搜索超时，请稍后重试。"
    ctx = SimpleNamespace(web_search_client=FakeSearch(error=ProviderError(504, message)))
    data = call({"query": "栈"}, ctx)
    assert data["status"] == "error"
    assert data["note"] == message


def test_unexpected_exception_is_hidden_from_the_model():
    ctx = SimpleNamespace(web_search_client=FakeSearch(error=RuntimeError("boom")))
    data = call({"query": "栈"}, ctx)
    assert data["status"] == "error"
    assert "boom" not in data["note"]


def test_empty_query_is_rejected_without_calling_the_client():
    fake = FakeSearch([source(1)])
    ctx = SimpleNamespace(web_search_client=fake)
    for query in ("", "   "):
        data = call({"query": query}, ctx)
        assert data["status"] == "error"
    assert fake.calls == []


def test_limit_is_clamped_and_falls_back_to_default():
    cases = [(50, 8), ("x", 5), (True, 5)]
    for given, expected in cases:
        fake = FakeSearch([source(1)])
        call({"query": "栈", "limit": given}, SimpleNamespace(web_search_client=fake))
        assert fake.calls == [("栈", expected)]


def test_per_turn_call_cap_is_three():
    fake = FakeSearch([source(1)])
    ctx = SimpleNamespace(web_search_client=fake)
    statuses = [call({"query": f"问题{index}"}, ctx)["status"] for index in range(4)]
    assert statuses == ["ok", "ok", "ok", "limit"]
    assert len(fake.calls) == 3


def test_registered_as_a_read_only_tool_for_the_agent():
    assert "web_search" in [definition["function"]["name"] for definition in agent_tools.DEFINITIONS]
    ctx = SimpleNamespace(web_search_client=FakeSearch([source(1)]))
    data = json.loads(asyncio.run(agent_tools.run("web_search", {"query": "栈"}, ctx)))
    assert data["status"] == "ok"
    assert "web_search" in READ_ONLY_TOOLS

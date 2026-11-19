"""B4 web_fetch 离线验收：真实 PageFetcher + MockTransport + 异步假 resolver。"""

import asyncio
import json
from dataclasses import dataclass, field
from html import escape

import httpx
import pytest
from fastapi.testclient import TestClient

import app.agent_tools as agent_tools
import app.chat.service as service_module
from app.agent_tools import problem_search
from app.main import create_app
from tests.test_acceptance_support import isolated_settings
from tests.test_chat import FakeChat, send
from tests.test_coordinator_wakeup import (
    STUDENT,
    WakeModel,
    delegated_thread,
    resolve,
    settle,
    setup,
)

PUBLIC_URL = "https://good.example.com/article"
PUBLIC_IP = "93.184.216.34"
SUCCESS_KEYS = {"url", "title", "text", "truncated", "chars"}
FAILURE_KEYS = SUCCESS_KEYS | {"error"}
TRUNCATION_NOTICE = "…（正文过长，已截断，原文 {chars} 字）"


@dataclass
class FetchHarness:
    requests: list[httpx.Request] = field(default_factory=list)
    resolver_calls: list[str] = field(default_factory=list)
    factory_calls: int = 0


def page_html(body: str, title: str | None = "示例标题") -> str:
    title_markup = "" if title is None else f"<title>{escape(title)}</title>"
    return (
        "<!doctype html><html><head>" + title_markup + "</head>"
        "<body><main><p>" + escape(body) + "</p></main></body></html>"
    )


def install_fetcher(
    monkeypatch,
    *,
    html: str = "",
    handler=None,
    addresses: list[str] | None = None,
) -> FetchHarness:
    """每次工厂调用都返回真实 PageFetcher；transport 和 resolver 全部离线。"""
    harness = FetchHarness()
    resolved_addresses = [PUBLIC_IP] if addresses is None else addresses

    async def fake_resolver(host: str) -> list[str]:
        harness.resolver_calls.append(host)
        return list(resolved_addresses)

    def default_handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"content-type": "text/html; charset=utf-8"},
            text=html,
            request=request,
        )

    selected_handler = default_handler if handler is None else handler

    def recording_handler(request: httpx.Request) -> httpx.Response:
        harness.requests.append(request)
        return selected_handler(request)

    transport = httpx.MockTransport(recording_handler)

    def fetcher_factory() -> problem_search.PageFetcher:
        harness.factory_calls += 1
        return problem_search.PageFetcher(transport=transport, resolver=fake_resolver)

    monkeypatch.setattr(problem_search, "_fetcher", fetcher_factory)
    return harness


def parse_success(raw: str) -> dict:
    result = json.loads(raw)
    assert set(result) == SUCCESS_KEYS
    assert isinstance(result["url"], str)
    assert isinstance(result["title"], str)
    assert isinstance(result["text"], str)
    assert isinstance(result["truncated"], bool)
    assert isinstance(result["chars"], int) and result["chars"] >= 0
    return result


def assert_failure(raw: str, *, url: str, error: str) -> dict:
    result = json.loads(raw)
    assert set(result) == FAILURE_KEYS
    assert result["url"] == url
    assert result["title"] == ""
    assert result["text"] == ""
    assert result["truncated"] is False
    assert result["chars"] == 0
    assert result["error"] == error
    return result


def test_public_html_returns_title_body_url_and_focus_is_inert(monkeypatch):
    body = "栈是后进先出的线性表，队列是先进先出的线性表。本文说明两种结构的操作差异。"
    html = page_html(body, "栈与队列")
    harness = install_fetcher(monkeypatch, html=html)
    spaced_url = f"  {PUBLIC_URL}  "

    without_focus = asyncio.run(problem_search.run_web_fetch({"url": spaced_url}))
    with_focus = asyncio.run(problem_search.run_web_fetch({
        "url": spaced_url,
        "focus": "只关注队列，但不要摘要或改写",
    }))

    assert without_focus == with_focus
    result = parse_success(without_focus)
    expected_body = problem_search.html_to_text(html)[0]
    assert body in expected_body
    assert result == {
        "url": PUBLIC_URL,
        "title": "栈与队列",
        "text": expected_body,
        "truncated": False,
        "chars": len(expected_body),
    }
    assert "focus" not in result
    assert harness.factory_calls == 2
    assert [str(request.url) for request in harness.requests] == [PUBLIC_URL, PUBLIC_URL]
    assert harness.resolver_calls == ["good.example.com"] * 4


@pytest.mark.parametrize("title", [None, "   "])
def test_missing_or_blank_title_keeps_body_and_succeeds(monkeypatch, title):
    body = "没有可用标题时，仍应返回已经清洗的网页正文。"
    html = page_html(body, title)
    harness = install_fetcher(monkeypatch, html=html)

    result = parse_success(asyncio.run(problem_search.run_web_fetch({"url": PUBLIC_URL})))

    expected_body = problem_search.html_to_text(html)[0]
    assert result["title"] == ""
    assert result["text"] == expected_body
    assert result["chars"] == len(expected_body)
    assert result["truncated"] is False
    assert len(harness.requests) == 1


@pytest.mark.parametrize(
    ("url", "expected_echo"),
    [
        ("http://127.0.0.1/", "http://127.0.0.1/"),
        ("http://10.0.0.5/", "http://10.0.0.5/"),
        ("http://localhost/", "http://localhost/"),
        ("file:///etc/passwd", "file:///etc/passwd"),
        ("ftp://good.example.com/a", "ftp://good.example.com/a"),
        ("https://good.example.com:8080/", "https://good.example.com:8080/"),
    ],
)
def test_dangerous_addresses_are_rejected_with_zero_http_requests(monkeypatch, url, expected_echo):
    harness = install_fetcher(monkeypatch, html=page_html("不应被读取"))

    raw = asyncio.run(problem_search.run_web_fetch({"url": url}))

    assert_failure(raw, url=expected_echo, error="目标地址不被允许。")
    assert harness.factory_calls == 1
    assert harness.requests == []
    assert harness.resolver_calls == []


@pytest.mark.parametrize(
    ("arguments", "expected_echo"),
    [
        (None, ""),
        ({}, ""),
        ({"url": ""}, ""),
        ({"url": "  \t  "}, ""),
        ({"url": 123}, ""),
        ({"url": True}, ""),
        ({"url": [PUBLIC_URL]}, ""),
        ({"url": PUBLIC_URL, "focus": 7}, PUBLIC_URL),
        ({"url": PUBLIC_URL, "focus": None}, PUBLIC_URL),
        ({"url": PUBLIC_URL, "extra": "forbidden"}, PUBLIC_URL),
        ({"url": "https://good.example.com/" + "a" * 2048}, ""),
    ],
)
def test_invalid_arguments_fail_before_factory_resolver_or_transport(monkeypatch, arguments, expected_echo):
    harness = install_fetcher(monkeypatch, html=page_html("不应被读取"))

    raw = asyncio.run(problem_search.run_web_fetch(arguments))

    assert_failure(raw, url=expected_echo, error="参数无效：仅接受非空字符串 url 和可选字符串 focus。")
    assert harness.factory_calls == 0
    assert harness.resolver_calls == []
    assert harness.requests == []


def test_credentials_are_not_echoed_or_requested(monkeypatch):
    harness = install_fetcher(monkeypatch, html=page_html("不应被读取"))
    credential_url = "https://user:secret-password@good.example.com/private"

    raw = asyncio.run(problem_search.run_web_fetch({"url": credential_url}))

    assert_failure(raw, url="", error="目标地址不被允许。")
    assert "secret-password" not in raw
    assert "user:secret" not in raw
    assert harness.requests == []


@pytest.mark.parametrize("failure_kind", ["timeout", "http_503", "unsupported_type"])
def test_fetch_failures_are_hidden_and_return_no_partial_content(monkeypatch, failure_kind):
    sensitive_text = "boom-sensitive-response"

    def failing_handler(request: httpx.Request) -> httpx.Response:
        if failure_kind == "timeout":
            raise httpx.ConnectTimeout(sensitive_text, request=request)
        if failure_kind == "http_503":
            return httpx.Response(503, text=sensitive_text, request=request)
        return httpx.Response(
            200,
            headers={"content-type": "application/pdf"},
            content=b"%PDF-sensitive-binary",
            request=request,
        )

    harness = install_fetcher(monkeypatch, handler=failing_handler)

    raw = asyncio.run(problem_search.run_web_fetch({"url": PUBLIC_URL}))

    assert_failure(raw, url=PUBLIC_URL, error="网页读取失败，请稍后重试或更换链接。")
    assert sensitive_text not in raw
    assert "sensitive" not in raw
    assert "Traceback" not in raw
    assert len(harness.requests) == 1


def test_empty_extracted_body_is_a_failure_without_title_or_partial_text(monkeypatch):
    html = (
        "<html><head><title>敏感标题</title></head><body>"
        "<script>敏感脚本</script><style>敏感样式</style></body></html>"
    )
    harness = install_fetcher(monkeypatch, html=html)

    raw = asyncio.run(problem_search.run_web_fetch({"url": PUBLIC_URL}))

    assert_failure(raw, url=PUBLIC_URL, error="网页正文不可用。")
    assert "敏感标题" not in raw
    assert "敏感脚本" not in raw
    assert len(harness.requests) == 1


@pytest.mark.parametrize("target", ["html_to_text", "_extract_html_title"])
def test_ordinary_parsing_exceptions_are_converted_and_hidden(monkeypatch, target):
    harness = install_fetcher(monkeypatch, html=page_html("可读取正文", "可读取标题"))

    def explode(*_args, **_kwargs):
        raise RuntimeError("boom-sensitive-parse")

    monkeypatch.setattr(problem_search, target, explode)

    raw = asyncio.run(problem_search.run_web_fetch({"url": PUBLIC_URL}))

    assert_failure(raw, url=PUBLIC_URL, error="网页读取失败，请稍后重试。")
    assert "boom-sensitive-parse" not in raw
    assert "Traceback" not in raw
    assert len(harness.requests) == 1


def test_allowed_exception_is_converted_without_any_http_request(monkeypatch):
    harness = install_fetcher(monkeypatch, html=page_html("不应被读取"))

    async def explode_allowed(self, url):
        raise RuntimeError("boom-sensitive-allowed")

    monkeypatch.setattr(problem_search.PageFetcher, "allowed", explode_allowed)

    raw = asyncio.run(problem_search.run_web_fetch({"url": PUBLIC_URL}))

    assert_failure(raw, url=PUBLIC_URL, error="网页读取失败，请稍后重试。")
    assert "boom-sensitive-allowed" not in raw
    assert harness.requests == []


def test_cancellation_propagates_instead_of_becoming_error_json(monkeypatch):
    def cancelled_handler(request: httpx.Request) -> httpx.Response:
        raise asyncio.CancelledError

    harness = install_fetcher(monkeypatch, handler=cancelled_handler)

    with pytest.raises(asyncio.CancelledError):
        asyncio.run(problem_search.run_web_fetch({"url": PUBLIC_URL}))
    assert len(harness.requests) == 1


@pytest.mark.parametrize("body_length", [6000, 6001])
def test_run_preserves_exact_budget_boundary_and_truncation_suffix(monkeypatch, body_length):
    body = ("数据结构" * (body_length // 4)) + ("尾" if body_length % 4 else "")
    assert len(body) == body_length
    html = page_html(body, "预算边界")
    harness = install_fetcher(monkeypatch, html=html)

    raw = asyncio.run(agent_tools.run("web_fetch", {"url": PUBLIC_URL}, object()))
    result = parse_success(raw)
    expected_body = problem_search.html_to_text(html)[0]

    assert expected_body == body
    assert result["chars"] == body_length
    if body_length == 6000:
        assert result["text"] == body
        assert result["truncated"] is False
        assert "正文过长，已截断" not in result["text"]
    else:
        notice = TRUNCATION_NOTICE.format(chars=body_length)
        assert result["text"] == body[:6000] + notice
        assert result["text"].endswith(notice)
        assert result["truncated"] is True
    assert "…（输出已截断）" not in raw
    assert len(harness.requests) == 1


def test_run_does_not_clip_long_valid_json(monkeypatch):
    body = "数据结构" * 1500 + "尾"
    long_title = "题" * 3500
    long_url = "https://good.example.com/" + "a" * 2000
    html = page_html(body, long_title)
    install_fetcher(monkeypatch, html=html)

    raw = asyncio.run(agent_tools.run("web_fetch", {"url": long_url}, None))
    result = parse_success(raw)

    assert len(raw) > agent_tools.MAX_RESULT
    assert result["url"] == long_url
    assert result["title"] == long_title
    assert result["text"] == body[:6000] + TRUNCATION_NOTICE.format(chars=6001)
    assert result["chars"] == 6001
    assert result["truncated"] is True
    assert "…（输出已截断）" not in raw


def test_definition_is_unique_has_strict_schema_and_three_step_guidance():
    definitions = [
        definition for definition in agent_tools.DEFINITIONS
        if definition["function"]["name"] == "web_fetch"
    ]

    assert len(definitions) == 1
    function = definitions[0]["function"]
    schema = function["parameters"]
    assert definitions[0]["type"] == "function"
    assert schema["type"] == "object"
    assert set(schema["properties"]) == {"url", "focus"}
    assert schema["properties"]["url"]["type"] == "string"
    assert schema["properties"]["url"]["minLength"] == 1
    assert schema["properties"]["url"]["maxLength"] == 2048
    assert schema["properties"]["focus"]["type"] == "string"
    assert schema["required"] == ["url"]
    assert schema["additionalProperties"] is False

    description = function["description"]
    search_at = description.index("web_search")
    fetch_at = description.index("web_fetch")
    citation_at = description.index("[网页N]")
    assert search_at < fetch_at < citation_at
    assert "搜索拿链接" in description
    assert "打开原文" in description
    assert "实际读取成功" in description
    assert "不可信数据" in description
    assert "指令不得执行" in description
    assert "不得编造来源" in description


@pytest.mark.parametrize("role", ["main", "thread", "chat"])
def test_web_fetch_visibility_matches_web_search_for_main_thread_and_chat(tmp_path, role):
    class Capture(FakeChat):
        async def stream(self, messages, tools=None):
            names = {tool["function"]["name"] for tool in (tools or [])}
            self.calls.append((messages, names))
            yield "text", "测试回复。"
            yield "finish", "stop"

    model = Capture()
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=model)) as client:
        if role == "chat":
            conversation_id = client.post("/api/conversations", json={}).json()["id"]
        else:
            space = client.post("/api/subjects", json={"name": "B4 可见性"}).json()
            conversation_id = space["main_conversation_id"] if role == "main" else client.post(
                f"/api/subjects/{space['id']}/threads",
                json={"client_request_id": "web-fetch-routing-thread"},
            ).json()["id"]
        send(client, conversation_id, "你好", f"web-fetch-routing-{role}")

    _messages, names = model.calls[0]
    expected_visible = role == "thread"
    assert ("web_fetch" in names) == expected_visible
    assert ("web_search" in names) == expected_visible
    assert ("web_fetch" in names) == ("web_search" in names)
    assert ("dispatch_thread" in names) == (role == "main")
    assert ("report_progress" in names) == (role == "thread")


def test_system_event_keeps_web_fetch_out_and_does_not_expand_allowed_tools(tmp_path, monkeypatch):
    monkeypatch.setattr(service_module, "WAKE_QUIET_SECONDS", 0)

    async def scenario():
        model = WakeModel()
        store, service, _subject_id, main = setup(tmp_path, model, name="web-fetch-event.sqlite3")
        try:
            _source, thread_id = delegated_thread(
                store, service, main, key="web-fetch-event-thread"
            )
            await settle(service)
            resolve(store, service, thread_id)
            await settle(service)

            assert len(model.wake_tools) == 1
            names = model.wake_tools[0]
            assert names == {"propose_threads", "update_plan", "session_search", "stay_silent"}
            assert "web_fetch" not in names
            assert "web_search" not in names
        finally:
            await service.close()

    asyncio.run(scenario())
"""Regressions for defects found by the 4-node x 40-turn end-to-end QA run (reports/qa_node_*.md)."""

import asyncio
import json
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr

from app.agent_tools import files, parse_arguments, preflight_blacklist
from app.agent_tools.guard import ToolError, check_content_security_blacklist, check_security_blacklist
from app.agents.llm import ChatCompletionsChat, _tool_calls_from
from app.chat.agent import chat_messages, learning_context
from app.chat.service import ChatService, Generation
from app.chat.skills import THREAD_SKILLS, select_skill_prompt
from app.config import Settings
from app.main import create_app
from app.memory.curated import snapshot_text
from app.services.ai_settings import AISettings
from tests.test_acceptance_support import isolated_settings
from tests.test_agent_regressions import STUDENT, chat_store
from tests.test_chat import FakeChat, send


def llm_settings():
    return Settings(_env_file=None, llm_api_key="test", llm_base_url="https://llm.test/v1", llm_model="m")


# 1. suggest-reply reads the real Settings from the AISettings holder.
def test_suggest_reply_uses_current_settings_and_bounds_text(tmp_path, monkeypatch):
    seen = {}

    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def post(self, url, json, headers):
            seen["model"] = json["model"]
            return httpx.Response(200, json={"choices": [{"message": {"content": "好" * 200}}]})

    def endpoint(cfg):
        seen["cfg"] = cfg
        return "https://x", "k"

    monkeypatch.setattr(httpx, "AsyncClient", FakeClient)
    monkeypatch.setattr("app.agents.llm.provider_endpoint", endpoint)
    settings = isolated_settings(tmp_path).model_copy(update={
        "llm_api_key": SecretStr("k"), "llm_base_url": "https://llm.test/v1", "llm_model": "suggest-m"})
    with TestClient(create_app(settings, chat_model=FakeChat(["这是一段回复。"]))) as client:
        conversation = client.post("/api/conversations", json={}).json()
        send(client, conversation["id"], "你好", "suggest-001")
        body = client.get(f"/api/conversations/{conversation['id']}/suggest-reply").json()
    assert isinstance(seen["cfg"], Settings)
    assert seen["model"] == "suggest-m"
    assert 12 <= len(body["suggestion"]) <= 80


# 2. A mastery observation that weakens a misconception is not dropped.
def test_mastery_weakening_a_misconception_updates_both(tmp_path):
    store = chat_store(tmp_path)
    conversation = store.create_conversation(STUDENT, title=None, problem=None, client_request_id=None)
    first = store.add_user_message(conversation, "栈是先进先出", "weak-001")
    wrong = store.record_observation(
        STUDENT, kind="misconception", topic="栈", topic_key=None, summary="把栈当成先进先出",
        quote="栈是先进先出", reason="错误陈述", signal="supports", related_id=None,
        conversation_id=conversation, message_id=first,
    )
    second = store.add_user_message(conversation, "栈顶最后进最先出", "weak-002")
    changes = store.record_observation_changes(
        STUDENT, kind="mastery", topic="栈的 LIFO", topic_key=None, summary="能正确说明后进先出",
        quote="栈顶最后进最先出", reason="正确推导", signal="contradicts", related_id=wrong.memory.id,
        conversation_id=conversation, message_id=second,
    )
    assert [(c.memory.kind, c.memory.status) for c in changes] == [("misconception", "improving"),
                                                                   ("mastery", "observed")]
    assert changes[0].memory.id == wrong.memory.id


# 3. Streaming: heartbeats, decoded arguments, and one retry before the first byte.
def test_stream_skips_empty_heartbeat_lines():
    body = 'data:\n\ndata: \n\ndata: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n'

    async def collect():
        transport = httpx.MockTransport(lambda r: httpx.Response(200, text=body, headers={"content-type": "text/event-stream"}))
        return [item async for item in ChatCompletionsChat(llm_settings(), transport).stream([])]

    assert asyncio.run(collect()) == [("text", "hi"), ("finish", "stop")]


def test_complete_tool_call_dict_arguments_become_json():
    calls = _tool_calls_from([{"id": "a", "function": {"name": "read", "arguments": {"path": "笔记.txt"}}}])
    assert json.loads(calls[0]["arguments"]) == {"path": "笔记.txt"}
    assert "'" not in calls[0]["arguments"]


def test_stream_retries_once_on_connect_error_before_output():
    attempts = []

    def handler(request):
        attempts.append(1)
        if len(attempts) == 1:
            raise httpx.ConnectError("reset")
        return httpx.Response(200, text='data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
                              headers={"content-type": "text/event-stream"})

    async def collect():
        return [item async for item in ChatCompletionsChat(llm_settings(), httpx.MockTransport(handler)).stream([])]

    assert asyncio.run(collect()) == [("text", "ok"), ("finish", "stop")]
    assert len(attempts) == 2


def test_default_llm_timeout_allows_long_derivations():
    assert Settings(_env_file=None).llm_timeout_seconds == 90


# 4. Blacklist precision, Windows/env gaps, content scanning and approval order.
@pytest.mark.parametrize("command", [
    "npm run format", "echo su", "echo 'sudo is dangerous'", "git log --format=%h",
])
def test_blacklist_does_not_flag_harmless_mentions(command):
    assert check_security_blacklist(command) is None


@pytest.mark.parametrize("command", [
    "printenv", "echo $env:OPENAI_API_KEY", "Get-ChildItem Env:", "cat /proc/self/environ", "cat /proc/1/environ",
    "rd /s /q C:\\", "del /f /s /q C:\\Windows\\temp", "%0|%0", "format C:", "ls; sudo reboot", "cd x && su root",
])
def test_blacklist_covers_env_dumps_windows_destruction_and_batch_bombs(command):
    assert check_security_blacklist(command)


def test_private_keys_cannot_be_written_or_edited(tmp_path):
    key = "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----"
    assert check_content_security_blacklist(key)
    assert check_content_security_blacklist("普通笔记") is None
    with pytest.raises(ToolError, match="^安全防线拦截："):
        files.write_file(tmp_path, {"path": "notes.txt", "content": key})
    (tmp_path / "notes.txt").write_text("old", encoding="utf-8")
    with pytest.raises(ToolError, match="^安全防线拦截："):
        files.edit_file(tmp_path, {"path": "notes.txt", "old_text": "old", "new_text": key})
    assert (tmp_path / "notes.txt").read_text(encoding="utf-8") == "old"


def test_blacklisted_calls_are_blocked_before_any_approval_card(tmp_path):
    class Holder:
        def agent_config(self):
            return {"workspace": str(tmp_path), "auto_approve": False}

    async def scenario():
        service = ChatService(chat_store(tmp_path), FakeChat, settings=Holder())
        generation = Generation("c", "u", "a")
        state = {"pending": [{"id": "t1", "name": "bash", "arguments": '{"command":"rm -rf /"}'}],
                 "next_call": 0, "tool_log": [], "messages": [], "tool_messages": []}
        definitions = [{"function": {"name": "bash"}}]
        await asyncio.wait_for(service._execute_tools(generation, state, definitions, None), 2)
        events = []
        while not generation.queue.empty():
            events.append(generation.queue.get_nowait()[0])
        return state, events

    state, events = asyncio.run(scenario())
    assert "tool_approval" not in events and "tool_start" not in events
    assert state["tool_log"][0]["output"].startswith("安全防线拦截：")
    assert state["tool_log"][0]["ok"] is False
    assert preflight_blacklist("bash", '{"command":"echo hello"}') is None


# 6. SMTP rejection falls back to an on-screen demo code.
def test_smtp_failure_falls_back_to_demo_code(tmp_path, monkeypatch):
    def reject(*args, **kwargs):
        raise OSError("recipient rejected")

    monkeypatch.setattr("app.auth.router._send_smtp_email", reject)
    settings = isolated_settings(tmp_path, smtp_host="smtp.test", smtp_user="bot@test.local", smtp_password="pw")
    with TestClient(create_app(settings, chat_model=FakeChat())) as client:
        response = client.post("/api/auth/send-code", json={"email": "alice@test.local", "purpose": "register"})
    assert response.status_code == 200
    body = response.json()
    assert body["delivery"] == "demo" and body["demo_code"] and body["expires_in"] == 300


# 7. A Feynman self-test keeps its skill on later turns.
def test_feynman_challenge_sticks_after_the_first_turn():
    feynman = THREAD_SKILLS["feynman_challenge"]
    assert select_skill_prompt("thread", "栈就是一摞盘子", earlier_user_texts=["我来讲讲栈，你当考官挑刺"]) == feynman
    assert select_skill_prompt("thread", "栈就是一摞盘子", conversation_title="费曼自测：栈") == feynman
    chat = select_skill_prompt("chat", "为什么栈顶先出？我的理解是这样", earlier_user_texts=["听我讲一遍栈"])
    assert chat == feynman.replace("，并调用 `report_progress` 回报掌握结论", "")
    assert select_skill_prompt("thread", "为什么栈顶先出", earlier_user_texts=["讲讲栈"]) != feynman


# 9. Prior-knowledge extraction and preference deduplication.
def context(*messages, user=""):
    rows = []
    for index, text in enumerate(messages):
        if index:
            rows.append({"role": "assistant", "content": "好的。", "kind": "text", "status": "complete", "meta_json": "{}"})
        rows.append({"role": "user", "content": text, "kind": "text", "status": "complete", "meta_json": "{}"})
    return learning_context(chat_messages(rows, [], None, [], snapshot=snapshot_text({"user": user, "memory": ""})))


@pytest.mark.parametrize("text,expected", [
    ("我大一熟练学过C语言，现在想学Python", ["C语言"]),
    ("我本科自学过Java、C++", ["Java", "C++"]),
    ("我学过C语言但不会指针", ["C语言"]),
    ("我不会C，但我学过Java", ["Java"]),
])
def test_reported_prior_knowledge_handles_adverbs_lists_and_negated_tails(text, expected):
    assert context(text)["reported_prior_knowledge"] == expected


@pytest.mark.parametrize("text", ["我想学会Python", "我没学过C语言", "如果我学过C会更快吗", "假设我会用Java，那么呢"])
def test_hypothetical_or_negated_prior_knowledge_is_ignored(text):
    assert "reported_prior_knowledge" not in context(text)


def test_anchor_lists_split_and_preferences_deduplicate():
    turn = context("我想学 Python", user=(
        "先验技能：C语言、Java，但没学过指针\n§\n[Preference] 讲解偏好：先举例\n§\n讲解偏好：先举例"
    ))
    assert turn["prior_knowledge_anchors"] == ["C语言", "Java"]
    assert turn["teaching_preferences"] == [{"source": "USER", "summary": "讲解偏好：先举例"}]


# 10. Broken tool arguments get one actionable Chinese error; notes before the object are skipped.
def test_tool_arguments_after_a_bracketed_note_are_extracted():
    assert parse_arguments('[见下] {"path": "notes.txt"}') == {"path": "notes.txt"}


@pytest.mark.parametrize("raw", ['{"path": "notes.txt"', "{'path': 'notes.txt'}", '{"path": notes.txt}'])
def test_broken_tool_arguments_raise_one_tool_error(raw):
    with pytest.raises(ToolError, match="^工具参数不是有效的 JSON 对象，请检查括号与引号闭合后重试。$"):
        parse_arguments(raw)


# 12. Reads during a concurrent replace retry instead of dropping the workspace.
def test_ai_settings_read_retries_transient_os_errors(tmp_path, monkeypatch):
    holder = AISettings(isolated_settings(tmp_path))
    holder.save_agent({"workspace": str(tmp_path)})
    original, failures = Path.read_text, []

    def flaky(path, *args, **kwargs):
        if path == holder.path and not failures:
            failures.append(1)
            raise PermissionError("being replaced")
        return original(path, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", flaky)
    assert holder.agent_config()["workspace"] == str(tmp_path)
    assert failures == [1]

"""Regressions for persisted tool context, execution lifecycle and desktop startup."""

import asyncio
import copy
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from app.agent_tools import run as run_tool
from app.agent_tools.bash import run as run_command
from app.agent_tools.guard import ToolError
from app.chat.agent import dialogue
from app.chat.service import ChatService, Generation, ToolContext, MAX_TOOL_ROUNDS
from app.chat.store import ChatStore
from app.memory.store import Store
from tests.test_chat import FakeChat

STUDENT = "demo-student-001"


def chat_store(tmp_path):
    base = Store(tmp_path / "chat.sqlite3")
    base.initialize()
    store = ChatStore(base)
    store.initialize()
    return store


class FileChat(FakeChat):
    async def stream(self, messages, tools=None):
        self.calls.append(copy.deepcopy(messages))
        if len(self.calls) == 1:
            yield "text", "先读取文件。"
            yield "tool_calls", [
                {"id": "read-1", "name": "read", "arguments": '{"path":"notes.txt"}'},
                {"id": "read-2", "name": "read", "arguments": '{"path":"other.txt"}'},
            ]
            yield "finish", "tool_calls"
        else:
            yield "text", "已经读完。"
            yield "finish", "stop"


def test_file_results_and_call_groups_survive_followup_and_budget(tmp_path):
    async def scenario():
        (tmp_path / "notes.txt").write_text("unique fact alpha", encoding="utf-8")
        (tmp_path / "other.txt").write_text("unique fact beta", encoding="utf-8")
        store = chat_store(tmp_path)
        conversation = store.create_conversation(STUDENT, title=None, problem=None, client_request_id=None)

        class Settings:
            def agent_config(self):
                return {"workspace": str(tmp_path)}

        model = FileChat()
        service = ChatService(store, lambda: model, settings=Settings())
        for index in range(2):
            user = store.add_user_message(conversation, "继续", f"req-tools-{index}")
            async for _ in service.events(service.begin(STUDENT, conversation, user, [])):
                pass
        followup = model.calls[2]
        calls = next(t for t in followup if t.get("tool_calls"))
        assert len(calls["tool_calls"]) == 2
        assert [t["tool_call_id"] for t in followup if t["role"] == "tool"] == ["read-1", "read-2"]
        assert "unique fact alpha" in next(t["content"] for t in followup if t.get("tool_call_id") == "read-1")
        assert "unique fact beta" in next(t["content"] for t in followup if t.get("tool_call_id") == "read-2")
        assert sum(t["content"] == "先读取文件。" for t in followup) == 1
        history = store.history(conversation)
        reply = next(row for row in history if row["role"] == "assistant")
        # A budget boundary may drop the entire group, but never part of it.
        for extra in range(35, 44):
            rows = [reply] + [dict(history[-1], content="x" * 500, meta_json="{}") for _ in range(extra)]
            transcript = dialogue(rows, include_tools=True)
            ids = [t["tool_call_id"] for t in transcript if t["role"] == "tool"]
            assert ids in ([], ["read-1", "read-2"])

    asyncio.run(scenario())


def test_tool_loop_exhaustion_is_failed_and_keeps_tool_cards(tmp_path):
    class LoopChat(FakeChat):
        async def stream(self, messages, tools=None):
            yield "tool_calls", [{"id": f"call-{len(messages)}", "name": "session_search", "arguments": '{"query":"nothing"}'}]
            yield "finish", "tool_calls"

    async def scenario():
        store = chat_store(tmp_path)
        conversation = store.create_conversation(STUDENT, title=None, problem=None, client_request_id=None)
        user = store.add_user_message(conversation, "搜索", "req-loop-001")
        service = ChatService(store, lambda: LoopChat())
        generation = service.begin(STUDENT, conversation, user, [])
        events = [event async for event in service.events(generation)]
        reply = store.message(generation.assistant_message_id, STUDENT)
        assert reply.status == "failed" and "上限" in reply.error
        assert len(store.message_meta(reply.id)["tool_calls"]) == MAX_TOOL_ROUNDS
        assert any("event: error" in event for event in events)
        assert not any("event: done" in event for event in events)

    asyncio.run(scenario())


def test_cancel_mid_batch_keeps_completed_results_and_closes_pending_calls(tmp_path, monkeypatch):
    async def scenario():
        store = chat_store(tmp_path)
        conversation = store.create_conversation(STUDENT, title=None, problem=None, client_request_id=None)
        second_started = asyncio.Event()

        async def fake_tool(name, arguments, ctx):
            if arguments["path"] == "notes.txt":
                return "completed first result"
            second_started.set()
            await asyncio.Event().wait()

        monkeypatch.setattr("app.chat.service.run_tool", fake_tool)
        model = FileChat()

        class Settings:
            def agent_config(self):
                return {"workspace": str(tmp_path)}

        service = ChatService(store, lambda: model, settings=Settings())
        user = store.add_user_message(conversation, "读取", "req-cancel-tools")
        generation = service.begin(STUDENT, conversation, user, [])
        await asyncio.wait_for(second_started.wait(), 3)
        assert service.stop(conversation)
        await generation.task
        reply = store.message(generation.assistant_message_id, STUDENT)
        assert reply.status == "cancelled"
        transcript = dialogue(store.history(conversation), include_tools=True)
        results = [m for m in transcript if m["role"] == "tool"]
        assert len(results) == 2
        assert results[0]["content"] == "completed first result"
        assert "未取得" in results[1]["content"]
        assert sum(m["content"] == "先读取文件。" for m in transcript) == 1

    asyncio.run(scenario())


def test_shell_always_requires_approval_even_with_auto_approve(tmp_path):
    class Settings:
        def agent_config(self):
            return {"auto_approve": True}

    async def scenario():
        service = ChatService(chat_store(tmp_path), FakeChat, settings=Settings())
        generation = Generation("c", "u", "a")
        task = asyncio.create_task(service._await_approval(generation, "bash", '{"command":"echo test"}'))
        event, payload = await asyncio.wait_for(generation.queue.get(), 2)
        assert event == "tool_approval"
        service.resolve_approval(payload["id"], False)
        assert not await task
        assert service.approvals == {}

    asyncio.run(scenario())


def test_session_search_tool_includes_current_conversation(tmp_path):
    async def scenario():
        store = chat_store(tmp_path)
        conversation = store.create_conversation(STUDENT, title=None, problem=None, client_request_id=None)
        store.add_user_message(conversation, "资料在一个特殊资料夹", "req-search-current")
        ctx = ToolContext(None, store, STUDENT, conversation)
        assert "特殊资料夹" in await run_tool("session_search", {"query": "特殊资料夹"}, ctx)

    asyncio.run(scenario())


@pytest.mark.skipif(os.name != "nt", reason="Windows PowerShell process-tree regression")
@pytest.mark.parametrize("cancel", [False, True])
def test_shell_timeout_and_cancel_stop_descendants(tmp_path, cancel):
    async def scenario():
        # The child would leave a file if it survives its parent's timeout/cancellation.
        marker = tmp_path / "child-survived.txt"
        started = tmp_path / "child-started.txt"
        child = tmp_path / "child.ps1"
        child.write_text("Set-Content child-started.txt ready\nStart-Sleep -Seconds 4\nSet-Content child-survived.txt bad\n", encoding="utf-8")
        command = "& powershell -NoProfile -NonInteractive -File ./child.ps1"
        task = asyncio.create_task(run_command(tmp_path, {"command": command, "timeout": 2}))
        if cancel:
            for _ in range(100):
                if started.exists():
                    break
                await asyncio.sleep(0.03)
            assert started.exists()
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        else:
            with pytest.raises(ToolError, match="已终止进程树"):
                await task
            assert started.exists()
        await asyncio.sleep(4.2)
        assert not marker.exists()

    asyncio.run(scenario())


def test_windowless_desktop_initializes_uvicorn_and_file_logging(tmp_path):
    code = """
import logging, sys
from pathlib import Path
import desktop_entry
sys.stdout = sys.stderr = None
def check(app, **options):
    assert options['log_config'] is None
    config = desktop_entry.uvicorn.Config(app, **options)
    config.load()
    logging.getLogger('uvicorn.error').info('windowless-startup-ok')
desktop_entry.uvicorn.run = check
sys.argv = ['desktop_entry', '--port', '8765']
desktop_entry.main()
"""
    env = {**os.environ, "KNOWGAP_DATA_DIR": str(tmp_path)}
    result = subprocess.run([sys.executable, "-c", code], cwd=Path(__file__).resolve().parents[1],
                            env=env, capture_output=True, timeout=30)
    assert result.returncode == 0, result.stderr.decode(errors="replace")
    assert "windowless-startup-ok" in (tmp_path / "logs" / "backend.log").read_text(encoding="utf-8")

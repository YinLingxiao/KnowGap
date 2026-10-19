"""Crash tests use os._exit in a child process: no cancellation handler or finally can save us."""
import asyncio
import subprocess
import sys
from types import SimpleNamespace

import pytest

from app.chat.checkpoints import resume_state
from app.chat.service import ChatService
from app.chat.store import ChatStore
from app.memory.store import Store
from app.services.materials import MaterialStore
from tests.test_chat import FakeChat
from tests.test_thread_coordination import STUDENT, settle


CRASH_SCRIPT = r'''
import asyncio, json, os, sys
from pathlib import Path
from types import SimpleNamespace
from app.chat.service import ChatService
from app.chat.store import ChatStore
from app.memory.store import Store
from app.services.materials import MaterialStore
from tests.test_chat import FakeChat

mode, dbpath, workspace = sys.argv[1:]
base = Store(Path(dbpath))
base.initialize()
MaterialStore(base).initialize()
store = ChatStore(base)
store.initialize()
student = "demo-student-001"
sid = store.create_subject(student, "Crash test", "", "").id
thread = store.create_thread(student, sid, title="File task", anchor_message_id=None, client_request_id="crash-thread-001")
user = store.add_user_message(thread, "写一份笔记", "crash-input-001")
settings = SimpleNamespace(agent_config=lambda: {"workspace": workspace, "auto_approve": True})

class CrashModel(FakeChat):
    async def stream(self, messages, tools=None):
        if messages[-1]["role"] == "tool":
            os._exit(91)  # result was durably saved; the next model call crashes
        calls = [{"id": "write-once", "name": "write",
            "arguments": json.dumps({"path": "result.txt", "content": "written exactly once"})}]
        if mode == "midbatch":
            calls.append({"id": "write-second", "name": "write",
                "arguments": json.dumps({"path": "result-2.txt", "content": "second file"})})
        yield "tool_calls", calls
        yield "finish", "stop"

if mode == "uncertain":
    import app.chat.service as module
    original = module.run_tool
    async def kill_after_side_effect(name, arguments, ctx):
        await original(name, arguments, ctx)
        os._exit(92)  # effect exists, but its result has NOT been committed
    module.run_tool = kill_after_side_effect

async def scenario():
    service = ChatService(store, lambda: CrashModel(), settings=settings)
    if mode == "midbatch":
        async def approval(gen, name, arguments):
            if "result-2.txt" in arguments:
                os._exit(93)  # first result committed; second tool not yet executed
            return True
        service._await_approval = approval
    gen = service.begin(student, thread, user, [], detached=True)
    await gen.task
asyncio.run(scenario())
'''


def crashed_store(tmp_path, mode):
    db = tmp_path / "crash.sqlite3"
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    result = subprocess.run([sys.executable, "-c", CRASH_SCRIPT, mode, str(db), str(workspace)],
                            timeout=20, capture_output=True)
    assert result.returncode == {"saved": 91, "uncertain": 92, "midbatch": 93}[mode], result.stderr.decode(errors="replace")
    assert (workspace / "result.txt").read_text() == "written exactly once"
    base = Store(db)
    base.initialize()
    store = ChatStore(base)
    store.initialize()  # converts stale streaming rows to failed
    thread = store.list_conversations(STUDENT)[0].id
    message = store.conversation(thread, STUDENT).messages[-1]
    settings = SimpleNamespace(agent_config=lambda: {"workspace": str(workspace), "auto_approve": True})
    return store, settings, thread, message


def test_real_crash_resumes_with_saved_tool_result_without_reexecuting(tmp_path, monkeypatch):
    store, settings, thread, message = crashed_store(tmp_path, "saved")
    assert message.status == "failed" and message.checkpoint_available
    checkpoint = store.message_meta(message.id)["last_checkpoint"]
    assert checkpoint["phase"] == "model" and not checkpoint["in_flight"]
    assert checkpoint["tool_log"][0]["name"] == "write"

    async def forbidden(*args):
        pytest.fail("completed write must not execute a second time")
    monkeypatch.setattr("app.chat.service.run_tool", forbidden)

    class ResumeModel(FakeChat):
        async def stream(self, messages, tools=None):
            assert messages[-1]["role"] == "tool"
            assert messages[-1]["tool_call_id"] == "write-once"
            assert any(m.get("tool_calls") for m in messages)
            yield "text", "文件已保存，现在继续讲解。"
            yield "finish", "stop"

    async def scenario():
        service = ChatService(store, lambda: ResumeModel(), settings=settings)
        try:
            service.recover()  # no automatic replay of interrupted external effects
            assert not service.active
            gen = service.resume(STUDENT, thread, message.id)
            assert service.resume(STUDENT, thread, message.id) is gen
            await settle(service)
            result = store.message(message.id, STUDENT)
            assert result.status == "complete" and "继续讲解" in result.content
            assert not result.checkpoint_available
            assert len(result.tool_calls) == 1
        finally:
            await service.close()
    asyncio.run(scenario())


def test_real_crash_between_tools_only_executes_the_remaining_tool(tmp_path, monkeypatch):
    store, settings, thread, message = crashed_store(tmp_path, "midbatch")
    checkpoint = store.message_meta(message.id)["last_checkpoint"]
    assert checkpoint["phase"] == "tools" and checkpoint["next_call"] == 1
    assert message.checkpoint_available and not checkpoint["in_flight"]
    import app.chat.service as module
    original = module.run_tool
    paths = []
    async def spy(name, arguments, ctx):
        paths.append(arguments.get("path"))
        return await original(name, arguments, ctx)
    monkeypatch.setattr(module, "run_tool", spy)
    async def scenario():
        service = ChatService(store, lambda: FakeChat(["第二份文件也已保存。"]), settings=settings)
        try:
            service.resume(STUDENT, thread, message.id)
            await settle(service)
            assert paths == ["result-2.txt"]
            result = store.message(message.id, STUDENT)
            assert result.status == "complete" and len(result.tool_calls) == 2
            assert (tmp_path / "workspace" / "result-2.txt").read_text() == "second file"
        finally:
            await service.close()
    asyncio.run(scenario())


def test_real_crash_during_write_blocks_resume(tmp_path):
    store, settings, thread, message = crashed_store(tmp_path, "uncertain")
    assert not message.checkpoint_available
    assert "可能已经产生修改" in message.checkpoint_blocked_reason
    async def scenario():
        service = ChatService(store, lambda: FakeChat(), settings=settings)
        try:
            service.recover()
            with pytest.raises(ValueError, match="可能已经产生修改"):
                service.resume(STUDENT, thread, message.id)
            assert not service.active
        finally:
            await service.close()
    asyncio.run(scenario())


def test_unknown_read_can_be_repeated_but_write_cannot():
    state = {"version": 1, "role": "thread", "phase": "tools", "rounds": 1,
             "pending": [{"name": "read"}], "next_call": 0, "in_flight": True}
    assert resume_state(state, "failed") == (True, None)
    state["pending"][0]["name"] = "bash"
    assert resume_state(state, "failed")[0] is False
    assert resume_state(state, "cancelled") == (False, None)


def test_resume_http_contract(tmp_path):
    from fastapi.testclient import TestClient
    from app.agents.llm import ProviderError
    from app.main import create_app
    from tests.test_acceptance_support import isolated_settings
    from tests.test_chat import send

    class Model(FakeChat):
        failed = False
        async def stream(self, messages, tools=None):
            if messages[-1]["role"] != "tool":
                yield "tool_calls", [{"id": "readonly", "name": "session_search", "arguments": '{"query":"x"}'}]
            elif not self.failed:
                self.failed = True
                raise ProviderError(502, "network interrupted")
            else:
                yield "text", "从已保存的查询结果继续。"
            yield "finish", "stop"

    with TestClient(create_app(isolated_settings(tmp_path), chat_model=Model())) as client:
        space = client.post("/api/subjects", json={"name": "恢复"}).json()
        thread = client.post(f"/api/subjects/{space['id']}/threads", json={"client_request_id": "resume-thread-01"}).json()
        cid = thread["id"]
        send(client, cid, "查一查", "resume-input-001")
        reply = client.get(f"/api/conversations/{cid}").json()["messages"][-1]
        assert reply["status"] == "failed" and reply["checkpoint_available"]
        other = client.post("/api/conversations", json={}).json()["id"]
        assert client.post(f"/api/conversations/{other}/messages/{reply['id']}/resume").status_code == 404
        response = client.post(f"/api/conversations/{cid}/messages/{reply['id']}/resume")
        assert response.status_code == 200, response.text
        client.portal.call(settle, client.app.state.chat_service)
        result = client.get(f"/api/conversations/{cid}").json()["messages"]
        assert len(result) == 2 and result[-1]["id"] == reply["id"]
        assert result[-1]["status"] == "complete" and len(result[-1]["tool_calls"]) == 1
        assert not result[-1]["checkpoint_available"]

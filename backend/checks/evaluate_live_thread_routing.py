"""Opt-in real-model routing evaluation, using only synthetic temporary data.

Uses the current local provider configuration and makes billable requests.
Checks actual tool selection; NEVER executes generated tools, files or commands.
Run from backend/: .venv/Scripts/python.exe checks/evaluate_live_thread_routing.py
"""

import argparse
import asyncio
import json
import sys
from pathlib import Path
from tempfile import TemporaryDirectory

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.agent_tools import DEFINITIONS
from app.agents.llm import ChatCompletionsChat, ProviderError
from app.chat.agent import chat_messages
from app.chat.schemas import DispatchThread, ProposeThreads
from app.chat.store import ChatStore
from app.chat.usage import normalize_usage
from app.config import Settings
from app.memory.store import Store
from app.services.ai_settings import AISettings
from app.services.materials import MaterialStore


CASES = [
    {"name": "linked_list_intro", "user": "我想学一下链表，能介绍一下吗", "route": "dispatch_thread"},
    {"name": "accept_practice", "user": "可以", "route": "dispatch_thread", "accept": True},
    {"name": "start_practice", "user": "开始吧", "route": "dispatch_thread", "accept": True},
    {"name": "accept_without_context", "user": "可以", "route": None},
    {"name": "greeting_with_old_task", "user": "你好", "route": None, "existing": True},
    {"name": "one_sentence_fact", "user": "链表的节点必须在连续内存中吗？只用一句话回答。", "route": None},
    {"name": "compare_routes_only", "user": "我想学数据结构，帮我比较几种学习路线，先给建议，别开始教学。", "route": "propose_threads"},
    {"name": "continue_existing", "user": "接着刚才的链表 Thread，带我练一下删除节点。", "route": "dispatch_thread", "existing": True},
    {"name": "ordinary_chat", "user": "我想学一下链表，能介绍一下吗？请简短说明。", "route": None, "role": "chat"},
    {"name": "ambiguous_acceptance", "user": "可以", "route": None, "ambiguous": True, "allow_proposal": True},
]
STUDENT = "demo-student-001"


def prepare(store, case):
    if case.get("role") == "chat":
        cid = store.create_conversation(STUDENT, title=None, problem=None, client_request_id=None)
    else:
        sid = store.create_subject(STUDENT, "合成测试：数据结构", "", "").id
        cid = store.subject(sid, STUDENT).main_conversation_id
    existing_id = None
    if case.get("accept") or case.get("ambiguous") or case.get("existing"):
        source_text = "我想学数据结构，还没选先学哪一块" if case.get("ambiguous") else "我想学链表"
        source = store.add_user_message(cid, source_text, "synthetic-source")
        if case.get("accept"):
            offer = "要不要现在练一道链表头插法的题，自己实现 push_front？"
        elif case.get("ambiguous"):
            offer = "你想先学数组还是先学链表？请选择一个。"
        else:
            offer = "已安排链表基础 Thread，具体练习可以在那里继续。"
        reply = store.start_reply(cid, source, [])
        store.finish_reply(reply, content=offer, status="complete")
        if case.get("existing"):
            existing_id = store.create_thread(STUDENT, sid, title="链表基础：节点和头插法",
                                               anchor_message_id=source, client_request_id="synthetic-thread")
    store.add_user_message(cid, case["user"], "synthetic-latest")
    role = store.role_context(cid)
    messages = chat_messages(store.history(cid), [], None, [], store.conversation_subject(cid), role)
    definitions = [tool for tool in DEFINITIONS if (
        tool["function"]["name"] in {"dispatch_thread", "propose_threads", "session_search", "memory"}
        if role["role"] == "main" else tool["function"]["name"] not in {
            "dispatch_thread", "propose_threads", "report_progress", "exercise_reference",
        }
    )]
    return messages, definitions, existing_id


def judge(case, calls, text, existing_id):
    expected = case["route"]
    if expected is None:
        if not calls:
            return bool(text.strip())
        if case.get("allow_proposal"):
            expected = "propose_threads"  # Cards can ask the user to choose without starting work.
        else:
            return False
    if len(calls) != 1 or calls[0].get("name") != expected:
        return False
    try:
        arguments = json.loads(calls[0].get("arguments") or "{}")
        if expected == "propose_threads":
            ProposeThreads(**arguments)
            return True
        task = DispatchThread(**arguments)
        if task.thread_id != (existing_id if case.get("existing") else None):
            return False
        if "链表" not in task.task:
            return False
        return not case.get("accept") or "头插" in task.task or "push_front" in task.task
    except (ValueError, TypeError):
        return False


async def evaluate(configured, selected, output):
    results = []
    model = ChatCompletionsChat(configured)
    with TemporaryDirectory(prefix="thread-routing-", dir=output.parent) as temporary:
        base = Store(Path(temporary) / "synthetic.sqlite3")
        base.initialize()
        MaterialStore(base).initialize()
        store = ChatStore(base)
        store.initialize()
        for case in selected:
            messages, definitions, existing_id = prepare(store, case)
            parts, calls, usage, error = [], [], None, None
            async def collect():
                nonlocal usage
                async for kind, value in model.stream(messages, definitions):
                    if kind == "text":
                        parts.append(value)
                    elif kind == "tool_calls":
                        calls.extend(value)
                    elif kind == "usage":
                        usage = normalize_usage(value) or usage
            try:
                await asyncio.wait_for(collect(), timeout=60)
            except ProviderError as exc:
                error = exc.detail
            except TimeoutError:
                error = "评估请求超过 60 秒，未自动重试。"
            text = "".join(parts)
            passed = error is None and judge(case, calls, text, existing_id)
            results.append({"case": case["name"], "user": case["user"], "expected": case["route"],
                            "allow_proposal": bool(case.get("allow_proposal")),
                            "passed": passed, "calls": calls, "reply": text, "usage": usage, "error": error})
            output.write_text(json.dumps({"model": configured.llm_model, "tools_executed": False,
                                          "results": results}, ensure_ascii=False, indent=2), encoding="utf-8")
            print(json.dumps({"case": case["name"], "passed": passed,
                              "tools": [call.get("name") for call in calls], "error": error}, ensure_ascii=False), flush=True)
    passed = sum(result["passed"] for result in results)
    print(f"RESULT {passed}/{len(results)} passed; {output}", flush=True)
    return int(passed != len(results))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--case", action="append", choices=[case["name"] for case in CASES])
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parents[2] / "logs" / "thread-routing-live-result.json")
    args = parser.parse_args()
    configured = AISettings(Settings()).current
    if not configured.llm_api_key.get_secret_value() or not configured.llm_model:
        raise SystemExit("尚未配置模型，未运行评估。")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    selected = [case for case in CASES if not args.case or case["name"] in args.case]
    return asyncio.run(evaluate(configured, selected, args.output))


if __name__ == "__main__":
    raise SystemExit(main())

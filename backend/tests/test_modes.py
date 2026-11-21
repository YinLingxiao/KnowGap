"""B3 mode prompts: per-mode behavior, narrowed schema, and a byte-identical default path."""

import asyncio
import hashlib
import json

import pytest
from fastapi.testclient import TestClient

from app.chat.agent import chat_messages, learning_context
from app.chat.service import ChatService
from app.chat.skills import WIDGET_SYSTEM_PROMPT, mode_widgets, recommend_widget, select_skill_prompt
from app.chat.store import ChatStore
from app.main import create_app
from app.memory.store import Store
from app.services.materials import MaterialStore
from app.services.prompt import get_prompt_manager, prompt_text
from tests.test_acceptance_support import isolated_settings
from tests.test_chat import FakeChat


STUDENT = "demo-student-001"
MODES = ("explain", "solve", "practice", "plan", "research", "organize", "review")
ROWS = [{"role": "user", "content": "你好", "kind": "text", "status": "complete", "meta_json": "{}"}]

MODE_NONE_BASELINE = {
    "main": (7568, "23edb3f8987ba3ab"),
    "thread": (15730, "03c9004d719dbc57"),
    "chat": (13960, "75dfde915e727f71"),
}


def modes_yaml():
    return get_prompt_manager().load_prompts("chat", "modes")


def system_for(role: str = "chat", mode: str | None = None) -> str:
    messages = chat_messages(ROWS, [], None, [], conversation_role={"role": role}, mode=mode)
    return messages[0]["content"]


def schema_section(prompt: str) -> str:
    return prompt.split("【内联可交互学习微件规范（", 1)[1].split("【卡片写作与流式输出约定】", 1)[0]


@pytest.mark.parametrize("mode", MODES)
def test_mode_injects_label_prompt_and_hard_card_limit(mode):
    data = modes_yaml()[mode]
    system = system_for("chat", mode)

    assert data["label"] in system
    assert prompt_text(modes_yaml(), mode, "prompt") in system
    assert "回答原则：" not in system
    if mode_widgets(mode):
        assert f"本模式只使用以下卡片：{data['widgets']}；其它类型一律不要输出。" in system
    else:
        assert "本模式不使用交互卡片" in system
        assert "【内联可交互学习微件规范（" not in system
    assert ("【沙箱可视化卡规范（" in system) == (mode in {"explain", "solve"})


def test_practice_schema_keeps_only_micro_quiz():
    system = system_for("chat", "practice")
    schema = schema_section(system)

    assert "3. 随堂小测" in schema
    for marker in ("1. 分步推演", "2. 概念对比", "4. 代码实验台", "5. 缺口卡"):
        assert marker not in schema
    assert "本模式只用下面这 1 种类型" in schema
    assert "5 种类型" not in schema
    assert "【沙箱可视化卡规范（" not in system


def test_recommended_widget_respects_mode_allowlist():
    assert recommend_widget("chat", "练习一下栈和队列的区别", mode="practice").startswith("micro_quiz")
    assert recommend_widget("chat", "栈和队列的区别是什么", mode="practice") is None
    assert recommend_widget("chat", "给我制定一下这周复习算法和链表的计划", mode="plan") is None
    assert recommend_widget("chat", "调研一下 React 和 Vue 的区别", mode="research").startswith("comparison_matrix")
    assert recommend_widget("chat", "画个二叉树遍历动画", mode="research") is None
    ctx = learning_context(chat_messages(
        [{"role": "user", "content": "栈和队列有什么区别", "kind": "text", "status": "complete", "meta_json": "{}"}],
        [], None, [], conversation_role={"role": "chat"}, mode="plan",
    ))
    assert ctx["recommended_widget"] is None


def test_organize_mode_with_blank_file_turn_goes_straight_to_notes():
    for mode in ("organize", "review"):
        skill = select_skill_prompt("chat", "", attached_files=[{"id": "f1", "name": "notes.pdf"}], mode=mode)
        assert "file_to_notes" in skill
        assert "再问用户想怎么处理" not in skill


def test_review_schema_keeps_contrasts_quiz_and_gap_only():
    system = system_for("chat", "review")
    schema = schema_section(system)

    for marker in ("2. 概念对比", "3. 随堂小测", "5. 缺口卡"):
        assert marker in schema
    for marker in ("1. 分步推演", "4. 代码实验台"):
        assert marker not in schema
    assert "本模式只用下面这 3 种类型" in schema
    assert "【沙箱可视化卡规范（" not in system
    assert "read_document" in system and "gap 卡" in system


def test_research_mode_enables_web_search_in_chat(tmp_path):
    class Capture(FakeChat):
        async def stream(self, messages, tools=None):
            self.calls.append((messages, {tool["function"]["name"] for tool in (tools or [])}))
            yield "text", "好。"
            yield "finish", "stop"

    model = Capture()
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=model)) as client:
        cid = client.post("/api/conversations", json={}).json()["id"]
        r1 = client.post(
            f"/api/conversations/{cid}/messages",
            json={"content": "查一下 HTTP/3 的差异", "client_request_id": "req-res-1", "mode": "research"},
        )
        assert r1.status_code == 200
        r2 = client.post(
            f"/api/conversations/{cid}/messages",
            json={"content": "讲一下快速排序", "client_request_id": "req-exp-1", "mode": "explain"},
        )
        assert r2.status_code == 200

    _, research_tools = model.calls[0]
    _, explain_tools = model.calls[1]
    assert {"web_search", "web_fetch"} <= research_tools
    assert not ({"web_search", "web_fetch"} & explain_tools)


@pytest.mark.parametrize("role, length, digest", [
    ("main", *MODE_NONE_BASELINE["main"]),
    ("thread", *MODE_NONE_BASELINE["thread"]),
    ("chat", *MODE_NONE_BASELINE["chat"]),
])
def test_mode_none_keeps_the_exact_baseline(role, length, digest):
    system = system_for(role, None)

    assert len(system) == length
    assert hashlib.sha256(system.encode()).hexdigest()[:16] == digest
    assert len(WIDGET_SYSTEM_PROMPT) == 9804


def test_invalid_mode_is_rejected_by_the_api(tmp_path):
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=FakeChat(["好。"]))) as client:
        conversation = client.post("/api/conversations", json={}).json()["id"]
        for mode, request_id in (("quiz", "req-bad-quiz"), ("practice ", "req-bad-space")):
            response = client.post(
                f"/api/conversations/{conversation}/messages",
                json={"content": "你好", "client_request_id": request_id, "mode": mode},
            )
            assert response.status_code == 422, (mode, response.text)


def test_valid_mode_is_saved_on_the_user_message(tmp_path):
    settings = isolated_settings(tmp_path)
    with TestClient(create_app(settings, chat_model=FakeChat(["好。"]))) as client:
        conversation = client.post("/api/conversations", json={}).json()["id"]
        response = client.post(
            f"/api/conversations/{conversation}/messages",
            json={"content": "帮我练两道题", "client_request_id": "req-mode-ok", "mode": "practice"},
        )
        assert response.status_code == 200, response.text

        chat = ChatStore(Store(settings.resolved_database_path()))
        user = next(row for row in chat.history(conversation) if row["role"] == "user")
        assert json.loads(user["meta_json"])["mode"] == "practice"


def test_begin_reads_mode_from_the_user_message_meta(tmp_path):
    async def scenario():
        base = Store(tmp_path / "inherit.sqlite3")
        base.initialize()
        MaterialStore(base).initialize()
        chat = ChatStore(base)
        chat.initialize()
        conversation = chat.create_conversation(
            STUDENT, title=None, problem=None, client_request_id="conv-mode-inherit",
        )
        user_id = chat.add_user_message(conversation, "帮我练两道题", "req-mode-inherit")
        chat.merge_meta(user_id, {"mode": "practice"})
        service = ChatService(chat, lambda: FakeChat(["好。"]))
        generation = service.begin(STUDENT, conversation, user_id, [])

        assert generation.mode == "practice"
        await generation.task

    asyncio.run(scenario())
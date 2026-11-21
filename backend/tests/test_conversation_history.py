"""「上个对话聊了啥」：最近对话列表、按 id 打开原文、每轮带给模型的 recent_conversations。"""
import asyncio
import json
from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient

from app.agent_tools import run as run_tool
from app.chat.agent import chat_messages, learning_context
from app.chat.history import OPEN_BUDGET, recent, relative_time
from app.chat.service import ToolContext
from app.chat.store import ChatStore
from app.main import create_app
from app.memory.store import Store
from app.services.materials import MaterialStore
from tests.test_acceptance_support import isolated_settings
from tests.test_chat import FakeChat, context_of, send

STUDENT = "demo-student-001"
NOW = datetime(2026, 11, 21, 12, 0, tzinfo=timezone.utc)


def chat_store(tmp_path):
    base = Store(tmp_path / "chat.sqlite3")
    base.initialize()
    MaterialStore(base).initialize()
    store = ChatStore(base)
    store.initialize()
    return store


def talk(store, title, question, answer, *, student=STUDENT, subject_id=None, at=None):
    conversation = store.create_conversation(student, title=title, problem=None, client_request_id=None,
                                             subject_id=subject_id)
    user = store.add_user_message(conversation, question, f"req-{conversation}")
    reply = store.start_reply(conversation, user, [])
    store.finish_reply(reply, content=answer, status="complete")
    if at is not None:
        with store.connection() as db:
            db.execute("UPDATE conversation_messages SET created_at = ? WHERE conversation_id = ?",
                       (at.isoformat(), conversation))
    return conversation


def test_relative_time_reads_like_a_person():
    assert relative_time((NOW - timedelta(seconds=20)).isoformat(), NOW) == "刚刚"
    assert relative_time((NOW - timedelta(minutes=12)).isoformat(), NOW) == "12 分钟前"
    assert relative_time((NOW - timedelta(hours=4, minutes=5)).isoformat(), NOW) == "4 小时前"
    assert relative_time((NOW - timedelta(days=3)).isoformat(), NOW) == "3 天前"
    assert relative_time((NOW - timedelta(days=30)).isoformat(), NOW).startswith("2026-10-")
    assert relative_time("", NOW) == ""


def test_recent_lists_other_conversations_newest_first(tmp_path):
    store = chat_store(tmp_path)
    space = store.create_subject(STUDENT, "数据结构", "", "")
    old = talk(store, "海明码原理", "海明码怎么纠错", "按校验位定位出错位。", at=NOW - timedelta(days=1, hours=2))
    hex_chat = talk(store, "十六进制易错点", "0x1F 是多少", "是 31。```knowgap-quiz\n{\"q\":1}\n```", at=NOW - timedelta(hours=4))
    spaced = talk(store, "栈的应用", "括号匹配怎么做", "用栈。", subject_id=space.id, at=NOW - timedelta(hours=1))
    current = talk(store, "当前对话", "我上个对话聊了啥", "我查一下。", at=NOW)
    thread = talk(store, "支线", "支线问题", "支线回答。", at=NOW - timedelta(minutes=5))
    empty = store.create_conversation(STUDENT, title="空对话", problem=None, client_request_id=None)
    talk(store, "别人的", "别人的问题", "别人的回答。", student="another-student", at=NOW - timedelta(minutes=1))
    with store.connection() as db:
        db.execute("UPDATE conversations SET kind = 'thread', parent_id = ? WHERE id = ?", (spaced, thread))

    with store.connection() as db:
        items = recent(db, STUDENT, current, 5, detail=True, now=NOW)
    assert [item["conversation_id"] for item in items] == [spaced, hex_chat, old]
    assert empty not in {item["conversation_id"] for item in items}
    assert items[0]["space"] == "数据结构" and items[0]["when"] == "1 小时前"
    assert items[1]["when"] == "4 小时前" and "space" not in items[1]
    assert items[1]["first_question"] == "0x1F 是多少"
    assert items[1]["last_answer"] == "是 31。 [卡片或代码]", "cards are not dumped into the list"
    assert items[2]["when"] == "昨天"


def test_open_reads_the_original_and_trims_long_conversations(tmp_path):
    store = chat_store(tmp_path)
    short = talk(store, "海明码原理", "海明码怎么纠错", "按校验位定位出错位。")
    text = store.read_conversation(STUDENT, short)
    assert text.startswith("「海明码原理」")
    assert "用户：海明码怎么纠错" in text and "助手：按校验位定位出错位。" in text
    assert store.read_conversation("another-student", short) == "找不到这段对话，可能已经删除。"
    assert store.read_conversation(STUDENT, "conv-missing") == "找不到这段对话，可能已经删除。"

    long = store.create_conversation(STUDENT, title="长对话", problem=None, client_request_id=None)
    for index in range(30):
        user = store.add_user_message(long, f"第{index}问 " + "字" * 700, f"req-long-{index}")
        reply = store.start_reply(long, user, [])
        store.finish_reply(reply, content=f"第{index}答", status="complete")
    text = store.read_conversation(STUDENT, long)
    assert "第0问" in text and "第29答" in text, "keeps the start and the end"
    assert "中间省略" in text
    assert len(text) < OPEN_BUDGET + 400


def test_session_search_lists_opens_and_searches(tmp_path):
    async def scenario():
        store = chat_store(tmp_path)
        previous = talk(store, "十六进制易错点", "0x1F 是多少", "是 31。")
        current = talk(store, "当前对话", "我上个对话聊了啥", "我查一下。")
        ctx = ToolContext(None, store, STUDENT, current)

        listing = await run_tool("session_search", {}, ctx)
        assert "「十六进制易错点」" in listing and f"conversation_id: {previous}" in listing
        assert "「当前对话」" not in listing, "the current conversation is left out"

        opened = await run_tool("session_search", {"conversation_id": previous}, ctx)
        assert "用户：0x1F 是多少" in opened

        found = await run_tool("session_search", {"query": "0x1F"}, ctx)
        assert f"conversation_id: {previous}" in found, "search hits can be opened"

        assert "没有别的对话" in await run_tool("session_search", {"limit": 3},
                                                 ToolContext(None, store, "nobody", current))

    asyncio.run(scenario())


def test_turn_context_carries_recent_conversations_but_not_on_system_turns():
    rows = [{"role": "user", "content": "我上个对话聊了啥", "kind": "text", "status": "complete", "meta_json": "{}", "seq": 1}]
    listed = [{"conversation_id": "conv-1", "title": "十六进制易错点", "when": "4 小时前"}]
    context = learning_context(chat_messages(rows, [], None, [], recent_conversations=listed))
    assert context["recent_conversations"] == listed
    assert "recent_conversations" not in learning_context(chat_messages(rows, [], None, []))
    system = learning_context(chat_messages(rows, [], None, [], system_turn=True, recent_conversations=listed))
    assert "recent_conversations" not in system


def test_a_chat_turn_knows_the_previous_conversation(tmp_path):
    model = FakeChat(["0x1F 是 31。", "好的。"])
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=model)) as client:
        first = client.post("/api/conversations", json={}).json()["id"]
        send(client, first, "0x1F 是多少", "req-history-1")
        second = client.post("/api/conversations", json={}).json()["id"]
        send(client, second, "我上个对话聊了啥", "req-history-2")
    first_context = context_of(model.calls[0])
    assert "recent_conversations" not in first_context, "nothing else to list yet"
    listed = context_of(model.calls[1])["recent_conversations"]
    assert [item["conversation_id"] for item in listed] == [first]
    assert listed[0]["when"] == "刚刚"
    assert json.dumps(listed, ensure_ascii=False).count(second) == 0

"""Memory boundaries: general chats and learning spaces must not leak memories into each other."""

import asyncio
import logging

from app.chat.service import ChatService
from app.chat.store import ChatStore
from app.memory.store import Store
from app.services.materials import MaterialStore
from tests.test_chat import FakeChat


STUDENT = "demo-student-001"


def make_store(tmp_path, name: str) -> ChatStore:
    base = Store(tmp_path / name)
    base.initialize()
    MaterialStore(base).initialize()
    store = ChatStore(base)
    store.initialize()
    return store


def add_misconception(store: ChatStore, subject_id: str | None, message_id: str) -> str:
    change = store.record_observation(
        STUDENT, kind="misconception", topic="栈溢出判断", topic_key=None,
        summary="把越界写成溢出", quote="我总把越界写成溢出", reason="用户自述",
        signal="supports", related_id=None, conversation_id="conv-source",
        message_id=message_id, subject_id=subject_id,
    )
    assert change is not None
    return change.memory.id


def test_general_chat_recall_excludes_space_memories(tmp_path):
    store = make_store(tmp_path, "general.sqlite3")
    left = store.create_subject(STUDENT, "通信原理", "", "")
    right = store.create_subject(STUDENT, "操作系统", "", "")
    left_id = add_misconception(store, left.id, "msg-left")
    right_id = add_misconception(store, right.id, "msg-right")
    general_id = add_misconception(store, None, "msg-general")

    result = store.relevant_memories(STUDENT, "栈溢出判断", None, None)
    ids = {memory.id for memory, _ in result}

    assert general_id in ids
    assert left_id not in ids and right_id not in ids
    assert all(not scope.startswith("other:") for _, scope in result)


def test_subject_chat_recall_excludes_other_subjects(tmp_path):
    store = make_store(tmp_path, "subject.sqlite3")
    left = store.create_subject(STUDENT, "通信原理", "", "")
    right = store.create_subject(STUDENT, "操作系统", "", "")
    left_id = add_misconception(store, left.id, "msg-left")
    right_id = add_misconception(store, right.id, "msg-right")
    general_id = add_misconception(store, None, "msg-general")

    result = store.relevant_memories(STUDENT, "栈溢出判断", None, left.id)
    ids = {memory.id for memory, _ in result}

    assert left_id in ids and general_id in ids
    assert right_id not in ids
    assert all(not scope.startswith("other:") for _, scope in result)


def test_cross_space_recall_is_opt_in(tmp_path):
    store = make_store(tmp_path, "optin.sqlite3")
    left = store.create_subject(STUDENT, "通信原理", "", "")
    right = store.create_subject(STUDENT, "操作系统", "", "")
    left_id = add_misconception(store, left.id, "msg-left")
    right_id = add_misconception(store, right.id, "msg-right")

    result = store.relevant_memories(STUDENT, "栈溢出判断 越界", None, left.id,
                                     include_other_spaces=True)
    ids = {memory.id for memory, _ in result}
    scopes = {scope for _, scope in result}

    assert left_id in ids and right_id in ids
    assert f"other:{right.name}" in scopes


class ReviewChat(FakeChat):
    """Only answers the post-turn review; analysis returns an empty payload."""

    def __init__(self):
        super().__init__(["好。"])
        self.reviewed = 0

    async def complete_json(self, messages):
        if "复盘" in messages[0]["content"]:
            self.reviewed += 1
            return {"ops": [{"action": "add", "target": "memory",
                             "content": "资料在 notes 目录", "old_text": ""}]}
        return {}


def run_one_turn_and_review(tmp_path, name: str, *, with_subject: bool = False):
    async def scenario():
        base = Store(tmp_path / name)
        base.initialize()
        MaterialStore(base).initialize()
        chat = ChatStore(base)
        chat.initialize()
        subject = chat.create_subject(STUDENT, "学习", "", "") if with_subject else None
        model = ReviewChat()
        service = ChatService(chat, lambda: model)
        conversation = chat.create_conversation(
            STUDENT, title=None, problem=None, client_request_id=f"conv-{name}",
            subject_id=subject.id if subject else None,
        )
        user_id = chat.add_user_message(conversation, "资料在 notes 目录",
                                        f"req-{name}")
        async for _ in service.events(service.begin(STUDENT, conversation, user_id, [])):
            pass
        # Periodic review runs after an idle delay; trigger it directly instead of waiting.
        service._start_review(STUDENT, conversation, model)
        if service.reviews:
            await asyncio.gather(*list(service.reviews))
        return chat, model

    return asyncio.run(scenario())


def test_review_skips_general_notes_for_subject_conversation(tmp_path, caplog):
    caplog.set_level(logging.INFO)

    chat, model = run_one_turn_and_review(tmp_path, "subject-review.sqlite3",
                                          with_subject=True)

    assert model.reviewed == 0
    assert chat.agent_notes(STUDENT)["memory"] == ""
    assert "belongs to Subject" in caplog.text


def test_review_still_writes_general_notes_for_general_conversation(tmp_path):
    chat, model = run_one_turn_and_review(tmp_path, "general-review.sqlite3")

    assert model.reviewed == 1
    assert "资料在 notes 目录" in chat.agent_notes(STUDENT)["memory"]
"""学习空间的模型设置：主线模型就是主线对话的 model_key；支线默认模型是空间级设置。

支线实际用的模型：自己选过的 > 空间的支线模型 > 主线的模型 > 全局默认（None）。
"""

from fastapi.testclient import TestClient

from app.chat.store import ChatStore
from app.main import create_app
from app.memory.store import Store
from app.services.materials import MaterialStore
from tests.test_acceptance_support import isolated_settings
from tests.test_chat import FakeChat
from tests.test_subjects import new_subject

STUDENT = "demo-student-001"


def setup(tmp_path):
    base = Store(tmp_path / "space-models.sqlite3")
    base.initialize()
    MaterialStore(base).initialize()
    store = ChatStore(base)
    store.initialize()
    sid = store.create_subject(STUDENT, "数据结构", "", "").id
    main = store.subject(sid, STUDENT).main_conversation_id
    return store, sid, main


def test_thread_model_falls_back_from_own_to_space_to_main(tmp_path):
    store, sid, main = setup(tmp_path)
    thread = store.create_thread(STUDENT, sid, title="栈", anchor_message_id=None, client_request_id="t-1")
    assert store.conversation_model_key(thread) is None

    assert store.set_conversation_model(main, STUDENT, "p:sonnet")
    assert store.conversation_model_key(thread) == "p:sonnet", "没有空间支线模型时跟随主线"

    # 空支线会被复用：先把第一条标成已解决，后面才会新开一条
    with store.connection() as db:
        db.execute("UPDATE conversations SET thread_status = 'resolved' WHERE id = ?", (thread,))

    store.update_subject(sid, STUDENT, {"thread_model_key": "p:opus"})
    assert store.conversation_model_key(thread) == "p:opus"
    assert store.conversation_model_key(main) == "p:sonnet", "支线模型不影响主线"
    later = store.create_thread(STUDENT, sid, title="队列", anchor_message_id=None, client_request_id="t-2")
    assert later != thread
    assert store.conversation_model_key(later) == "p:opus", "新开的支线也用空间的支线模型"

    assert store.set_conversation_model(thread, STUDENT, "p:haiku")
    assert store.conversation_model_key(thread) == "p:haiku", "单独选过的支线以自己的为准"

    subject = store.subject(sid, STUDENT)
    assert subject.main_model_key == "p:sonnet" and subject.thread_model_key == "p:opus"

    store.update_subject(sid, STUDENT, {"thread_model_key": None})
    assert store.subject(sid, STUDENT).thread_model_key is None
    assert store.conversation_model_key(later) == "p:sonnet"


def test_space_thread_model_api_round_trip(tmp_path):
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=FakeChat())) as client:
        ds = new_subject(client, "操作系统")
        assert ds["main_model_key"] is None and ds["thread_model_key"] is None
        blank = client.patch(f"/api/subjects/{ds['id']}", json={"thread_model_key": "   "}).json()
        assert blank["thread_model_key"] is None, "空白等于跟随主线"
        cleared = client.patch(f"/api/subjects/{ds['id']}", json={"thread_model_key": None}).json()
        assert cleared["thread_model_key"] is None


def test_unknown_thread_model_is_rejected_when_a_model_library_exists(tmp_path):
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=FakeChat())) as client:
        ds = new_subject(client, "操作系统")
        service = client.app.state.chat_service

        class Library:
            def effective_key(self, key):
                return "p:default" if key != "p:opus" else key

        service.model_library = Library()
        assert client.patch(f"/api/subjects/{ds['id']}", json={"thread_model_key": "nope:missing"}).status_code == 404
        ok = client.patch(f"/api/subjects/{ds['id']}", json={"thread_model_key": "p:opus"}).json()
        assert ok["thread_model_key"] == "p:opus"

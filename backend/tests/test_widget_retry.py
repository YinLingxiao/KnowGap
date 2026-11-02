"""A reply that says widgets are impossible is rewritten once, and the stored reply replaces the shown one."""

from fastapi.testclient import TestClient

from app.chat.skills import WIDGET_RETRY_NOTICE
from app.main import create_app
from tests.test_acceptance_support import isolated_settings
from tests.test_chat import parse

REFUSAL = "抱歉，聊天窗口里我嵌不了可以点的控件，你可以把下面代码存成 tree.html 再用浏览器打开。"
FIXED = "来，点按钮看遍历：\n```knowgap-visual\n<svg viewBox=\"0 0 10 10\"></svg>\n```\n"


class RefusingChat:
    def __init__(self, second=FIXED):
        self.second, self.calls = second, []

    async def stream(self, messages, tools=None):
        self.calls.append(messages)
        yield "text", REFUSAL if len(self.calls) == 1 else self.second
        yield "finish", "stop"

    async def complete_json(self, messages):
        return {}


def ask(tmp_path, model, text):
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=model)) as client:
        conversation = client.post("/api/conversations", json={}).json()["id"]
        response = client.post(f"/api/conversations/{conversation}/messages",
                               json={"content": text, "client_request_id": "req-widget-0001"})
        assert response.status_code == 200, response.text
        events = parse(response.text)
        stored = client.get(f"/api/conversations/{conversation}").json()["messages"][-1]
    return events, stored


def test_refusal_is_retried_once_and_replaced(tmp_path):
    model = RefusingChat()
    events, stored = ask(tmp_path, model, "给我一个可以点的二叉树遍历演示")
    assert len(model.calls) == 2
    retry = model.calls[1]
    assert retry[-2] == {"role": "assistant", "content": REFUSAL}
    assert retry[-1]["content"] == WIDGET_RETRY_NOTICE
    assert stored["content"] == FIXED and "嵌不了" not in stored["content"]
    assert next(data for name, data in events if name == "done")["message"]["content"] == FIXED


def test_still_refusing_after_retry_keeps_the_first_reply(tmp_path):
    model = RefusingChat(second=REFUSAL)
    _, stored = ask(tmp_path, model, "给我一个可以点的二叉树遍历演示")
    assert len(model.calls) == 2 and stored["content"] == REFUSAL


def test_clean_reply_is_not_retried(tmp_path):
    class Clean(RefusingChat):
        async def stream(self, messages, tools=None):
            self.calls.append(messages)
            yield "text", FIXED
            yield "finish", "stop"

    model = Clean()
    _, stored = ask(tmp_path, model, "给我一个可以点的二叉树遍历演示")
    assert len(model.calls) == 1 and stored["content"] == FIXED

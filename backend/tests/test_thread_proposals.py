"""Suggestions must be persisted, scoped and idempotently confirmed, never client-authored tasks."""
import json

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from tests.test_acceptance_support import isolated_settings
from tests.test_chat import FakeChat, context_of, send
from tests.test_thread_coordination import settle


class ProposalModel(FakeChat):
    async def stream(self, messages, tools=None):
        role = context_of(messages)["conversation_role"]["role"]
        if role == "main" and messages[-1]["role"] != "tool":
            assert "propose_threads" in {t["function"]["name"] for t in tools}
            yield "tool_calls", [{"id": "suggest", "name": "propose_threads", "arguments": json.dumps({
                "proposals": [{"title": "基础", "task": "讲解基础语法", "reason": "先建立共同概念"}],
            })}]
        else:
            yield "text", "请选择开始。" if role == "main" else "先看一个简单的例子。"
        yield "finish", "stop"


def test_proposal_roundtrip_confirmation_and_scope(tmp_path):
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=ProposalModel())) as client:
        space = client.post("/api/subjects", json={"name": "语言"}).json()
        main = space["main_conversation_id"]
        send(client, main, "怎么学", "proposal-source-01")
        conversation = client.get(f"/api/conversations/{main}").json()
        original = conversation["messages"][0]["id"]
        reply = conversation["messages"][-1]
        proposal = reply["thread_proposals"][0]
        assert proposal["id"] and proposal["thread_id"] is None
        assert client.get(f"/api/subjects/{space['id']}/threads").json() == []
        body = {"message_id": reply["id"], "proposal_id": proposal["id"]}
        url = f"/api/conversations/{main}/confirm-proposal"
        assert client.post(url, json={**body, "task": "篡改"}).status_code == 422
        other = client.post("/api/subjects", json={"name": "数学"}).json()["main_conversation_id"]
        assert client.post(f"/api/conversations/{other}/confirm-proposal", json=body).status_code == 404
        assert client.post(url, json={**body, "proposal_id": "missing"}).status_code == 404
        # An old card stays tied to its original input, not a later conversation turn.
        send(client, main, "再问个别的问题", "proposal-source-02")
        confirmed = client.post(url, json=body)
        assert confirmed.status_code == 200, confirmed.text
        thread_id = confirmed.json()["thread_id"]
        assert client.post(url, json=body).json()["thread_id"] == thread_id
        client.portal.call(settle, client.app.state.chat_service)
        thread = client.get(f"/api/conversations/{thread_id}").json()
        assert thread["anchor"]["message_id"] == original
        assert thread["messages"][0]["content"] == "怎么学"
        assert thread["messages"][-1]["status"] == "complete"
        refreshed = client.get(f"/api/conversations/{main}").json()
        old_reply = next(m for m in refreshed["messages"] if m["id"] == reply["id"])
        assert old_reply["thread_proposals"][0]["thread_id"] == thread_id
        assert len(client.get(f"/api/subjects/{space['id']}/threads").json()) == 1


@pytest.mark.parametrize("payload", [
    {"proposals": []}, {"proposals": [{"title": "x", "task": "y"}]},
    {"proposals": [{"title": "x" * 61, "task": "y", "reason": "z"}]},
])
def test_proposal_parameters_are_validated(payload):
    from app.chat.schemas import ProposeThreads
    with pytest.raises(ValueError):
        ProposeThreads(**payload)

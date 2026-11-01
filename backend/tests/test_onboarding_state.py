import json

from fastapi.testclient import TestClient
from app.main import create_app
from app.models.schemas import DEMO_STUDENT
from app.chat.skills import select_skill_prompt, ONBOARDING_TITLE
from tests.test_acceptance_support import isolated_settings
from tests.test_chat import FakeChat


def seed_interview(client, draft, turns=3, version=3):
    """An interview left in progress by an earlier version; nothing here can start a new one."""
    with client.app.state.store.connection() as db:
        db.execute("""INSERT INTO onboarding_sessions(student_id, status, draft, turns, version)
            VALUES (?, 'in_progress', ?, ?, ?) ON CONFLICT(student_id) DO UPDATE SET
            status='in_progress', draft=excluded.draft, turns=excluded.turns, version=excluded.version""",
                   (DEMO_STUDENT, json.dumps(draft, ensure_ascii=False), turns, version))


def answer(field, value, quote=None, declined=False):
    return {"value": value, "quote": quote or value, "message_id": f"seed-{field}", "declined": declined}


def test_complete_requires_review_and_title_does_not_select_skill(tmp_path):
    assert select_skill_prompt('chat', '你好', conversation_title=ONBOARDING_TITLE) is None
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=FakeChat())) as client:
        assert client.post('/api/onboarding/complete', json={'version': 0, 'entries': {}}).status_code == 409
        client.put('/api/agent-memory', json={'target': 'user', 'content': '已有画像'})
        assert client.get('/api/onboarding').json()['status'] == 'not_started'


def test_confirmation_preserves_notes_and_skips_declined_fields(tmp_path):
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=FakeChat())) as client:
        client.put('/api/agent-memory', json={'target': 'user', 'content': '已有背景'})
        seed_interview(client, {
            'background': answer('background', '学历史', '我学历史'),
            'explanation': answer('explanation', '喜欢实例', '喜欢实例'),
            'interaction': answer('interaction', '', '暂时不确定', declined=True),
        })
        state = client.get('/api/onboarding').json()
        assert state['ready'] and state['status'] == 'in_progress'
        assert client.get('/api/agent-memory').json()['user'] == '已有背景'
        stale = {'version': state['version'] - 1, 'entries': {}}
        assert client.post('/api/onboarding/complete', json=stale).status_code == 409
        body = {'version': state['version'], 'entries': {'background': '历史自学者', 'explanation': '先举例'}}
        assert client.post('/api/onboarding/complete', json=body).status_code == 200
        saved = client.get('/api/agent-memory').json()['user']
        assert '已有背景' in saved and '历史自学者' in saved and '互动偏好' not in saved
        assert client.get('/api/onboarding').json()['onboarded'] is True
        assert client.post('/api/onboarding/complete', json=body).status_code == 200
        assert client.get('/api/agent-memory').json()['user'] == saved


def test_invalid_profile_save_is_atomic_and_not_completed(tmp_path):
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=FakeChat())) as client:
        seed_interview(client, {key: answer(key, '暂不设置', '不确定', declined=True)
                                for key in ('background', 'explanation', 'interaction')})
        version = client.get('/api/onboarding').json()['version']
        response = client.post('/api/onboarding/complete', json={'version': version, 'entries': {'background': 'api_key=secret'}})
        assert response.status_code == 409
        assert client.get('/api/onboarding').json()['status'] == 'in_progress'
        assert client.get('/api/agent-memory').json()['user'] == ''


def test_user_profile_authority_and_transient_request():
    from app.chat.agent import chat_messages, learning_context, validate_analysis
    messages = chat_messages([], [], None, [], snapshot='USER（本轮开始时的快照）：\n讲解偏好：先举例\n\nMEMORY（本轮开始时的快照）：\n（空）')
    context = learning_context(messages)
    assert context['teaching_preferences'][0]['source'] == 'USER'
    result = validate_analysis({'observations': [{'kind': 'preference', 'topic': '解析',
        'summary': '直接给答案', 'evidence': '这次直接给答案', 'reason': '用户要求'}]}, '这次直接给答案', None, [])
    assert not result['observations']

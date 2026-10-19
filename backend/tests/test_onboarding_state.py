import json

from fastapi.testclient import TestClient
from app.main import create_app
from app.chat.skills import select_skill_prompt, ONBOARDING_TITLE
from tests.test_acceptance_support import isolated_settings
from tests.test_chat import FakeChat, send


class Interview(FakeChat):
    def __init__(self, result=None):
        super().__init__()
        self.result = result

    async def complete_json(self, messages):
        payload = json.loads(messages[-1]['content'])
        if self.result is not None:
            return self.result
        return {'answers': [{'field': payload['stage'], 'value': payload['answer'],
                             'quote': payload['answer'], 'declined': False}]}


def test_skip_resume_and_refresh_preserve_draft(tmp_path):
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=Interview())) as client:
        cid = client.post('/api/onboarding/start').json()['id']
        send(client, cid, '我想学习历史', 'interview-first-answer')
        before = client.get('/api/onboarding').json()
        assert before['stage'] == 'explanation'
        assert not before['onboarded']
        assert client.post('/api/onboarding/skip').json()['status'] == 'skipped'
        assert client.get('/api/agent-memory').json()['user'] == ''
        assert client.post('/api/onboarding/start').json()['id'] == cid
        after = client.get('/api/onboarding').json()
        assert after['draft'] == before['draft']
        assert after['stage'] == 'explanation'
        assert after['status'] == 'in_progress'


def test_question_and_false_quote_do_not_advance(tmp_path):
    model = Interview({'answers': [{'field': 'background', 'value': '数学', 'quote': '不存在的原话'}]})
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=model)) as client:
        cid = client.post('/api/onboarding/start').json()['id']
        send(client, cid, '你会保存什么？', 'interview-question')
        state = client.get('/api/onboarding').json()
        assert state['stage'] == 'background' and state['draft'] == {}


def test_complete_requires_review_and_title_does_not_select_skill(tmp_path):
    assert select_skill_prompt('chat', '你好', conversation_title=ONBOARDING_TITLE) is None
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=Interview())) as client:
        assert client.post('/api/onboarding/complete', json={'version': 0, 'entries': {}}).status_code == 409
        client.put('/api/agent-memory', json={'target': 'user', 'content': '已有画像'})
        assert client.get('/api/onboarding').json()['status'] == 'not_started'


def test_multiple_fields_decline_and_confirmation_preserves_notes(tmp_path):
    text = '我学历史，喜欢实例，互动方式暂时不确定'
    model = Interview({'answers': [
        {'field': 'background', 'value': '学历史', 'quote': '我学历史'},
        {'field': 'explanation', 'value': '喜欢实例', 'quote': '喜欢实例'},
        {'field': 'interaction', 'value': '', 'quote': '暂时不确定', 'declined': True},
    ]})
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=model)) as client:
        client.put('/api/agent-memory', json={'target': 'user', 'content': '已有背景'})
        cid = client.post('/api/onboarding/start').json()['id']
        # Renaming has no effect on interview identity.
        client.patch(f'/api/conversations/{cid}', json={'title': '改名后'})
        send(client, cid, text, 'interview-combined-answer')
        state = client.get('/api/onboarding').json()
        assert state['ready']
        assert client.get('/api/agent-memory').json()['user'] == '已有背景'
        body = {'version': state['version'], 'entries': {'background': '历史自学者', 'explanation': '先举例'}}
        assert client.post('/api/onboarding/complete', json=body).status_code == 200
        saved = client.get('/api/agent-memory').json()['user']
        assert '已有背景' in saved and '历史自学者' in saved and '互动偏好' not in saved
        assert client.post('/api/onboarding/complete', json=body).status_code == 200
        assert client.get('/api/agent-memory').json()['user'] == saved


def test_interview_never_streams_or_executes_tools(tmp_path):
    class NoTools(Interview):
        async def stream(self, messages, tools=None):
            raise AssertionError('Interview must not execute the ordinary agent tool loop')
            yield
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=NoTools())) as client:
        client.put('/api/agent/settings', json={'memory_write_approval': True})
        cid = client.post('/api/onboarding/start').json()['id']
        send(client, cid, '我学数学', 'interview-no-tools')
        assert client.get('/api/agent-memory').json()['user'] == ''


def test_failure_does_not_advance_and_retry_counts_once(tmp_path):
    from app.agents.llm import ProviderError
    class Failing(Interview):
        fail = True
        async def complete_json(self, messages):
            if self.fail:
                raise ProviderError(502, '模拟失败')
            return await super().complete_json(messages)
    model = Failing()
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=model)) as client:
        cid = client.post('/api/onboarding/start').json()['id']
        send(client, cid, '我学数学', 'interview-retry-id')
        assert client.get('/api/onboarding').json()['version'] == 0
        model.fail = False
        send(client, cid, '我学数学', 'interview-retry-id')
        before = client.get('/api/onboarding').json()
        send(client, cid, '我学数学', 'interview-retry-id')
        assert client.get('/api/onboarding').json() == before


def test_invalid_profile_save_is_atomic_and_not_completed(tmp_path):
    model = Interview({'answers': [
        {'field': key, 'value': '暂不设置', 'quote': '不确定', 'declined': True}
        for key in ('background', 'explanation', 'interaction')]})
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=model)) as client:
        cid = client.post('/api/onboarding/start').json()['id']
        send(client, cid, '不确定', 'interview-save-failure')
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

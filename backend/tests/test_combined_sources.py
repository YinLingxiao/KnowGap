"""Regression for branches that independently added course and web citations."""
import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.models.schemas import TutorOutput, WebSearchResponse, WebSource


class CombinedSearch:
    async def search(self, query, limit=5):
        return WebSearchResponse(query=query, results=[WebSource(
            id='web-combined', label='网页1', title='Stack reference',
            url='https://docs.example/stack', snippet='LIFO, access only the top.')])


class CombinedTutor:
    def __init__(self, invalid=None):
        self.invalid = invalid

    async def generate(self, context):
        course_id = context['course_sources'][0]['id']
        web_id = context['web_sources'][0]['id']
        return TutorOutput(
            assessment='incorrect', issue='未检查栈顶', confidence=.8,
            evidence=context['current_answer'], reply='请检查栈顶。[资料1][网页1]',
            citation_ids=[web_id if self.invalid == 'course' else course_id],
            web_source_ids=[course_id if self.invalid == 'web' else web_id])


def settings(tmp_path):
    return Settings(_env_file=None, database_path=tmp_path/'combined.sqlite3',
                    llm_api_key='', llm_base_url='', llm_model='')


def upload(client):
    result = client.post('/api/materials', files={
        'file': ('stack.md', '栈遵循后进先出 LIFO，只能弹出栈顶。'.encode(), 'text/plain')})
    assert result.status_code == 201


def test_both_sources_persist_across_followup_and_restart(tmp_path):
    config = settings(tmp_path)
    with TestClient(create_app(config, CombinedTutor(), CombinedSearch())) as client:
        upload(client)
        initial = client.post('/api/diagnosis', json={
            'problem_id': 'stack-sequence-001', 'answer': '合法', 'web_search': True})
        assert initial.status_code == 200
        data = initial.json()
        session_id = data['session_id']
        assert len(data['sources']) == len(data['web_sources']) == 1
        followup = client.post(f'/api/sessions/{session_id}/messages', json={
            'content': '仍然合法', 'web_search': True})
        assert followup.status_code == 200
    with TestClient(create_app(config, CombinedTutor(), CombinedSearch())) as client:
        messages = client.get(f'/api/sessions/{session_id}').json()['messages']
        for message in (messages[1], messages[3]):
            assert message['sources'] == data['sources']
            assert message['web_sources'] == data['web_sources']


@pytest.mark.parametrize('invalid', ['course', 'web'])
def test_source_ids_cannot_cross_libraries_or_write_failed_turn(tmp_path, invalid):
    with TestClient(create_app(settings(tmp_path), CombinedTutor(invalid), CombinedSearch())) as client:
        upload(client)
        response = client.post('/api/diagnosis', json={
            'problem_id': 'stack-sequence-001', 'answer': '合法', 'web_search': True})
        assert response.status_code == 502
        assert client.get('/api/memories').json() == []
        with client.app.state.store.connection() as db:
            assert db.execute('SELECT COUNT(*) FROM learning_sessions').fetchone()[0] == 0

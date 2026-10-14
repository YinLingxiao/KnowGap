import asyncio

import httpx
import pytest
from fastapi.testclient import TestClient

from app.agents.llm import ProviderError
from app.config import Settings
from app.main import create_app
from app.models.schemas import TutorOutput, WebSearchResponse, WebSource
from app.services.anysearch import AnySearchClient


def config(tmp_path, key=''):
    return Settings(_env_file=None, database_path=tmp_path / 'anysearch.sqlite3',
                    llm_api_key='', llm_base_url='', llm_model='', anysearch_api_key=key)


@pytest.mark.parametrize('key', ['', 'synthetic-search-key'])
def test_rest_wire_auth_sanitization_dedup(tmp_path, key):
    def handle(request):
        assert str(request.url) == 'https://api.anysearch.com/v1/search'
        assert request.method == 'POST'
        import json
        assert json.loads(request.content)['max_results'] == 5
        assert request.headers.get('authorization') == ('Bearer ' + key if key else None)
        return httpx.Response(200, json={'code': 0, 'data': {'results': [
            {'title': 'Stack', 'url': 'https://docs.example/stack', 'snippet': 'LIFO'},
            {'title': 'Duplicate', 'url': 'https://docs.example/stack'},
            {'title': 'Bad URL', 'url': 'javascript:alert(1)'},
            {'title': '', 'url': 'https://reference.example/stack', 'content': 'last in first out'},
        ]}, 'request_id': '02fa0337-0629-402c-a87b-1b1bfc4d4e01'})
    result = asyncio.run(AnySearchClient(config(tmp_path, key), httpx.MockTransport(handle)).search('stack'))
    assert len(result.results) == 2 and result.results[1].title == 'reference.example'
    assert result.results[0].label == '网页1' and result.results[1].snippet == 'last in first out'


@pytest.mark.parametrize('status,expected', [(401, 503), (402, 503), (403, 503), (429, 503), (500, 502)])
def test_provider_error_never_exposes_credentials(tmp_path, status, expected):
    transport = httpx.MockTransport(lambda _: httpx.Response(status, json={'message': 'password=private api_key=synthetic-search-key'}))
    with pytest.raises(ProviderError) as error:
        asyncio.run(AnySearchClient(config(tmp_path), transport).search('stack'))
    assert error.value.status_code == expected
    assert 'private' not in error.value.detail and 'synthetic-search-key' not in error.value.detail


@pytest.mark.parametrize('body', [{'code': -1, 'message': 'private'}, {'code': 0, 'data': {'results': None}}, {'code': 0, 'data': {'results': [{'url': 'https://example.com', 'snippet': 9}]}}])
def test_bad_success_envelope(tmp_path, body):
    transport = httpx.MockTransport(lambda _: httpx.Response(200, json=body))
    with pytest.raises(ProviderError) as error:
        asyncio.run(AnySearchClient(config(tmp_path), transport).search('stack'))
    assert error.value.status_code == 502


def test_timeout(tmp_path):
    def timeout(request): raise httpx.ReadTimeout('private')
    with pytest.raises(ProviderError) as error:
        asyncio.run(AnySearchClient(config(tmp_path), httpx.MockTransport(timeout)).search('stack'))
    assert error.value.status_code == 504


class SearchStub:
    def __init__(self): self.calls = []
    async def search(self, query, limit=5):
        self.calls.append(query)
        return WebSearchResponse(query=query, results=[WebSource(id='web-test', label='网页1',
            title='Stack reference', url='https://docs.example/stack', snippet='Only the top element can be removed. LIFO.')])


class TutorStub:
    def __init__(self, invented=False): self.contexts = []; self.invented = invented
    async def generate(self, context):
        self.contexts.append(context); sources = context['web_sources']
        return TutorOutput(assessment='incorrect', issue='未检查栈顶', confidence=.8, evidence=context['current_answer'],
            reply='请检查栈顶。' + ('[网页1]' if sources else ''),
            web_source_ids=['invented'] if self.invented else [sources[0]['id']] if sources else [])


def test_search_endpoint_and_opt_in_teaching_sources_restart(tmp_path):
    settings=config(tmp_path); search=SearchStub(); tutor=TutorStub()
    with TestClient(create_app(settings, tutor, search)) as client:
        manual=client.get('/api/search',params={'q':'LIFO'}).json()
        assert manual['provider']=='anysearch' and len(manual['results'])==1
        assert client.get('/api/search',params={'q':' '}).status_code==422
        assert client.get('/api/search',params={'q':'a','limit':11}).status_code==422
        search.calls.clear()
        offline=client.post('/api/diagnosis',json={'problem_id':'stack-sequence-001','answer':'合法'}).json()
        assert search.calls==[] and offline['web_sources']==[]
        live=client.post('/api/diagnosis',json={'problem_id':'stack-sequence-001','answer':'合法','web_search':True}).json()
        assert len(search.calls)==1 and live['web_sources'][0]['url']=='https://docs.example/stack'
        assert tutor.contexts[-1]['reference']['possible'] is False
        assert tutor.contexts[-1]['web_sources'][0]['snippet'].startswith('Only the top')
        session_id=live['session_id']
        message=client.post(f'/api/sessions/{session_id}/messages',json={'content':'仍然合法','web_search':True})
        assert message.status_code==200 and len(search.calls)==2
    with TestClient(create_app(settings,tutor,search)) as client:
        saved=client.get('/api/sessions/'+session_id).json()
        assert saved['messages'][1]['web_sources']==live['web_sources']
        assert saved['messages'][3]['web_sources'][0]['id']=='web-test'


def test_invented_web_citation_does_not_write(tmp_path):
    with TestClient(create_app(config(tmp_path),TutorStub(invented=True),SearchStub())) as client:
        response=client.post('/api/diagnosis',json={'problem_id':'stack-sequence-001','answer':'合法','web_search':True})
        assert response.status_code==502 and client.get('/api/memories').json()==[]


def test_search_failure_does_not_generate_or_save(tmp_path):
    class FailureSearch:
        async def search(self,query,limit=5): raise ProviderError(503,'AnySearch 额度不足')
    tutor=TutorStub()
    with TestClient(create_app(config(tmp_path),tutor,FailureSearch())) as client:
        response=client.post('/api/diagnosis',json={'problem_id':'stack-sequence-001','answer':'合法','web_search':True})
        assert response.status_code==503 and tutor.contexts==[]
        assert client.get('/api/memories').json()==[]

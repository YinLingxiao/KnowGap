import asyncio

import httpx
import pytest

from app.agents.llm import ProviderError
from app.config import Settings
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

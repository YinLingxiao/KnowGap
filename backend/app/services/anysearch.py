"""AnySearch REST adapter; provider messages may contain credentials, never forward them."""
import hashlib
from typing import Callable, Protocol
from urllib.parse import urlsplit
from uuid import UUID

import httpx

from app.agents.llm import ProviderError
from app.config import Settings
from app.models.schemas import WebSearchResponse, WebSource


class SearchService(Protocol):
    async def search(self, query: str, limit: int = 5) -> WebSearchResponse: ...


class AnySearchClient:
    def __init__(self, settings: Settings, transport: httpx.AsyncBaseTransport | None = None,
                 key_source: Callable[[], str] | None = None):
        self.settings = settings
        self.transport = transport
        self.key_source = key_source

    async def search(self, query: str, limit: int = 5) -> WebSearchResponse:
        headers = {'Accept': 'application/json'}
        # 设置页里保存的密钥优先，其次才是环境变量 / .env。
        key = ((self.key_source() if self.key_source else '') or self.settings.anysearch_api_key.get_secret_value()).strip()
        if key:
            headers['Authorization'] = 'Bearer ' + key
        try:
            async with httpx.AsyncClient(timeout=self.settings.anysearch_timeout_seconds, transport=self.transport) as client:
                response = await client.post('https://api.anysearch.com/v1/search',
                    json={'query': query, 'max_results': limit, 'language': 'zh-CN', 'format': 'json'}, headers=headers)
        except httpx.TimeoutException:
            raise ProviderError(504, 'AnySearch 搜索超时，请稍后重试。') from None
        except (httpx.RequestError, ImportError, UnicodeEncodeError):
            raise ProviderError(503, '暂时无法连接 AnySearch，请检查搜索配置后重试。') from None
        if response.status_code in {401, 403}:
            raise ProviderError(503, 'AnySearch 密钥或权限无效，请检查搜索服务配置。')
        if response.status_code == 402:
            raise ProviderError(503, 'AnySearch 搜索额度不足，请配置有效的搜索密钥后重试。')
        if response.status_code == 429:
            raise ProviderError(503, 'AnySearch 暂时限流，请稍后重试。')
        if not response.is_success:
            raise ProviderError(502, 'AnySearch 服务返回异常，请稍后重试。')
        try:
            body = response.json()
            if not isinstance(body, dict) or body.get('code') != 0:
                raise ValueError()
            rows = body['data']['results']
            if not isinstance(rows, list):
                raise ValueError()
            results, seen = [], set()
            for row in rows:
                if not isinstance(row, dict):
                    raise ValueError()
                url = row.get('url')
                if not isinstance(url, str) or len(url) > 4096:
                    continue
                try:
                    parsed = urlsplit(url)
                    valid = parsed.scheme in {'http', 'https'} and bool(parsed.hostname) and not parsed.username and not parsed.password
                    _ = parsed.port
                except ValueError:
                    valid = False
                if not valid or url in seen:
                    continue
                title, snippet = row.get('title', ''), row.get('snippet') or row.get('content') or ''
                if not isinstance(title, str) or not isinstance(snippet, str):
                    raise ValueError()
                seen.add(url)
                results.append(WebSource(id='web-' + hashlib.sha256(url.encode()).hexdigest()[:16],
                    label=f'网页{len(results) + 1}', title=title.strip()[:200] or parsed.hostname,
                    url=url, snippet=snippet[:1800]))
                if len(results) >= limit:
                    break
            request_id = None
            try:
                request_id = str(UUID(body.get('request_id', '')))
            except (ValueError, TypeError, AttributeError):
                pass
        except (ValueError, TypeError, KeyError):
            raise ProviderError(502, 'AnySearch 返回的数据格式异常，请稍后重试。') from None
        return WebSearchResponse(query=query, results=results, request_id=request_id)

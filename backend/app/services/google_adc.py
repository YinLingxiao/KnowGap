"""Read local ADC and refresh in memory, off the event loop; never store/return tokens."""

import asyncio
from functools import lru_cache
from threading import Lock

from app.agents.llm import ProviderError


class _ADCSession:
    def __init__(self):
        self.lock = Lock()
        self.credentials = None
        self.request = None

    def headers(self, project: str, url: str) -> dict:
        # Multiple Threads can share ADC. Only one refresh/discovery per project at a time.
        with self.lock:
            try:
                import google.auth
                from google.auth.transport.requests import Request
                if self.credentials is None:
                    self.credentials, _ = google.auth.default(
                        scopes=["https://www.googleapis.com/auth/cloud-platform"], quota_project_id=project,
                    )
                    self.request = Request()

                def request(*args, **kwargs):
                    kwargs.setdefault("timeout", 20)
                    return self.request(*args, **kwargs)

                headers = {}
                self.credentials.before_request(request, "POST", url, headers)
                if not headers.get("authorization"):
                    raise ValueError("Missing access token")
                return headers
            except ImportError:
                raise ProviderError(503, "ADC 认证依赖未安装，请更新后端 requirements.txt 并重启。") from None
            except Exception:
                # Auth errors can contain tokens, private paths and upstream responses. Never echo them.
                self.credentials = None
                raise ProviderError(503, "无法读取或刷新 ADC 凭证。请在运行后端的同一系统账号下执行 gcloud auth application-default login；组织使用联合身份时请按管理员流程登录，并检查项目权限与配额项目。") from None


@lru_cache(maxsize=8)
def _session(project: str) -> _ADCSession:
    return _ADCSession()


async def adc_headers(project: str, url: str) -> dict:
    return await asyncio.to_thread(_session(project).headers, project, url)

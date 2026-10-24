"""联网搜索（AnySearch）密钥：只存在后端数据目录，接口永不回传。"""

import json
import os
import tempfile
from pathlib import Path
from threading import RLock

from fastapi import HTTPException

from app.config import Settings

MAX_KEY_LENGTH = 512
_active: "SearchSettings | None" = None


def clean_key(value) -> str:
    """去掉首尾空白并校验；空串表示清除。无效时抛 422，不在错误里带出密钥。"""
    if value is None:
        return ""
    if not isinstance(value, str):
        raise HTTPException(422, "搜索密钥必须是文本。")
    key = value.strip()
    if key and (len(key) > MAX_KEY_LENGTH or not key.isascii() or any(ord(c) < 33 or ord(c) == 127 for c in key)):
        raise HTTPException(422, "搜索密钥格式无效：只能包含英文、数字和常见符号，不能有空格或换行。")
    return key


class SearchSettings:
    def __init__(self, settings: Settings, path: Path | None = None):
        global _active
        self.path = path or settings.resolved_database_path().parent / "search-settings.json"
        self.settings = settings
        self.lock = RLock()
        _active = self

    def _read(self) -> dict:
        with self.lock:
            try:
                data = json.loads(self.path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                return {}
            return data if isinstance(data, dict) else {}

    def saved_key(self) -> str:
        key = self._read().get("anysearch_api_key")
        return key.strip() if isinstance(key, str) else ""

    def key(self) -> str:
        """设置页保存的优先；没有时用环境变量 / .env（Settings）里的。"""
        return self.saved_key() or self.settings.anysearch_api_key.get_secret_value().strip()

    def status(self) -> dict:
        if self.saved_key():
            return {"has_key": True, "source": "saved"}
        if self.settings.anysearch_api_key.get_secret_value().strip():
            return {"has_key": True, "source": "environment"}
        return {"has_key": False, "source": "none"}

    def save(self, value) -> dict:
        key = clean_key(value)
        with self.lock:
            payload = self._read()
            if key:
                payload["anysearch_api_key"] = key
            else:
                payload.pop("anysearch_api_key", None)
            self._write(payload)
        return self.status()

    def _write(self, payload: dict) -> None:
        temporary = None
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            fd, temporary = tempfile.mkstemp(dir=self.path.parent, prefix=".search-settings-")
            with os.fdopen(fd, "w", encoding="utf-8") as output:
                json.dump(payload, output, ensure_ascii=False)
                output.flush()
                os.fsync(output.fileno())
            try:
                os.chmod(temporary, 0o600)
            except OSError:
                pass
            os.replace(temporary, self.path)
        except OSError:
            raise HTTPException(503, "搜索配置保存失败，请检查后端数据目录权限。") from None
        finally:
            if temporary and Path(temporary).exists():
                Path(temporary).unlink()


def saved_key() -> str:
    """供联网搜题读取：当前这个后端实例里设置页保存的密钥，没有则为空。"""
    return _active.saved_key() if _active is not None else ""

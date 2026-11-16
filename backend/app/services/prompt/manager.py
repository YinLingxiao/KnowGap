"""Locate, load and cache prompt YAML files: `app/<module>/prompts/<language>/<name>.yaml`."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

APP_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_LANGUAGE = "zh"
_MISSING = object()


class PromptError(RuntimeError):
    """A prompt file or key is missing or malformed.

    Raised instead of falling back to an empty string: a silently empty prompt would still
    produce replies, just without the rules the missing text carried.
    """


def language_chain(language: str | None) -> list[str]:
    """Languages to try, most specific first: `zh-TW` -> `zh-tw`, `zh`; anything else ends at `zh`."""
    wanted = (language or DEFAULT_LANGUAGE).strip().lower().replace("_", "-")
    return list(dict.fromkeys([wanted, wanted.split("-", 1)[0], DEFAULT_LANGUAGE]))


def _check(node: Any, where: str) -> None:
    if isinstance(node, str):
        if not node.strip():
            raise PromptError(f"提示词为空：{where}")
        return
    if isinstance(node, dict) and node:
        for key, value in node.items():
            if not isinstance(key, str):
                raise PromptError(f"提示词的键必须是字符串：{where}.{key}")
            _check(value, f"{where}.{key}")
        return
    raise PromptError(f"提示词只能是文本或非空的键值表：{where}")


def join_sections(node: Any) -> str:
    """Flatten a section to text: a mapping joins its values, in file order, with newlines."""
    if isinstance(node, str):
        return node
    return "\n".join(join_sections(value) for value in node.values())


def prompt_text(prompts: dict[str, Any], *path: str, default: Any = _MISSING) -> str:
    """Text at `path`. A mapping there is flattened in file order; a missing key raises unless `default` is given."""
    node: Any = prompts
    for index, key in enumerate(path):
        if not isinstance(node, dict) or key not in node:
            if default is not _MISSING:
                return default
            raise PromptError(f"提示词里没有这一项：{'.'.join(path[:index + 1])}")
        node = node[key]
    return join_sections(node)


class PromptManager:
    def __init__(self, root: Path = APP_ROOT) -> None:
        self.root = root
        self._cache: dict[tuple[str, str, str], dict[str, Any]] = {}

    def path_for(self, module: str, name: str, language: str) -> Path:
        return self.root.joinpath(*module.split("."), "prompts", language, f"{name}.yaml")

    def load_prompts(self, module: str, name: str, language: str = DEFAULT_LANGUAGE) -> dict[str, Any]:
        """Prompts of one agent. `module` is the package under `app` (`chat`, `agenda`, `vision`…)."""
        key = (module, name, (language or DEFAULT_LANGUAGE).lower())
        if key not in self._cache:
            self._cache[key] = self._read(module, name, language)
        return self._cache[key]

    def _read(self, module: str, name: str, language: str) -> dict[str, Any]:
        tried = []
        for candidate in language_chain(language):
            path = self.path_for(module, name, candidate)
            tried.append(str(path))
            if not path.is_file():
                continue
            try:
                data = yaml.safe_load(path.read_text(encoding="utf-8"))
            except yaml.YAMLError as exc:
                raise PromptError(f"提示词文件格式有误：{path}（{exc}）") from None
            _check(data, f"{module}/{name}")
            return data
        raise PromptError(f"找不到提示词文件，已尝试：{'、'.join(tried)}")

    def clear_cache(self) -> None:
        self._cache.clear()


_manager = PromptManager()


def get_prompt_manager() -> PromptManager:
    return _manager

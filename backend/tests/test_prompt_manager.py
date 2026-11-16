"""Prompt YAML files: loading rules, and the free-chat prompt assembled from them."""

from pathlib import Path

import pytest

from app.chat.agent import chat_messages, learning_context
from app.chat.prompts import CHAT_CONTEXT_PROMPT, CHAT_ROLE_PROMPT
from app.chat.prompts.parallel_chat import CHAT_PROMPTS
from app.chat.prompts import MAIN_ROLE_PROMPT, THREAD_ROLE_PROMPT
from app.chat.prompts.common import COMMON_CONTEXT_PROMPT, LEARNING_PROMPTS, _LEARNING_CONTEXT
from app.chat.prompts.main_coordinator import MAIN_PROMPTS
from app.chat.prompts.thread_worker import THREAD_PROMPTS
from app.services.prompt import PromptError, PromptManager, get_prompt_manager, prompt_text
from app.services.prompt.manager import APP_ROOT, language_chain

BACKEND_ROOT = APP_ROOT.parent


def write(root: Path, language: str, text: str, name: str = "tutor") -> None:
    folder = root / "chat" / "prompts" / language
    folder.mkdir(parents=True, exist_ok=True)
    (folder / f"{name}.yaml").write_text(text, encoding="utf-8")


def test_sections_join_in_file_order_and_single_items_stay_addressable(tmp_path):
    write(tmp_path, "zh", "role:\n  first: |-\n    甲\n  rules:\n    b: 乙\n    a: |-\n      - 丙\n        丁\nclosing: 戊\n")
    prompts = PromptManager(tmp_path).load_prompts("chat", "tutor")
    assert prompt_text(prompts, "role") == "甲\n乙\n- 丙\n  丁"
    assert prompt_text(prompts, "role", "rules", "a") == "- 丙\n  丁"
    assert prompt_text(prompts, "closing") == "戊"


def test_language_falls_back_to_the_base_language_then_chinese(tmp_path):
    write(tmp_path, "zh", "system: 中文")
    write(tmp_path, "en", "system: English")
    manager = PromptManager(tmp_path)
    assert language_chain("zh_TW") == ["zh-tw", "zh"]
    assert prompt_text(manager.load_prompts("chat", "tutor", "en-GB"), "system") == "English"
    assert prompt_text(manager.load_prompts("chat", "tutor", "ja"), "system") == "中文"


def test_missing_or_empty_prompts_fail_loudly_instead_of_becoming_blank(tmp_path):
    manager = PromptManager(tmp_path)
    with pytest.raises(PromptError, match="找不到提示词文件"):
        manager.load_prompts("chat", "absent")
    write(tmp_path, "zh", "system: 好\n")
    prompts = manager.load_prompts("chat", "tutor")
    with pytest.raises(PromptError, match="system.extra"):
        prompt_text(prompts, "system", "extra")
    assert prompt_text(prompts, "nothing", default="") == ""
    write(tmp_path, "zh", "system:\n  intro: '  '\n", name="blank")
    with pytest.raises(PromptError, match="提示词为空"):
        manager.load_prompts("chat", "blank")
    write(tmp_path, "zh", "system: [a, b]\n", name="listy")
    with pytest.raises(PromptError, match="只能是文本"):
        manager.load_prompts("chat", "listy")


def test_every_prompt_file_in_the_app_loads_and_ships_with_the_desktop_build():
    files = sorted(APP_ROOT.glob("*/prompts/*/*.yaml"))
    assert files, "no prompt YAML found"
    manager = PromptManager()
    for path in files:
        module, _, language, name = path.relative_to(APP_ROOT).parts
        assert manager.load_prompts(module, Path(name).stem, language)
    # PyInstaller only bundles .py by itself: without this line the packaged app starts without prompts.
    assert 'collect_data_files("app", includes=["**/*.yaml"])' in (BACKEND_ROOT / "knowgap.spec").read_text(encoding="utf-8")


def test_free_chat_prompt_is_assembled_from_named_functional_sections():
    shared = get_prompt_manager().load_prompts("chat", "shared")
    assert list(CHAT_PROMPTS) == ["role", "system"]
    assert list(CHAT_PROMPTS["role"]) == ["identity", "principles", "closing"]
    assert CHAT_ROLE_PROMPT.startswith(prompt_text(CHAT_PROMPTS, "role", "identity") + "\n回答原则：\n- ")
    assert CHAT_ROLE_PROMPT.endswith(prompt_text(CHAT_PROMPTS, "role", "closing"))
    assert CHAT_CONTEXT_PROMPT.startswith(prompt_text(CHAT_PROMPTS, "system", "intro") + "\n" + prompt_text(shared, "audience"))
    assert CHAT_CONTEXT_PROMPT.endswith(prompt_text(shared, "tools", "untrusted_input"))
    for section in (("system", "context"), ("system", "background")):
        assert prompt_text(CHAT_PROMPTS, *section) in CHAT_CONTEXT_PROMPT
    for section in ("format", "tools"):
        assert prompt_text(shared, section) in CHAT_CONTEXT_PROMPT


def test_each_context_field_rule_is_keyed_by_the_field_it_describes():
    fields = CHAT_PROMPTS["system"]["context"]["fields"]
    for key, text in fields.items():
        if key != "long_term_notes":  # the USER / MEMORY snapshot sits in the system prompt, not in the JSON context
            assert text.startswith(f"- {key}："), key
    rows = [{"role": "user", "content": "你好", "kind": "text", "status": "complete", "meta_json": "{}"}]
    sent = set(learning_context(chat_messages(rows, [], None, [], conversation_role={"role": "chat"})))
    always_sent = set(fields) - {"long_term_notes", "learning_plan"}  # the plan is only sent once one exists
    assert always_sent <= sent, always_sent - sent


def test_main_prompt_is_assembled_from_named_blocks_with_blank_lines_between_them():
    assert list(MAIN_PROMPTS) == [
        "identity", "routing", "dispatch", "own_tools", "delegated_search", "proposals", "closing", "system_events",
    ]
    assert list(MAIN_PROMPTS["routing"]) == ["heading", "direct_answer", "dispatch_task", "short_reply", "propose"]
    blocks = MAIN_ROLE_PROMPT.split("\n\n")
    assert len(blocks) == 4
    assert blocks[0] == prompt_text(MAIN_PROMPTS, "identity")
    assert blocks[1] == prompt_text(MAIN_PROMPTS, "routing")
    assert blocks[2].startswith(prompt_text(MAIN_PROMPTS, "dispatch"))
    assert blocks[2].endswith(prompt_text(MAIN_PROMPTS, "closing"))
    assert blocks[3] == prompt_text(MAIN_PROMPTS, "system_events")
    for key in ("own_tools", "delegated_search", "proposals"):
        assert prompt_text(MAIN_PROMPTS, key) in blocks[2]


def test_thread_prompt_is_the_whole_file_joined_in_order():
    assert list(THREAD_PROMPTS) == ["identity", "task_source", "principles", "search", "reporting"]
    assert THREAD_ROLE_PROMPT == prompt_text(THREAD_PROMPTS)
    assert THREAD_ROLE_PROMPT.startswith(prompt_text(THREAD_PROMPTS, "identity") + "\n")
    assert THREAD_ROLE_PROMPT.endswith(prompt_text(THREAD_PROMPTS, "reporting", "needs_user"))
    assert "\n\n" not in THREAD_ROLE_PROMPT


def test_learning_contract_fields_are_keyed_by_the_field_they_describe():
    assert list(LEARNING_PROMPTS) == ["intro", "background", "context"]
    fields = LEARNING_PROMPTS["context"]["fields"]
    for key, text in fields.items():
        if key != "long_term_notes":  # the USER / MEMORY snapshot sits in the system prompt, not in the JSON context
            assert text.startswith(f"- {key}："), key
    assert _LEARNING_CONTEXT == prompt_text(LEARNING_PROMPTS, "context")
    assert _LEARNING_CONTEXT in COMMON_CONTEXT_PROMPT
    assert COMMON_CONTEXT_PROMPT.startswith(prompt_text(LEARNING_PROMPTS, "intro") + "\n")


def test_learning_roles_get_the_fields_their_contract_describes():
    fields = LEARNING_PROMPTS["context"]["fields"]
    rows = [{"role": "user", "content": "你好", "kind": "text", "status": "complete", "meta_json": "{}"}]
    for role in ("main", "thread"):
        sent = set(learning_context(chat_messages(rows, [], None, [], conversation_role={"role": role})))
        # the plan, the hint and prior-knowledge fields are only sent when they apply to the turn
        optional = {"long_term_notes", "learning_plan", "transfer_learning_hint"}
        always_sent = set(fields) - optional
        assert always_sent <= sent, (role, always_sent - sent)


def test_thread_knows_its_four_sources_and_only_the_thread_is_told_about_web_search():
    search = prompt_text(THREAD_PROMPTS, "search")
    for name in ("course_sources", "search_good_problems", "web_search", "session_search", "[资料N]", "[网N]"):
        assert name in search, name
    assert "不要用 web_search 找题" in search and "不编造来源" in search
    # the coordinator has no web tools: it hands both kinds of lookup to a thread
    delegated = prompt_text(MAIN_PROMPTS, "delegated_search")
    assert "search_good_problems" in delegated and "web_search" in delegated
    assert "不要对用户说「没有联网能力」" in MAIN_ROLE_PROMPT
    rows = [{"role": "user", "content": "你好", "kind": "text", "status": "complete", "meta_json": "{}"}]
    chat_system = chat_messages(rows, [], None, [], conversation_role={"role": "chat"})[0]["content"]
    assert "web_search" not in chat_system


def test_role_prompts_stay_within_their_length_budget():
    # every character here is sent on every turn; raise a limit only on purpose
    assert len(MAIN_ROLE_PROMPT) <= 2870
    assert len(THREAD_ROLE_PROMPT) <= 1200

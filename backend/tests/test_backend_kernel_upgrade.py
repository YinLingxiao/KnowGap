"""M1/M2/M7 contracts: no real shell commands, credentials or provider traffic."""

import asyncio
import json
import re
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest

from app.agent_tools import files, parse_arguments, run as run_tool
from app.agent_tools.bash import run as run_command
from app.agent_tools.guard import DEFAULT_SECURITY_BLACKLIST, ToolError, check_security_blacklist
from app.agents.llm import ChatCompletionsChat, _tool_calls_from
from app.chat.agent import REVIEW_PROMPT, chat_messages, learning_context, review_messages
from app.chat.skills.thread_skills import THREAD_SKILLS
from app.config import Settings
from app.memory.curated import snapshot_text


BLACKLIST_EXAMPLES = [
    "rm -rf /",
    "mkfs.ext4 /dev/sda",
    "dd if=/dev/zero of=/dev/sda",
    "shred -n 1 /dev/sda",
    "cat .env.production",
    "Get-Content credentials.json",
    "cat /etc/shadow",
    "cat ~/.netrc",
    "ls ~/.ssh/",
    "cat keys/id_rsa",
    "cat signing.pem",
    "cat ~/.aws/credentials",
    "cat ~/.kube/config",
    "cat ~/.docker/config.json",
    "chmod 4755 /bin/bash",
    "sudo bash",
    ":(){ :|:& };:",
]


@pytest.mark.parametrize("index,command", list(enumerate(BLACKLIST_EXAMPLES)))
def test_all_seventeen_mandatory_rules(index, command):
    assert len(DEFAULT_SECURITY_BLACKLIST) == 17
    assert re.search(DEFAULT_SECURITY_BLACKLIST[index], command, re.IGNORECASE)
    assert check_security_blacklist(command)


@pytest.mark.parametrize("command", [
    "rm -fr work", "rm -r -f work", "rm --force --recursive work", 'rm "-rf" /',
    "Remove-Item -Force -Recurse C:/data", "Format-Volume -DriveLetter C",
    "echo bad > /dev/sda", "chmod u+s helper", "chmod +s helper",
    ": ( ) { : | : & } ; :", 'Get-Content "$HOME\\.SSH\\id_ed25519"',
    "Get-Content C:/users/test/.AWS/config", "Get-Content .e`nv",
])
def test_blacklist_common_shell_and_windows_variants(command):
    assert check_security_blacklist(command)


@pytest.mark.parametrize("value", [
    "notes.txt", "docs/environment.md", "src/format.md", "src/sudo.py",
    "env_example.txt", "public-key.pub", "echo hello", "python --version", "rm notes.tmp",
])
def test_blacklist_allows_regular_work(value):
    assert check_security_blacklist(value) is None


def test_shell_blacklist_precedes_workspace_and_process_creation(monkeypatch):
    async def unexpected(*args, **kwargs):
        pytest.fail("A blocked command must never start a process")

    monkeypatch.setattr("app.agent_tools.bash.asyncio.create_subprocess_exec", unexpected)
    with pytest.raises(ToolError, match="^安全防线拦截："):
        asyncio.run(run_command(None, {"command": "rm -rf /"}))


@pytest.mark.parametrize("tool", [files.read_file, files.write_file, files.edit_file])
def test_every_file_executor_checks_before_workspace_or_io(tool):
    with pytest.raises(ToolError, match="^安全防线拦截："):
        tool(None, {"path": ".env", "content": "test", "old_text": "a", "new_text": "b"})


@pytest.mark.parametrize("name,arguments", [
    ("bash", {"command": "rm -rf /"}),
    ("read", {"path": ".env"}),
    ("write", {"path": ".ssh/config", "content": "test"}),
    ("edit", {"path": ".docker/config.json", "old_text": "a", "new_text": "b"}),
])
def test_dispatch_preflight_cannot_be_disabled_by_approval(name, arguments):
    ctx = SimpleNamespace(auto_approve=True, approve_memory=True, security_blacklist=[])
    with pytest.raises(ToolError, match="^安全防线拦截："):
        asyncio.run(run_tool(name, arguments, ctx))


def test_file_guard_checks_resolved_alias_target(tmp_path, monkeypatch):
    original = Path.resolve
    alias = tmp_path / "ordinary.txt"

    def resolve(path, *args, **kwargs):
        return tmp_path / ".env" if path == alias else original(path, *args, **kwargs)

    monkeypatch.setattr(Path, "resolve", resolve)
    with pytest.raises(ToolError, match="^安全防线拦截："):
        files.read_file(tmp_path, {"path": "ordinary.txt"})


@pytest.mark.parametrize("raw,expected", [
    ("", {}), (" \n", {}), ('{"path":"notes.txt"}', {"path": "notes.txt"}),
    ('```json\n{"path":"notes.txt",}\n```', {"path": "notes.txt"}),
    ('\ufeff乱码! {"steps":[{"title":"说明",},],} 尾部乱码', {"steps": [{"title": "说明"}]}),
    ('{"content":", } and , ]", "path":"x",}', {"content": ", } and , ]", "path": "x"}),
    ('{"content":"escaped \\\"quote, }",}', {"content": 'escaped "quote, }'}),
])
def test_tool_arguments_sanitize_wrappers_and_punctuation_without_changing_strings(raw, expected):
    assert parse_arguments(raw) == expected


@pytest.mark.parametrize("raw", ["[]", "null", '```json\n[{"path":"x"},]\n```'])
def test_argument_repair_keeps_object_only_contract(raw):
    with pytest.raises(ToolError, match="JSON 对象"):
        parse_arguments(raw)


@pytest.mark.parametrize("raw", ['{"path":', '{"a":1} {"b":2}', '{"a": danger()}', "not json", "{'path': 'x'}"])
def test_argument_repair_does_not_invent_missing_values_or_evaluate_code(raw):
    with pytest.raises(ToolError, match="^工具参数不是有效的 JSON 对象"):
        parse_arguments(raw)


def test_complete_tool_calls_drop_empty_names_and_malformed_functions():
    assert _tool_calls_from([
        {"function": {"name": None}}, {"function": {"name": ""}},
        {"function": {"name": "  "}}, {"function": []}, {"function": "bad"}, None,
        {"id": "r", "function": {"name": "read", "arguments": '{"path":"x"}'}},
    ]) == [{"id": "r", "name": "read", "arguments": '{"path":"x"}'}]


def test_stream_aggregates_argument_only_chunks_and_fragmented_names():
    chunks = [
        [{"index": 0, "id": "m", "function": {"name": None, "arguments": '{"action":'}},
         {"index": 1, "id": "r", "function": {"name": "re", "arguments": ""}},
         {"index": 2, "id": "orphan", "function": {"name": None, "arguments": "{}"}}],
        [{"index": 0, "function": {"name": "mem", "arguments": '"add"'}},
         {"index": 1, "function": {"name": None, "arguments": '{"path":"x"}'}}],
        [{"index": 0, "function": {"name": "", "arguments": "}"}},
         {"index": 1, "function": {"name": "ad", "arguments": None}}],
        [{"index": 0, "function": {"name": "ory"}}],
    ]
    body = "".join("data: " + json.dumps({"choices": [{"delta": {"tool_calls": calls}}]}) + "\n\n"
                   for calls in chunks)
    body += 'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n'

    def handler(request):
        return httpx.Response(200, text=body, headers={"content-type": "text/event-stream"})

    async def collect():
        settings = Settings(_env_file=None, llm_api_key="test", llm_base_url="https://llm.test/v1", llm_model="m")
        return [item async for item in ChatCompletionsChat(settings, httpx.MockTransport(handler)).stream([])]

    assert asyncio.run(collect()) == [
        ("tool_calls", [{"id": "m", "name": "memory", "arguments": '{"action":"add"}'},
                        {"id": "r", "name": "read", "arguments": '{"path":"x"}'}]),
        ("finish", "tool_calls"),
    ]


def history(*user_messages):
    rows = []
    for index, text in enumerate(user_messages):
        if index:
            rows.append({"role": "assistant", "content": "继续讲解。", "kind": "text",
                         "status": "complete", "meta_json": "{}"})
        rows.append({"role": "user", "content": text, "kind": "text", "status": "complete", "meta_json": "{}"})
    return rows


def context(*messages, user="", memory="", role=None):
    return learning_context(chat_messages(history(*messages), [], None, [], conversation_role=role,
                                         snapshot=snapshot_text({"user": user, "memory": memory})))


@pytest.mark.parametrize("messages", [("我想学习 Python",), ("学 Python",), ("你好", "讲讲 Python 列表")])
def test_prerequisite_probe_for_first_two_learning_turns(messages):
    turn = context(*messages)
    assert turn["prior_knowledge_anchors"] == []
    assert "【迁移学习先验探针】" in turn["transfer_learning_hint"]
    assert "1 句话" in turn["transfer_learning_hint"]
    assert "先验技能：xxx" in turn["transfer_learning_hint"]


@pytest.mark.parametrize("messages", [("你好",), ("谢谢",), ("你好", "你好", "我想学习 Python")])
def test_no_probe_for_greetings_or_after_second_turn(messages):
    assert "transfer_learning_hint" not in context(*messages)


def test_anchors_only_come_from_user_snapshot_and_preserve_preference_contract():
    turn = context("我想学 Python", user="先验技能：C++\n§\n讲解偏好：先举例\n§\n先验技能：Java\n先验技能：C++",
                   memory="先验技能：Rust")
    assert turn["prior_knowledge_anchors"] == ["C++", "Java"]
    assert turn["teaching_preferences"] == [{"source": "USER", "summary": "讲解偏好：先举例"}]
    assert "【对比迁移学习】" in turn["transfer_learning_hint"]
    assert "负迁移" in turn["transfer_learning_hint"]
    assert "comparison_matrix" in turn["recommended_widget"]
    assert "transfer_learning_hint" not in context("你好", user="先验技能：C++")


@pytest.mark.parametrize("message", ["我已经会 C++，现在想学 Python", "我学过 Java，想学 Python"])
def test_explicit_current_prior_skill_uses_comparison_without_waiting_for_snapshot(message):
    turn = context(message)
    assert turn["prior_knowledge_anchors"] == []
    assert turn["reported_prior_knowledge"]
    assert "【对比迁移学习】" in turn["transfer_learning_hint"]
    assert "comparison_matrix" in turn["recommended_widget"]


def test_probe_response_on_second_turn_switches_to_transfer_learning():
    turn = context("我想学 Python", "我之前学过 C++")
    assert turn["reported_prior_knowledge"] == ["C++"]
    assert "【对比迁移学习】" in turn["transfer_learning_hint"]


def test_negated_prior_skill_does_not_become_an_anchor():
    turn = context("我不会 C++，我想学 Python")
    assert "reported_prior_knowledge" not in turn
    assert "【迁移学习先验探针】" in turn["transfer_learning_hint"]


@pytest.mark.parametrize("message", ["如果我会 C++，学 Python 会更容易吗？", "我学过 C++ 吗？"])
def test_hypothetical_or_question_is_not_a_prior_skill_claim(message):
    assert "reported_prior_knowledge" not in context(message)


def test_delegated_thread_task_probes_without_forcing_main_to_render_a_widget():
    assert "transfer_learning_hint" in context("开始吧", role={"role": "thread", "delegated_task": "Python 基础"})
    turn = context("我想学 Python", user="先验技能：C++", role={"role": "main"})
    assert turn["recommended_widget"] is None
    assert "comparison_matrix" in turn["transfer_learning_hint"]


def test_five_layer_review_keeps_existing_white_box_storage_contract():
    for label in ("Identity", "Preference", "Context", "Activity", "Experience",
                  "先验技能：", "常学领域：", "讲解偏好：", "互动偏好：", "阶段目标：", "背景约束：", "近期动态：", "经验法则："):
        assert label in REVIEW_PROMPT
    assert "MEMORY 只记环境事实" in REVIEW_PROMPT
    assert "知识点的误区、掌握不要写" in REVIEW_PROMPT
    notes = {"user": "没有前缀的旧条目", "memory": "旧路径"}
    turns = [{"role": "user", "content": "我学过 C++"}]
    assert json.loads(review_messages(notes, turns)[1]["content"]) == {"notes": notes, "turns": turns}
    for skill in ("deep_explain", "socratic_practice", "study_note_builder"):
        assert "prior_knowledge_anchors" in THREAD_SKILLS[skill]
        assert "跨领域负迁移易错点" in THREAD_SKILLS[skill]

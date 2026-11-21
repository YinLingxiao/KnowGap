"""系统技能：读、做常用文件的做法，AI 用 load_skill 按需加载；设置里能逐个开关。"""
import asyncio
import re
from pathlib import Path
from types import SimpleNamespace

from fastapi.testclient import TestClient

from app.agent_tools import DEFINITIONS, run as run_tool
from app.agent_tools.documents import DEFINITIONS as DOCUMENT_DEFINITIONS
from app.chat.skills import system_skills
from app.chat.store import ChatStore
from app.main import create_app
from app.memory.store import Store
from tests.test_acceptance_support import isolated_settings
from tests.test_chat import FakeChat

STUDENT = "demo-student-001"
APP_ROOT = Path(__file__).resolve().parents[1] / "app"


def chat_store(tmp_path):
    base = Store(tmp_path / "skills.sqlite3")
    base.initialize()
    store = ChatStore(base)
    store.initialize()
    return store


def tool_names(definitions):
    return [tool["function"]["name"] for tool in definitions]


def skill_enum(definitions):
    tool = next(tool for tool in definitions if tool["function"]["name"] == "load_skill")
    return tool["function"]["parameters"]["properties"]["skill"]["enum"]


def test_the_catalog_has_reading_and_making_skills_for_the_common_formats():
    ids = [item["id"] for item in system_skills.catalog()]
    assert ids == ["read_pdf", "read_docx", "read_pptx", "read_xlsx", "make_docx", "make_pptx", "make_xlsx", "make_pdf"]
    for item in system_skills.catalog():
        assert item["category"] == ("read" if item["id"].startswith("read_") else "make")
        assert item["content"].startswith(f"【系统技能：{item['name']}】")
        assert item["name_en"] and item["summary_en"]
    # 和 prompts 一样是 app 下的 YAML：桌面版打包规则 collect_data_files("app", includes=["**/*.yaml"]) 会带上
    assert sorted(path.name for path in (APP_ROOT / "chat" / "skills" / "system").glob("*.yaml")) == sorted(f"{i}.yaml" for i in ids)


def test_making_skills_only_name_tool_options_that_exist():
    describe = " ".join(tool["function"]["description"] for tool in DOCUMENT_DEFINITIONS)
    kinds = DOCUMENT_DEFINITIONS[0]["function"]["parameters"]["properties"]["kind"]["enum"]
    for item in system_skills.catalog():
        for op in re.findall(r"op:'([a-z_]+)'", item["content"]):
            assert f"op:'{op}'" in describe, (item["id"], op)
        for kind in re.findall(r'kind="([a-z]+)"', item["content"]):
            assert kind in kinds, (item["id"], kind)
        for tool in re.findall(r"\b(create_document|edit_document|read_document|search_materials|load_skill)\b", item["content"]):
            assert tool in tool_names(DEFINITIONS), (item["id"], tool)


def test_load_skill_returns_the_full_text_and_lists_skills_when_unknown(tmp_path):
    async def scenario():
        ctx = SimpleNamespace(store=chat_store(tmp_path), student_id=STUDENT)
        text = await run_tool("load_skill", {"skill": "make_pptx"}, ctx)
        assert text.startswith("【系统技能：做 PPT】") and "append_slides" in text
        missing = await run_tool("load_skill", {"skill": "make_mp4"}, ctx)
        assert "没有技能「make_mp4」" in missing and "read_pdf" in missing

    asyncio.run(scenario())


def test_the_tool_lists_every_skill_with_what_it_is_for():
    assert "load_skill" in tool_names(DEFINITIONS)
    assert skill_enum(DEFINITIONS) == [item["id"] for item in system_skills.catalog()]
    description = next(t for t in DEFINITIONS if t["function"]["name"] == "load_skill")["function"]["description"]
    for item in system_skills.catalog():
        assert f"- {item['id']}：{item['name']}——{item['summary']}" in description


def test_settings_api_lists_system_skills_read_only(tmp_path):
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=FakeChat())) as client:
        listed = client.get("/api/skills").json()
        assert listed["custom_skills"] == []
        assert [item["id"] for item in listed["system_skills"]] == [item["id"] for item in system_skills.catalog()]
        assert {"name", "name_en", "summary", "summary_en", "content", "category"} <= set(listed["system_skills"][0])
        assert "enabled" not in listed["system_skills"][0], "system skills are always on"
        assert client.patch("/api/skills/system/make_xlsx", json={"enabled": False}).status_code in (404, 405)


def test_chats_and_space_main_lines_are_offered_load_skill(tmp_path):
    class Capture(FakeChat):
        async def stream(self, messages, tools=None):
            self.calls.append({tool["function"]["name"]: tool for tool in (tools or [])})
            yield "text", "好。"
            yield "finish", "stop"

    model = Capture()
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=model)) as client:
        chat = client.post("/api/conversations", json={}).json()["id"]
        client.post(f"/api/conversations/{chat}/messages", json={"content": "帮我做个 PPT", "client_request_id": "req-skill-1"})
        space = client.post("/api/subjects", json={"name": "数据结构", "description": "", "instructions": ""}).json()
        main_id = space["main_conversation_id"]
        assert main_id
        client.post(f"/api/conversations/{main_id}/messages", json={"content": "整理成 Word", "client_request_id": "req-skill-2"})

    assert "load_skill" in model.calls[0]
    assert "load_skill" in model.calls[1], "space main lines have a tool whitelist; load_skill is on it"

"""识图也要能用 OpenCode Go（会话请求头）和 ChatGPT 套餐（Responses 接口），包括课件 / PDF 里的图片识别。"""

import asyncio
import json

import httpx
from pydantic import SecretStr

from app.agents.llm import ChatCompletionsChat
from app.config import Settings
from app.services import pdf_ocr
from app.vision import settings as vision_settings
from app.vision.grounding import extract
from app.vision.schemas import ServiceModelsConfig
from app.vision.settings import ServiceModels, VisionConfig

OPENCODE = "https://opencode.ai/inference/go/openai/v1"
IMAGE = "data:image/png;base64,iVBORw0KGgo="
EXTRACTION = {"kind": "printed", "transcript": "1+1=?", "regions": [{"id": "r1", "bbox": [10, 10, 200, 60], "text": "1+1=?"}]}


class FakeChatGPT:
    def __init__(self, connected=True):
        self.connected = connected

    def status(self):
        return {"connected": self.connected}


def test_opencode_vision_and_ocr_requests_carry_the_session_header():
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(dict(request.headers))
        content = json.dumps(EXTRACTION) if len(seen) == 1 else "第一页的文字"
        return httpx.Response(200, json={"choices": [{"finish_reason": "stop", "message": {"content": content}}]})

    config = VisionConfig(base_url=OPENCODE, model="kimi-k3", api_key=SecretStr("oc_sk_test"))
    transport = httpx.MockTransport(handler)
    result = asyncio.run(extract(IMAGE, config, transport=transport))
    text = asyncio.run(pdf_ocr._ocr_page(b"\x89PNG", config, transport))

    assert result.transcript == "1+1=?" and text == "第一页的文字"
    assert len(seen) == 2
    assert all(h["x-opencode-session"].startswith("ses_") and h["user-agent"].startswith("KnowGap/") for h in seen)


def test_chatgpt_plan_vision_goes_through_the_responses_channel(monkeypatch):
    calls = []

    async def fake_json(self, messages):
        calls.append(("json", self.settings.llm_auth_mode, self.chatgpt_auth, messages))
        return EXTRACTION

    async def fake_stream(self, messages, tools=None):
        calls.append(("stream", self.settings.llm_auth_mode, self.chatgpt_auth, messages))
        yield ("text", "课件里的文字")
        yield ("finish", "stop")

    monkeypatch.setattr(ChatCompletionsChat, "complete_json", fake_json)
    monkeypatch.setattr(ChatCompletionsChat, "stream", fake_stream)
    auth = FakeChatGPT()
    config = VisionConfig(model="gpt-6.1-sol", auth_mode="chatgpt", chatgpt=auth)

    assert config.configured
    assert asyncio.run(extract(IMAGE, config)).transcript == "1+1=?"
    assert asyncio.run(pdf_ocr._ocr_page(b"\x89PNG", config, None)) == "课件里的文字"
    assert [(kind, mode, used) for kind, mode, used, _ in calls] == [("json", "chatgpt", auth), ("stream", "chatgpt", auth)]
    image_part = calls[0][3][1]["content"][0]
    assert image_part["type"] == "image_url" and image_part["image_url"]["url"] == IMAGE

    assert not VisionConfig(model="gpt-6.1-sol", auth_mode="chatgpt", chatgpt=FakeChatGPT(connected=False)).configured
    assert not VisionConfig(model="gpt-6.1-sol", auth_mode="chatgpt").configured
    assert "chatgpt" not in config.model_dump(), "the login object is never serialised"


def test_default_chatgpt_model_is_used_for_images_with_its_login(monkeypatch):
    auth = FakeChatGPT()

    class AI:
        current = Settings(_env_file=None, llm_auth_mode="chatgpt", llm_model="gpt-6.1-sol", llm_base_url="https://api.openai.com/v1")
        chatgpt = auth

    models = ServiceModels(AI(), env=VisionConfig())
    monkeypatch.setattr(models, "config", lambda: ServiceModelsConfig())
    monkeypatch.setattr(models, "_library_settings", lambda role: None)
    config = models.vision_config()
    assert config.auth_mode == "chatgpt" and config.chatgpt is auth and config.configured
    assert vision_settings.VisionConfig.model_fields["chatgpt"].exclude

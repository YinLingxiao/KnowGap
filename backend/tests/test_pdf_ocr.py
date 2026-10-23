import asyncio
import io
import json

import httpx
import pytest
from fastapi.testclient import TestClient
from PIL import Image, ImageDraw
from pydantic import SecretStr

from app.agents.llm import ProviderError
from app.main import create_app
from app.services.office_readers import Reading
from app.services.pdf_ocr import MAX_OCR_PAGES, OCR_PROMPT, ocr_pdf, render_pages
from app.vision.settings import VisionConfig
from tests.test_acceptance_support import isolated_settings


def scanned_pdf(pages=2) -> bytes:
    """只有图片、没有文字层的 PDF，和手机拍的讲义一样。"""
    images = []
    for number in range(pages):
        image = Image.new("RGB", (800, 1100), "white")
        ImageDraw.Draw(image).text((60, 60 + number * 10), f"scanned page {number + 1}", fill="black")
        images.append(image)
    out = io.BytesIO()
    images[0].save(out, "PDF", save_all=True, append_images=images[1:], resolution=100)
    return out.getvalue()


class Models:
    def __init__(self, configured=True):
        self.configured = configured

    def config(self):
        return None

    def vision_config(self, _):
        if not self.configured:
            return VisionConfig()
        return VisionConfig(base_url="https://vision.test/v1", model="vlm", api_key=SecretStr("k"), source="env")


def reply(text):
    return httpx.Response(200, json={"choices": [{"message": {"content": text}}]})


def run(coroutine):
    return asyncio.run(coroutine)


def test_pages_are_rendered_and_capped():
    images, total = render_pages(scanned_pdf(3))
    assert total == 3 and len(images) == 3 and all(image.startswith(b"\x89PNG") for image in images)
    images, total = render_pages(scanned_pdf(MAX_OCR_PAGES + 3))
    assert total == MAX_OCR_PAGES + 3 and len(images) == MAX_OCR_PAGES


def test_ocr_sends_one_request_per_page_keeps_page_order_and_notes_the_source():
    seen = []

    def handler(request):
        body = json.loads(request.content)
        content = body["messages"][0]["content"]
        assert content[0]["image_url"]["url"].startswith("data:image/png;base64,") and content[1]["text"] == OCR_PROMPT
        seen.append(request)
        return reply(f"第 {len(seen)} 次请求的转写")

    reading = run(ocr_pdf(scanned_pdf(3), Models(), transport=httpx.MockTransport(handler)))
    assert len(seen) == 3 and [number for number, _ in reading.pages] == [1, 2, 3]
    assert all("转写" in text for _, text in reading.pages)
    assert any("扫描图片" in note and "错字" in note for note in reading.notes)


def test_ocr_reports_pages_beyond_the_limit_and_failed_pages():
    calls = {"n": 0}

    def handler(request):
        calls["n"] += 1
        return httpx.Response(500, text="boom") if calls["n"] == 2 else reply("正文\n```")

    reading = run(ocr_pdf(scanned_pdf(MAX_OCR_PAGES + 2), Models(), transport=httpx.MockTransport(handler)))
    notes = "\n".join(reading.notes)
    assert f"只识别了前 {MAX_OCR_PAGES} 页（共 {MAX_OCR_PAGES + 2} 页）" in notes
    assert "识别失败" in notes
    assert len(reading.pages) == MAX_OCR_PAGES - 1
    assert "```" not in reading.pages[0][1]


def test_ocr_fails_clearly_without_a_vision_model_or_when_nothing_is_read():
    with pytest.raises(ProviderError) as excinfo:
        run(ocr_pdf(scanned_pdf(1), Models(configured=False)))
    assert excinfo.value.status_code == 503 and "识图模型" in excinfo.value.detail
    with pytest.raises(ProviderError) as excinfo:
        run(ocr_pdf(scanned_pdf(1), Models(), transport=httpx.MockTransport(lambda request: httpx.Response(401, text="no"))))
    assert "没能识别出文字" in excinfo.value.detail


def test_scanned_pdf_upload_is_read_through_ocr_and_searchable(tmp_path):
    async def fake_ocr(data):
        return Reading([(1, "栈是后进先出的线性表。"), (2, "队列是先进先出的线性表。")], ["这份 PDF 是扫描图片，文字由识图模型识别，可能有错字、漏字，公式和表格尤其要核对原件。"])

    with TestClient(create_app(isolated_settings(tmp_path))) as client:
        client.app.state.materials.ocr = fake_ocr
        cid = client.post("/api/conversations", json={}).json()["id"]
        response = client.post(f"/api/conversations/{cid}/attachments", files={"file": ("讲义扫描.pdf", scanned_pdf())})
        assert response.status_code == 201, response.text
        info = response.json()
        assert info["kind"] == "pdf" and info["units"] == 2 and any("扫描图片" in note for note in info["notes"])
        found = client.get("/api/materials/search", params={"q": "队列 先进先出"}).json()
        assert found and "先进先出" in found[0]["excerpt"]
        direct = client.post("/api/materials", files={"file": ("讲义扫描2.pdf", scanned_pdf())})
        assert direct.status_code == 201


def test_scanned_pdf_without_vision_keeps_the_readable_error(tmp_path):
    with TestClient(create_app(isolated_settings(tmp_path))) as client:
        cid = client.post("/api/conversations", json={}).json()["id"]
        response = client.post(f"/api/conversations/{cid}/attachments", files={"file": ("讲义扫描.pdf", scanned_pdf())})
        assert response.status_code == 422 and "扫描图片" in response.json()["detail"] and "识图模型" in response.json()["detail"]
        assert client.get("/api/materials").json() == []


def test_ocr_uses_the_native_gemini_channel_when_the_vision_model_is_vertex_native():
    """原生 Gemini 没有 /chat/completions：识别请求必须走 streamGenerateContent，并带上页面图片。"""
    seen = []

    def handler(request):
        seen.append(request)
        body = json.loads(request.content)
        assert request.url.path.endswith(":streamGenerateContent") and request.headers["x-goog-api-key"] == "native-key"
        assert body["contents"][0]["parts"][0]["inlineData"]["mimeType"] == "image/png"
        assert body["contents"][0]["parts"][1]["text"] == OCR_PROMPT
        packet = {"candidates": [{"content": {"role": "model", "parts": [
            {"text": "先想一想", "thought": True}, {"text": f"第 {len(seen)} 页正文"}]}, "finishReason": "STOP"}]}
        return httpx.Response(200, text=f"data: {json.dumps(packet, ensure_ascii=False)}\n\n",
                              headers={"content-type": "text/event-stream"})

    class NativeModels(Models):
        def vision_config(self, _):
            return VisionConfig(base_url="https://aiplatform.googleapis.com/v1/publishers/google/models",
                                model="gemini-4-argon", api_key=SecretStr("native-key"), source="env")

    reading = run(ocr_pdf(scanned_pdf(2), NativeModels(), transport=httpx.MockTransport(handler)))
    assert len(seen) == 2 and all("正文" in text and "先想一想" not in text for _, text in reading.pages)

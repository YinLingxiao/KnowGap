"""Word 文档里的图片：按所在的「节」取出，交给识图模型，文字并回那一节。识图模型一律用模拟，不访问网络。"""

import io
import json

import httpx
import pytest
from docx import Document
from docx.shared import Inches
from fastapi import HTTPException
from PIL import Image, ImageDraw

from app.agent_tools import documents
from app.services.materials import extract_document
from app.services.office_readers import docx_pictures, read_docx
from app.services.slide_images import DOC_PROMPT, add_picture_text, collect_pictures
from tests.test_slide_images import Models, library, reply, run, tool_env  # noqa: F401 - pytest fixtures


def picture(color: str, size=(320, 200)) -> io.BytesIO:
    image = Image.new("RGB", size, "white")
    ImageDraw.Draw(image).rectangle((10, 10, size[0] - 10, size[1] - 10), outline=color, width=6)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    buffer.seek(0)
    return buffer


def architecture_doc() -> bytes:
    """第 1 节：标题 + 架构图（单独一段，只有图）；第 2 节：很长的正文；第 3 节：结尾段落里的流程图和一个小图标。"""
    document = Document()
    document.add_heading("KnowGap 架构导读", 1)
    document.add_paragraph("整体架构如下图所示。")
    document.add_picture(picture("blue"), width=Inches(3))
    document.add_paragraph("正文。" * 600)
    ending = document.add_paragraph("请求处理流程：")
    ending.add_run().add_picture(picture("red"), width=Inches(3))
    ending.add_run().add_picture(picture("green", (24, 24)))  # 图标：太小，不送识图
    output = io.BytesIO()
    document.save(output)
    return output.getvalue()


def image_only_doc() -> bytes:
    document = Document()
    document.add_picture(picture("black"))
    output = io.BytesIO()
    document.save(output)
    return output.getvalue()


def test_each_picture_is_tagged_with_the_section_it_falls_in():
    data = architecture_doc()
    sections = [number for number, _ in read_docx(data).pages]
    assert sections == [1, 2, 3]
    assert [page for page, _ in docx_pictures(data)] == [1, 3, 3]
    found = collect_pictures("docx", data)
    assert [p.slide for p in found.pictures] == [1, 3]
    assert found.total == 3 and found.decorative == 1
    assert read_docx(data).notes == ["文中含 3 张图片，图片里的文字没有读取。"]


def test_picture_text_lands_in_its_section_with_a_word_prompt_and_section_notes():
    data = architecture_doc()
    seen = []

    def handler(request):
        seen.append(json.loads(request.content)["messages"][0]["content"][1]["text"])
        return reply(f"图中文字 {len(seen)}")

    _, original = extract_document("架构导读.docx", data)
    reading = run(add_picture_text("docx", data, original, Models(), transport=httpx.MockTransport(handler)))
    assert seen == [DOC_PROMPT, DOC_PROMPT]
    assert DOC_PROMPT.startswith("这是一份 Word 文档里的一张插图")
    pages = dict(reading.pages)
    assert pages[1].startswith("# KnowGap 架构导读") and "[图片内容]\n图中文字" in pages[1]
    assert "[图片内容]" not in pages[2]
    assert pages[3].index("请求处理流程") < pages[3].index("[图片内容]")
    assert set(reading.extra) == {1, 3}
    assert any("第 1、3 节的图片由识图模型识别" in note for note in reading.notes)
    assert not any("图片里的文字没有读取" in note for note in reading.notes)


def test_without_a_vision_model_the_note_says_what_to_do():
    data = architecture_doc()
    _, original = extract_document("架构导读.docx", data)
    reading = run(add_picture_text("docx", data, original, Models(configured=False)))
    assert dict(reading.pages) == dict(original.pages)
    assert reading.notes == ["文档里有 2 张内容图片，图片里的文字没有读取。到「设置 → 模型接入」配置一个多模态识图模型后重新上传，就能识别。"]


def test_upload_reads_word_pictures_and_accepts_a_document_that_is_only_a_picture(library):  # noqa: F811
    async def hook(kind, data, reading):
        return await add_picture_text(kind, data, reading, Models(), transport=httpx.MockTransport(lambda _: reply("服务调用关系：前端 → 后端")))

    with pytest.raises(HTTPException) as refused:
        run(library.add_with_ocr("student", "截图.docx", image_only_doc()))
    assert refused.value.status_code == 422

    library.slide_ocr = hook
    only_picture = run(library.add_with_ocr("student", "截图.docx", image_only_doc()))
    assert only_picture.kind == "docx"
    assert "服务调用关系" in library.attachment(only_picture.id, "student", excerpt=True)["excerpt"]

    material = run(library.add_with_ocr("student", "架构导读.docx", architecture_doc()))
    attachment = library.attachment(material.id, "student", excerpt=True)
    assert "服务调用关系" in attachment["excerpt"]
    assert any("由识图模型识别" in note for note in attachment["notes"])


def test_read_document_returns_word_picture_text_in_the_right_section(tool_env):  # noqa: F811
    materials, ctx = tool_env

    async def hook(kind, data, reading):
        return await add_picture_text(kind, data, reading, Models(), transport=httpx.MockTransport(lambda _: reply("前端 → 后端 → SQLite")))

    materials.slide_ocr = hook
    material = run(materials.add_with_ocr("student", "架构导读.docx", architecture_doc()))
    first = documents.read_document({"file_id": material.id, "start": 1, "limit": 1}, ctx)
    middle = documents.read_document({"file_id": material.id, "start": 2, "limit": 1}, ctx)
    last = documents.read_document({"file_id": material.id, "start": 3, "limit": 1}, ctx)
    assert "整体架构如下图所示" in first and "[图片内容]\n前端 → 后端 → SQLite" in first
    assert "[图片内容]" not in middle.split("（共")[0]
    assert "请求处理流程" in last and "[图片内容]\n前端 → 后端 → SQLite" in last

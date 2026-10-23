"""对话里的图片：本轮图片先走视觉分析，模型只看文字结果；识图卡片放在回复开头。"""

import asyncio

import app.chat.service as service_module
from app.chat.service import ChatService

IMG_A = "img_" + "a" * 20
IMG_B = "img_" + "b" * 20


def make_service(monkeypatch, calls, fail=None):
    async def fake_analyze(request, settings, *, store, student_id):
        calls.append((request.image_id, request.prompt, student_id))
        if fail:
            raise fail
        return {"relay_prompt": f"[[kg-image:{request.image_id}]]\n【题目与已知条件】识别出的题目",
                "widget_markdown": "```knowgap-widget\n{\"type\":\"image_annotator\"}\n```"}

    monkeypatch.setattr(service_module, "analyze_image_for_relay", fake_analyze)
    chat = ChatService(store=None, model=lambda: None)
    chat.vision = (object(), object())
    return chat


def history(*contents):
    return [{"id": f"m{i}", "role": "user", "content": text, "status": "complete"} for i, text in enumerate(contents)]


def test_current_turn_image_becomes_relay_text_and_card(monkeypatch):
    calls = []
    chat = make_service(monkeypatch, calls)
    rows, card = asyncio.run(chat._read_images("s1", history(f"[[kg-image:{IMG_A}]]\n帮我批改"), "m0"))
    assert calls == [(IMG_A, "帮我批改", "s1")]
    assert "识别出的题目" in rows[0]["content"]
    assert card.startswith("```knowgap-widget")


def test_older_images_are_not_analyzed_again(monkeypatch):
    calls = []
    chat = make_service(monkeypatch, calls)
    rows, card = asyncio.run(chat._read_images(
        "s1", history(f"[[kg-image:{IMG_A}]]\n第一题", "再看看第二步"), "m1"))
    assert calls == []
    assert card == ""
    assert rows[0]["content"] == "（学生发了一张图片）\n第一题"
    assert "kg-image" not in rows[0]["content"]


def test_failed_analysis_tells_the_model_not_to_pretend(monkeypatch):
    calls = []
    chat = make_service(monkeypatch, calls, fail=RuntimeError("模型不支持图片输入"))
    rows, card = asyncio.run(chat._read_images("s1", history(f"[[kg-image:{IMG_A}]]\n这题怎么做"), "m0"))
    assert card == ""
    assert "图片读取失败" in rows[0]["content"]
    assert "模型不支持图片输入" in rows[0]["content"]
    assert "这题怎么做" in rows[0]["content"]
    assert "kg-image" not in rows[0]["content"]


def test_without_vision_service_image_reads_as_failure(monkeypatch):
    calls = []
    chat = make_service(monkeypatch, calls)
    chat.vision = None
    rows, _ = asyncio.run(chat._read_images("s1", history(f"[[kg-image:{IMG_A}]]"), "m0"))
    assert calls == []
    assert "视觉服务没有启动" in rows[0]["content"]


def test_at_most_three_images_and_duplicates_once(monkeypatch):
    calls = []
    chat = make_service(monkeypatch, calls)
    ids = [IMG_A, IMG_A, IMG_B] + ["img_" + c * 20 for c in "cde"]
    text = "\n".join(f"[[kg-image:{i}]]" for i in ids) + "\n看看"
    asyncio.run(chat._read_images("s1", history(text), "m0"))
    assert [c[0] for c in calls] == [IMG_A, IMG_B, "img_" + "c" * 20]

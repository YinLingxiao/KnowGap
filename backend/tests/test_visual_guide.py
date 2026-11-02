"""The widget capability and both card guides live in the system prompt and stay offline."""

import re

from app.chat.skills import (
    THREAD_SKILLS, WIDGET_SYSTEM_PROMPT, recommend_widget, refuses_widget, select_skill_prompt,
)
from app.chat.skills.thread_skills import WIDGET_CAPABILITY, WIDGET_SCHEMA_GUIDE
from app.chat.skills.visual_guide import VISUAL_CARD_GUIDE


def test_card_guides_moved_out_of_skills_into_system_prompt():
    for key in ("deep_explain", "socratic_practice", "study_note_builder"):
        assert VISUAL_CARD_GUIDE not in THREAD_SKILLS[key]
        assert WIDGET_SCHEMA_GUIDE not in THREAD_SKILLS[key]
    for part in (WIDGET_CAPABILITY, WIDGET_SCHEMA_GUIDE, VISUAL_CARD_GUIDE):
        assert part in WIDGET_SYSTEM_PROMPT


def test_visual_examples_are_two_offline_fragments():
    blocks = re.findall(r"```knowgap-visual\n(.*?)\n```", VISUAL_CARD_GUIDE, re.S)
    assert len(blocks) == 2
    banned = ("<html", "<head", "<body", "http://", "https://")
    saw_ask = False
    for block in blocks:
        lowered = block.lower()
        for token in banned:
            assert token not in lowered
        assert "var(--" in block
        if "knowgap.ask(" in block:
            saw_ask = True
    assert saw_ask


def test_capability_no_longer_talks_the_model_out_of_widgets():
    assert "knowgap-visual" in WIDGET_CAPABILITY and "严禁" in WIDGET_CAPABILITY
    for text in (WIDGET_SYSTEM_PROMPT, *THREAD_SKILLS.values()):
        assert "纯文字能说清时两者都不用" not in text and "不要用卡片" not in text
    assert select_skill_prompt("chat", "我想自己点一遍，看编号怎么落到节点上") is None


def test_system_prompt_carries_the_widget_guides_except_for_main():
    from app.chat.agent import chat_messages

    def system(role):
        return chat_messages([{"id": "u1", "seq": 1, "role": "user", "content": "你好", "kind": "text",
                               "status": "complete", "meta_json": "{}", "reply_to": None}],
                             [], None, [], None, {"role": role})[0]["content"]

    for role in ("chat", "thread"):
        assert WIDGET_SYSTEM_PROMPT in system(role)
    assert WIDGET_CAPABILITY not in system("main")


def test_recommend_widget_knows_visual_wording():
    for text in ("给我做个可交互的二叉树遍历演示", "能不能画个图展示一下链表", "写个滑块让我拖动着试试", "讲讲链表"):
        assert recommend_widget("chat", text).startswith("knowgap-visual")
    assert recommend_widget("chat", "栈和队列的区别").startswith("comparison_matrix")
    assert recommend_widget("chat", "出几道栈的题考考我").startswith("micro_quiz")
    assert recommend_widget("main", "给我做个可交互的演示") is None
    assert recommend_widget("chat", "你好呀你好") is None


def test_refusal_detector_flags_save_as_html_but_not_real_widgets():
    assert refuses_widget("聊天窗口里我嵌不了可以点的控件，请保存成 tree.html 后用浏览器打开")
    assert refuses_widget("```html\n<!DOCTYPE html>\n<html></html>\n```")
    assert not refuses_widget("先看这张图：\n```knowgap-visual\n<svg></svg>\n```\n也可以另存为 .html")
    assert not refuses_widget("```html\n<!DOCTYPE html>\n<html></html>\n```", "帮我写一个 HTML 页面")
    assert not refuses_widget("栈是后进先出。")

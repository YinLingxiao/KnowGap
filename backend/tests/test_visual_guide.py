"""The sandbox visual-card guide is injected into thread skills and stays offline."""

import re

from app.chat.skills.thread_skills import THREAD_SKILLS
from app.chat.skills.visual_guide import VISUAL_CARD_GUIDE


def test_visual_card_guide_injected_into_thread_skills():
    assert VISUAL_CARD_GUIDE in THREAD_SKILLS["deep_explain"]
    assert VISUAL_CARD_GUIDE in THREAD_SKILLS["socratic_practice"]
    assert VISUAL_CARD_GUIDE in THREAD_SKILLS["study_note_builder"]


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

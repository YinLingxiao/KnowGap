"""Sandbox visual-card guide (`knowgap-visual`); the text lives in `prompts/zh/widgets.yaml`."""

from app.chat.skills.thread_skills import WIDGET_PROMPTS
from app.services.prompt import prompt_text

VISUAL_CARD_GUIDE = prompt_text(WIDGET_PROMPTS, "visual")

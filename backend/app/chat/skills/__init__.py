"""Role-scoped Skill router for `thread`, `main`, and `chat`."""

import re

from app.chat.skills.chat_skills import (
    ONBOARDING_FIRST_MESSAGE,
    ONBOARDING_TITLE,
)
from app.chat.skills.main_skills import MAIN_ROADMAP_SKILL
from app.chat.skills.thread_skills import THREAD_SKILLS

_FEYNMAN_RE = re.compile(r"费曼|我来讲|听我讲|挑刺|考官")
_PRACTICE_RE = re.compile(r"练习|做题|考我|出.*题|测验|刷题|来看看我的解答|对不对")
_NOTE_RE = re.compile(r"讲义|笔记|总结成文档|模拟器|写成文件|整理一份")
_ROADMAP_RE = re.compile(r"计划|路线|怎么学|从哪开始|学习安排|规划")
_EXPLAIN_RE = re.compile(r"讲解|原理|为什么|怎么理解|区别|对比|深入|映射|机制|过程|推导")
_COMPARE_RE = re.compile(r"区别|对比|异同|不同|优缺点|还是|哪几种")
_FORMULA_RE = re.compile(r"公式|计算|参数|曲线|命中率|弹性|斜率|变化影响")


def recommend_widget(role: str, user_text: str, delegated_task: str | None = None) -> str | None:
    """Return a proactive widget recommendation for `turn_context.recommended_widget`."""
    if role == "main":
        return None
    sample = f"{delegated_task or ''} {user_text or ''}".strip()
    if not sample or len(sample) < 4:
        return None
    if _PRACTICE_RE.search(sample):
        return "micro_quiz（建议在回复中嵌入 ```knowgap-widget 的 micro_quiz 随堂微测卡）"
    if _COMPARE_RE.search(sample):
        return "comparison_matrix 或 step_simulator（建议在回复中嵌入 ```knowgap-widget 交互对比卡或单步推演器）"
    if _FORMULA_RE.search(sample):
        return "parameter_lab（建议在回复中嵌入 ```knowgap-widget 参数实验微件）"
    if _EXPLAIN_RE.search(sample) or role == "thread":
        return "step_simulator（建议在回复中嵌入 ```knowgap-widget 单步状态推演器展示核心过程）"
    return None


def infer_thread_skill(text: str, explicit_skill: str | None = None) -> str:
    """Resolve the active skill key for a `thread` conversation."""
    if explicit_skill in THREAD_SKILLS:
        return explicit_skill
    sample = (text or "").strip()
    if _FEYNMAN_RE.search(sample):
        return "feynman_challenge"
    if _PRACTICE_RE.search(sample):
        return "socratic_practice"
    if _NOTE_RE.search(sample):
        return "study_note_builder"
    return "deep_explain"


def select_skill_prompt(
    role: str,
    user_text: str,
    delegated_task: str | None = None,
    delegated_skill: str | None = None,
    conversation_title: str = "",
    earlier_user_texts: list[str] | None = None,
) -> str | None:
    """Return the role-appropriate Skill SOP to inject into `turn_context.active_skill`."""
    # A Feynman self-test spans several turns: once the title or an earlier user turn started it,
    # later answers ("栈就是…") keep the challenge instead of falling back to deep_explain.
    feynman_session = bool(_FEYNMAN_RE.search(conversation_title or "")) or any(
        _FEYNMAN_RE.search(text or "") for text in earlier_user_texts or []
    )
    if role == "thread":
        if feynman_session and delegated_skill not in THREAD_SKILLS:
            return THREAD_SKILLS["feynman_challenge"]
        skill_key = infer_thread_skill(delegated_task or user_text, delegated_skill)
        return THREAD_SKILLS.get(skill_key)
    if role == "main":
        if _ROADMAP_RE.search(user_text or ""):
            return MAIN_ROADMAP_SKILL
        return None
    if role == "chat":
        sample = (user_text or "").strip()
        if feynman_session or _FEYNMAN_RE.search(sample):
            return THREAD_SKILLS["feynman_challenge"].replace("，并调用 `report_progress` 回报掌握结论", "")
        if len(sample) >= 8 and not _PRACTICE_RE.search(sample) and _EXPLAIN_RE.search(sample):
            return THREAD_SKILLS["deep_explain"].replace("，最后调用 `report_progress` 回报进展", "")
        if _PRACTICE_RE.search(sample):
            return THREAD_SKILLS["socratic_practice"].replace(
                "3. 本轮结束前调用 `report_progress` 回报当前练习进展（等待用户继续作答时设 `needs_user=true`）。",
                "",
            )
    return None


__all__ = [
    "MAIN_ROADMAP_SKILL",
    "ONBOARDING_FIRST_MESSAGE",
    "ONBOARDING_TITLE",
    "THREAD_SKILLS",
    "infer_thread_skill",
    "recommend_widget",
    "select_skill_prompt",
]

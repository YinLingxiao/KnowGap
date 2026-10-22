"""Role-scoped Skill router for `thread`, `main`, and `chat`."""

import re

from app.chat.skills.chat_skills import (
    ONBOARDING_FIRST_MESSAGE,
    ONBOARDING_TITLE,
)
from app.chat.skills.main_skills import MAIN_ROADMAP_SKILL
from app.chat.skills.file_skills import file_skill_prompt
from app.chat.skills.thread_skills import THREAD_SKILLS

_FEYNMAN_RE = re.compile(r"费曼|我来讲|听我讲|挑刺|考官")
_PRACTICE_RE = re.compile(r"练习|做题|考我|出.*题|测验|刷题|来看看我的解答|对不对|练手|好题|真题|母题")
_NOTE_RE = re.compile(r"讲义|笔记|总结成文档|模拟器|写成文件|整理一份")
_ROADMAP_RE = re.compile(r"计划|路线|怎么学|从哪开始|学习安排|规划")
_EXPLAIN_RE = re.compile(r"讲解|原理|为什么|怎么理解|区别|对比|深入|映射|机制|过程|推导")
_COMPARE_RE = re.compile(r"区别|对比|异同|不同|优缺点|还是|哪几种")
_FORMULA_RE = re.compile(r"公式|计算|参数|曲线|命中率|弹性|斜率|变化影响")
_CODE_RE = re.compile(r"代码实验|写代码|代码填空|脚手架|补全.*代码|编译运行|code_playground", re.I)


def recommend_widget(
    role: str, user_text: str, delegated_task: str | None = None, earlier_user_texts: list[str] | None = None,
) -> str | None:
    """Return a proactive widget recommendation for `turn_context.recommended_widget`."""
    if role == "main":
        return None
    if earlier_user_texts is not None:
        from app.chat.skills.viva_skill import viva_progress, viva_widget_hint

        # 模拟复试：提问阶段不放微件，第 3 问答完才放 viva_radar
        progress = viva_progress([*earlier_user_texts, user_text or ""])
        if progress is not None:
            return viva_widget_hint(progress)
    sample = f"{delegated_task or ''} {user_text or ''}".strip()
    if not sample or len(sample) < 4:
        return None
    if _CODE_RE.search(sample):
        return "code_playground（建议在回复中嵌入 ```knowgap-widget 的 code_playground 代码脚手架实验台）"
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
    attached_files: list[dict] | None = None,
) -> str | None:
    """Return the role-appropriate Skill SOP to inject into `turn_context.active_skill`."""
    if attached_files:
        return file_skill_prompt(user_text)
    # A Feynman self-test spans several turns: once the title or an earlier user turn started it,
    # later answers ("栈就是…") keep the challenge instead of falling back to deep_explain.
    # 在函数内导入：problem_drill_skill 依赖 agent_tools、viva_skill 依赖 store，顶层导入会形成循环。
    from app.chat.skills.problem_drill_skill import problem_drill_prompt
    from app.chat.skills.viva_skill import begin_turn, is_viva_trigger, viva_prompt

    # 模拟复试跨 4 轮（开场 + 3 次回答），轮次只由用户消息序列推算；结果记入本次生成，供出题与核对环节读取。
    viva_round = begin_turn(user_text, earlier_user_texts)
    if viva_round is not None and role in {"chat", "thread"}:
        return viva_prompt(viva_round)
    # 「你当面试官/考官」这类复试开场不算费曼自测，复试结束后不能粘成费曼会话。
    feynman_session = bool(_FEYNMAN_RE.search(conversation_title or "")) or any(
        _FEYNMAN_RE.search(text or "") and not is_viva_trigger(text) for text in earlier_user_texts or []
    )
    # 练习出题改由 problem_drill 接管：先搜真题母题再出题，作答后的引导沿用 socratic_practice。
    if role == "thread":
        if feynman_session and delegated_skill not in THREAD_SKILLS:
            return THREAD_SKILLS["feynman_challenge"]
        skill_key = infer_thread_skill(delegated_task or user_text, delegated_skill)
        if skill_key == "socratic_practice":
            return problem_drill_prompt("thread")
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
            return problem_drill_prompt("chat")
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

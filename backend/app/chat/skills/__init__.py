"""Role-scoped Skill router for `thread`, `main`, and `chat`."""

import re

from app.chat.skills.chat_skills import (
    ONBOARDING_TITLE,
)
from app.chat.skills.main_skills import MAIN_ROADMAP_SKILL
from app.chat.skills.file_skills import file_skill_prompt
from app.chat.skills.thread_skills import THREAD_SKILLS, WIDGET_CAPABILITY, WIDGET_SCHEMA_GUIDE
from app.chat.skills.visual_guide import VISUAL_CARD_GUIDE

# 控件能力声明与两份规范不随轮次变化，放进系统提示：小模型读得到，也能命中前缀缓存。
WIDGET_SYSTEM_PROMPT = f"{WIDGET_CAPABILITY}\n\n{WIDGET_SCHEMA_GUIDE}\n\n{VISUAL_CARD_GUIDE}"

_FEYNMAN_RE = re.compile(r"费曼|我来讲|听我讲|挑刺|考官")
_PRACTICE_RE = re.compile(r"练习|做题|考我|出.*题|测验|刷题|来看看我的解答|对不对|练手|好题|真题|母题")
_NOTE_RE = re.compile(r"讲义|笔记|总结成文档|模拟器|写成文件|整理一份")
_ROADMAP_RE = re.compile(r"计划|路线|怎么学|从哪开始|学习安排|规划")
_EXPLAIN_RE = re.compile(r"讲解|原理|为什么|怎么理解|区别|对比|深入|映射|机制|过程|推导")
_COMPARE_RE = re.compile(r"区别|对比|异同|不同|优缺点|还是|哪几种")
_CODE_RE = re.compile(r"代码实验|写代码|代码填空|脚手架|补全.*代码|编译运行|code_playground", re.I)
# 用户明说要可点、可看的东西：优先于出题和对比。
_VISUAL_INTENT_RE = re.compile(r"可交互|交互|可点|点一下|动画|演示|可视化|画.{0,4}图|模拟|滑块|拖动")
# 只是在讲结构或过程的话题词：出题、对比的需求优先，其余讲解默认配图示。
_VISUAL_TOPIC_RE = re.compile(r"树|链表|图论|遍历|排序|堆|栈|队列|指针|状态变化")
_VISUAL_RECOMMENDATION = "knowgap-visual（必须在回复中嵌入 ```knowgap-visual 可点击的 SVG 图示或动画，不要让用户保存 HTML 文件）"

# 模型说「嵌不了」或把整页 HTML 当文件贴给用户，都是没用上控件的表现。
_WIDGET_REFUSAL_RE = re.compile(
    r"嵌(?:入)?不了|(?:无法|没法|不能|不支持)(?:直接)?嵌入"
    r"|(?:做|放|提供|实现)不了[^。\n]{0,8}(?:可交互|交互|控件|可点)"
    r"|无法[^。\n]{0,6}(?:可交互|交互式)(?:控件|图|动画|演示)"
    r"|(?:保存|存|另存)(?:为|成)\s*[\w.-]*\.html"
    r"|双击[^。\n]{0,15}浏览器|(?:用|在|通过)浏览器打开"
)
_WIDGET_BLOCK_RE = re.compile(r"```knowgap-(?:widget|visual)\b")
_PLAIN_FENCE_RE = re.compile(r"```(?!knowgap-)[\w+-]*[ \t]*\r?\n(.*?)```", re.S)
_HTML_REQUEST_RE = re.compile(r"html|网页|网站|前端|源码", re.I)

WIDGET_RETRY_NOTICE = (
    "（系统提示：你能直接在正文输出 ```knowgap-visual 控件（或 ```knowgap-widget 微件），用户无需保存文件或打开浏览器。"
    "请改写上一条回复：用控件呈现，不要让用户保存文件，也不要说“嵌不了”。）"
)


def recommend_widget(
    role: str, user_text: str, delegated_task: str | None = None,
) -> str | None:
    """Return a proactive widget recommendation for `turn_context.recommended_widget`."""
    if role == "main":
        return None
    sample = f"{delegated_task or ''} {user_text or ''}".strip()
    if not sample or len(sample) < 4:
        return None
    if _CODE_RE.search(sample):
        return "code_playground（必须在回复中嵌入 ```knowgap-widget 的 code_playground 代码实验台）"
    if _VISUAL_INTENT_RE.search(sample):
        return _VISUAL_RECOMMENDATION
    if _PRACTICE_RE.search(sample):
        return "micro_quiz（必须在回复中嵌入 ```knowgap-widget 的 micro_quiz 随堂微测卡）"
    if _COMPARE_RE.search(sample):
        return "comparison_matrix（必须在回复中嵌入 ```knowgap-widget 交互对比卡）"
    if _VISUAL_TOPIC_RE.search(sample):
        return _VISUAL_RECOMMENDATION
    if _EXPLAIN_RE.search(sample) or role == "thread":
        return "step_simulator（必须在回复中嵌入 ```knowgap-widget 单步推演器展示核心过程）"
    return None


def refuses_widget(reply: str, user_text: str = "") -> bool:
    """True when a reply tells the learner to save an HTML file instead of using an inline widget."""
    if not reply or _WIDGET_BLOCK_RE.search(reply) or _HTML_REQUEST_RE.search(user_text or ""):
        return False
    if _WIDGET_REFUSAL_RE.search(reply):
        return True
    return any("<!doctype html" in body.lower() for body in _PLAIN_FENCE_RE.findall(reply))


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
    # 在函数内导入：problem_drill_skill 依赖 agent_tools，顶层导入会形成循环。
    from app.chat.skills.problem_drill_skill import problem_drill_prompt

    feynman_session = bool(_FEYNMAN_RE.search(conversation_title or "")) or any(
        _FEYNMAN_RE.search(text or "") for text in earlier_user_texts or []
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
    "ONBOARDING_TITLE",
    "THREAD_SKILLS",
    "WIDGET_RETRY_NOTICE",
    "WIDGET_SYSTEM_PROMPT",
    "infer_thread_skill",
    "recommend_widget",
    "refuses_widget",
    "select_skill_prompt",
]

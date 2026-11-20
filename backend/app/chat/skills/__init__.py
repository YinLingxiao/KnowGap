"""Role-scoped Skill router for `thread`, `main`, and `chat`."""

import re

from app.chat.skills.chat_skills import (
    ONBOARDING_INTERVIEW_SKILL,
    ONBOARDING_TITLE,
    onboarding_greeting,
)
from app.chat.skills.main_skills import MAIN_ROADMAP_SKILL
from app.chat.skills.file_skills import file_skill_prompt
from app.chat.skills.thread_skills import THREAD_SKILLS, WIDGET_CAPABILITY, WIDGET_CRAFT_GUIDE, WIDGET_SCHEMA_GUIDE
from app.chat.skills.visual_guide import VISUAL_CARD_GUIDE
from app.services.prompt import get_prompt_manager, prompt_text

_MODE_PROMPTS = get_prompt_manager().load_prompts("chat", "modes")
_WIDGET_PROMPTS = get_prompt_manager().load_prompts("chat", "widgets")
_CARD_KEYS = ("step_simulator", "comparison_matrix", "micro_quiz", "code_playground", "gap")
_VISUAL_KEY = "knowgap-visual"
_ALLOWED_MODE_WIDGETS = frozenset(_CARD_KEYS) | {_VISUAL_KEY}

_WIDGET_SYSTEM_PROMPT = f"{WIDGET_CAPABILITY}\n\n{WIDGET_SCHEMA_GUIDE}\n\n{WIDGET_CRAFT_GUIDE}\n\n{VISUAL_CARD_GUIDE}"
_CARD_ONLY_CAPABILITY = "\n".join([
    prompt_text(_WIDGET_PROMPTS, "capability", "heading"),
    "你的回复由 KnowGap 前端渲染，在聊天正文里写 ```knowgap-widget（JSON 微件）代码块，就会直接变成可点击、可操作的卡片。",
    prompt_text(_WIDGET_PROMPTS, "capability", "never_refuse"),
    prompt_text(_WIDGET_PROMPTS, "capability", "recommended"),
    prompt_text(_WIDGET_PROMPTS, "capability", "when_not"),
])


def mode_widgets(mode: str) -> list[str]:
    if mode not in _MODE_PROMPTS:
        raise ValueError(f"未知模式：{mode}")
    raw = [part.strip() for part in prompt_text(_MODE_PROMPTS, mode, "widgets").split(",") if part.strip()]
    widgets = [part for part in raw if part.lower() != "none"]
    unknown = [part for part in widgets if part not in _ALLOWED_MODE_WIDGETS]
    if unknown:
        raise ValueError(f"未知卡片：{','.join(unknown)}")
    return widgets


def widget_prompt_for(mode: str | None) -> str:
    """Return the widget guide for a mode; None is the existing full prompt, byte for byte."""
    if mode is None:
        return _WIDGET_SYSTEM_PROMPT
    widgets = mode_widgets(mode)
    if not widgets:
        return ""
    cards = [key for key in _CARD_KEYS if key in widgets]
    allow_visual = _VISUAL_KEY in widgets
    parts = [WIDGET_CAPABILITY if allow_visual else _CARD_ONLY_CAPABILITY]
    if cards:
        schema = [
            prompt_text(_WIDGET_PROMPTS, "schema", "heading"),
            prompt_text(_WIDGET_PROMPTS, "schema", "intro").replace(
                "支持以下 5 种类型", f"本模式只用下面这 {len(cards)} 种类型"),
        ]
        schema.extend(prompt_text(_WIDGET_PROMPTS, "schema", key) for key in cards)
        schema.append(prompt_text(_WIDGET_PROMPTS, "schema", "constraints"))
        parts.append("\n".join(schema))
    parts.append(WIDGET_CRAFT_GUIDE)
    if allow_visual:
        parts.append(VISUAL_CARD_GUIDE)
    return "\n\n".join(parts)


WIDGET_SYSTEM_PROMPT = widget_prompt_for(None)
MODE_PROMPTS = _MODE_PROMPTS

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
    role: str, user_text: str, delegated_task: str | None = None, mode: str | None = None,
) -> str | None:
    """Return a proactive widget recommendation for `turn_context.recommended_widget`."""
    if role == "main":
        return None
    allowed = set(mode_widgets(mode)) if mode is not None else None
    if allowed is not None and not allowed:
        return None
    sample = f"{delegated_task or ''} {user_text or ''}".strip()
    if not sample or len(sample) < 4:
        return None
    candidates = (
        ("code_playground", _CODE_RE.search(sample), "code_playground（必须在回复中嵌入 ```knowgap-widget 的 code_playground 代码实验台）"),
        (_VISUAL_KEY, _VISUAL_INTENT_RE.search(sample), _VISUAL_RECOMMENDATION),
        ("micro_quiz", _PRACTICE_RE.search(sample), "micro_quiz（必须在回复中嵌入 ```knowgap-widget 的 micro_quiz 随堂微测卡）"),
        ("comparison_matrix", _COMPARE_RE.search(sample), "comparison_matrix（必须在回复中嵌入 ```knowgap-widget 交互对比卡）"),
        (_VISUAL_KEY, _VISUAL_TOPIC_RE.search(sample), _VISUAL_RECOMMENDATION),
        ("step_simulator", _EXPLAIN_RE.search(sample) or role == "thread", "step_simulator（必须在回复中嵌入 ```knowgap-widget 单步推演器展示核心过程）"),
    )
    for key, matched, text in candidates:
        if matched and (allowed is None or key in allowed):
            return text
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
    mode: str | None = None,
    onboarding_interview: bool = False,
) -> str | None:
    """Return the role-appropriate Skill SOP to inject into `turn_context.active_skill`.

    Free chats (`chat`) are a general assistant: no keyword-mounted teaching SOP, only the plain
    attachment rules when files are attached (or the first-run onboarding interview when active).
    """
    if onboarding_interview and role == "chat":
        return ONBOARDING_INTERVIEW_SKILL
    if attached_files:
        return file_skill_prompt(user_text, plain=role == "chat", mode=mode)
    if role == "chat":
        return None
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
    if role == "main" and _ROADMAP_RE.search(user_text or ""):
        return MAIN_ROADMAP_SKILL
    return None


__all__ = [
    "MAIN_ROADMAP_SKILL",
    "MODE_PROMPTS",
    "ONBOARDING_INTERVIEW_SKILL",
    "ONBOARDING_TITLE",
    "THREAD_SKILLS",
    "WIDGET_RETRY_NOTICE",
    "WIDGET_SYSTEM_PROMPT",
    "infer_thread_skill",
    "mode_widgets",
    "onboarding_greeting",
    "recommend_widget",
    "refuses_widget",
    "select_skill_prompt",
    "widget_prompt_for",
]

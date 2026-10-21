"""viva_interview：模拟复试 / 压力面试舱，3 轮递进追问后输出 viva_radar 五维雷达图。

本文件提供三样东西：
1. viva_progress()：只根据本对话的用户消息序列推算当前轮次，不依赖模型输出或额外存储。
   历史消息由服务端持久化，重新生成、刷新页面都不会让计数漂移。
2. viva_prompt()：按轮次拼装挂载给模型的 SOP（第 1～3 问逐轮加压，第 3 问作答后出总评与雷达微件）。
3. guard_viva_radar()：回复生成后核对 viva_radar 微件。分数裁剪到 0～100，缺失维度补位，
   引用原话必须能在本场回答里逐字找到，找不到就删掉，不允许编造。

轮次状态在同一次生成内传递：select_skill_prompt 计算后放进 ContextVar，drill_plan 与 guard_reply
随后在同一个 asyncio 任务里读取（service._run 依次调用 chat_messages → drill_plan → guard_reply）。
"""

from __future__ import annotations

import json
import re
from contextvars import ContextVar

from app.chat.store import quote_in

TOTAL_ROUNDS = 3

VIVA_TRIGGER_RE = re.compile(
    r"模拟(?:复试|面试|答辩|考研面试)|压力(?:面试|测试面|舱)|复试模拟|面试模拟|"
    r"(?:当|扮演|做)(?:一下)?(?:我的)?(?:复试|面试)(?:官|老师|导师)|\bviva\b",
    re.I,
)
# 会话中途再次提到「模拟面试」不一定是要重开（「模拟面试时我容易紧张」），必须带重开意图。
VIVA_RESTART_RE = re.compile(r"重新|再来|重来|再开|换一|开始")
VIVA_EXIT_RE = re.compile(r"(?:结束|停止|退出|终止|不想|不要|别)(?:再)?(?:模拟)?(?:面试|复试|追问|面了|问了)|不面了|直接(?:给|看)答案")

DIMENSIONS: tuple[tuple[str, str], ...] = (
    ("concept", "概念准确度"),
    ("boundary", "边界严密性"),
    ("derivation", "推导逻辑性"),
    ("transfer", "跨学科迁移力"),
    ("expression", "表达条理性"),
)
_LABEL_TO_KEY = {label: key for key, label in DIMENSIONS}

STAGE_NAMES = {1: "概念", 2: "边界", 3: "迁移推导"}

# 本轮生成的复试状态：{"user_text": 最新用户消息, "round": 0..3, "answers": [本场回答原文]}，不在复试中为 None。
_VIVA_TURN: ContextVar[dict | None] = ContextVar("knowgap_viva_turn", default=None)


def is_viva_trigger(text: str | None) -> bool:
    return bool(VIVA_TRIGGER_RE.search(text or ""))


def viva_progress(user_texts: list[str]) -> int | None:
    """按时间顺序的用户消息 → 最新一条在本场复试中的位置。

    0 表示最新一条是开场请求（该出第 1 问），1～3 表示最新一条是第 k 问的回答（3 = 该出总评），
    None 表示不在复试中（从未开始、已主动结束，或总评已经给出）。
    """
    state: int | None = None
    for text in user_texts:
        text = text or ""
        if state is None or state >= TOTAL_ROUNDS:
            state = 0 if is_viva_trigger(text) else None
        elif VIVA_EXIT_RE.search(text):
            state = None
        elif is_viva_trigger(text) and VIVA_RESTART_RE.search(text):
            state = 0
        else:
            state += 1
    return state


def viva_answers(user_texts: list[str]) -> list[str]:
    """本场复试里用户的回答原文（不含开场请求），供引用核对。"""
    progress = viva_progress(user_texts)
    if not progress:
        return []
    return [text or "" for text in user_texts[len(user_texts) - progress:]]


def begin_turn(user_text: str | None, earlier_user_texts: list[str] | None) -> int | None:
    """select_skill_prompt 每轮调用一次：计算轮次并记入本次生成的上下文。"""
    texts = [*(earlier_user_texts or []), user_text or ""]
    progress = viva_progress(texts)
    _VIVA_TURN.set(None if progress is None else {
        "user_text": user_text or "", "round": progress, "answers": viva_answers(texts),
    })
    return progress


def current_turn(user_text: str | None = None) -> dict | None:
    """本次生成的复试状态。给了 user_text 时必须与计算时的最新消息一致，防止读到别的请求留下的状态。"""
    turn = _VIVA_TURN.get()
    if turn is None or (user_text is not None and turn["user_text"] != user_text):
        return None
    return turn


# ============================================================ Skill SOP

VIVA_SKILL_BASE = """【当前挂载 Skill：viva_interview（模拟复试 / 压力面试舱）】
你现在是一位严格但公正的研究生复试 / 技术面试官。整场共 3 问，每轮只问 1 个问题，逐轮加压：
- 第 1 问「概念」：要求用自己的话精确定义核心概念，并说明它成立的前提；
- 第 2 问「边界」：针对上一答的漏洞，或该概念的边界条件、反例、退化情形发难；
- 第 3 问「迁移推导」：要求现场推导一个结论，或把该概念迁移到另一学科 / 场景，并说明类比在哪里失效。
选题规则：
1. 话题优先级：用户开场指定的科目或知识点 > subject（goal、level）与最近对话的主题 > learner_memories 涉及的知识点。
2. 发难靶点：优先挑 learner_memories 里 kind=misconception、status 不是 resolved、与话题相关的历史误区，以及最容易被忽略的边界条件。
   可以从这些误区设计陷阱，但不要直接念出记录原文，也不要编造用户说过的话。
3. 毫无线索时，第 1 问就问：「请讲讲你最熟悉的一门核心课里最重要的一个概念，并说明它成立的前提。」
   不要先问用户想面什么科目，不要寒暄，不要罗列面试规则。
提问格式：
- 每一问以单独一行 `**复试 · 第 N/3 问（阶段）**` 开头，随后只写这一个问题（可附 1 句情境），不给提示、不给答案、不讲课。
- 第 2、3 问之前，先用不超过 2 句话冷静点评上一答：指出最关键的一个漏洞或闪光点；可以引用用户原话，但必须逐字照抄。
- 总评之前不嵌入任何 knowgap-widget，也不调用出题工具。
- 用户中途要求结束或看答案时，停止追问，按其要求处理。"""

VIVA_STAGE_PROMPTS = {
    0: "【本轮进度】用户刚发起模拟复试，还没有回答任何问题。直接给出第 1/3 问（概念）。",
    1: "【本轮进度】用户刚回答完第 1 问。用 1～2 句点评后，给出第 2/3 问（边界）：专挑第 1 答暴露的漏洞或该概念的边界条件、反例发难。",
    2: "【本轮进度】用户刚回答完第 2 问。用 1～2 句点评后，给出第 3/3 问（迁移推导）：要求现场推导，或迁移到另一学科 / 场景并说明类比失效之处。",
}

VIVA_FINAL_PROMPT = """【本轮进度】用户刚回答完第 3 问，面试结束。不要再提问，按以下结构输出总评：
1. 单独一行 `**复试 · 总评**`，接着用 2～4 句话总结整场表现（面试官口吻，直接、具体，指出最强和最弱的地方）。
2. 嵌入且只嵌入 1 个 viva_radar 微件，格式如下：
```knowgap-widget
{"type":"viva_radar","title":"模拟复试 · 五维评估","topic":"本场考察的知识点","dimensions":[{"key":"concept","score":72,"quote":"用户原话片段","reason":"一句依据"},{"key":"boundary","score":55,"quote":"","reason":"一句依据"},{"key":"derivation","score":60,"quote":"用户原话片段","reason":"一句依据"},{"key":"transfer","score":48,"quote":"用户原话片段","reason":"一句依据"},{"key":"expression","score":80,"quote":"用户原话片段","reason":"一句依据"}],"verdict":"面试官总评一句话","suggestions":["改进建议1","改进建议2"]}
```
字段规则：
- dimensions 恰好 5 项，key 依次为 concept（概念准确度）、boundary（边界严密性）、derivation（推导逻辑性）、transfer（跨学科迁移力）、expression（表达条理性）。
- score 是 0～100 的整数，按三次回答的实际表现给分，拉开差距，不要一律给高分或平均分。
- quote 必须是用户这 3 次回答中逐字、连续的原文片段（建议 6～40 字），不得改写、拼接、补字或加省略号；
  找不到能支撑该维度的原话就写空字符串 ""。系统会逐字核对，对不上的引用会被删除。
- reason 一句话说明给分理由，不要在 reason 里再用引号引用原话。
- verdict 一句话；suggestions 1～3 条，每条一句、可操作，具体到该补哪个概念、边界或推导步骤。
- JSON 必须合法：不要注释，不要尾逗号，字符串里的双引号要转义。
3. 微件之后用 1 句话邀请用户针对最弱的维度继续追问，或说「再来一场模拟复试」重新开始。"""


def viva_prompt(progress: int) -> str:
    stage = VIVA_FINAL_PROMPT if progress >= TOTAL_ROUNDS else VIVA_STAGE_PROMPTS[progress]
    return f"{VIVA_SKILL_BASE}\n\n{stage}"


def viva_widget_hint(progress: int | None) -> str | None:
    if progress is None:
        return None
    if progress >= TOTAL_ROUNDS:
        return "viva_radar（本轮必须在总评中嵌入 ```knowgap-widget 的 viva_radar 五维雷达评估，且只嵌入 1 个）"
    return "无（模拟复试提问阶段，本轮只提一个问题，不嵌入任何微件）"


# ============================================================ 回复核对

WIDGET_RE = re.compile(r"```knowgap-widget[^\n]*\n(.*?)\n?```", re.S)
_QUOTE_MARKS = "「」『』“”\"'‘’《》 "
_ELLIPSIS_RE = re.compile(r"…+|\.{3,}")
_QUOTED_SPAN_RE = re.compile(r"「[^」]{2,}」|『[^』]{2,}』|“[^”]{2,}”|\"[^\"]{2,}\"")
INVALID_NOTE = "\n> 模拟复试的评估雷达图数据格式有误，未能展示。可以说「重新生成总评」让面试官再出一次。\n"


def _clean(value, limit: int) -> str:
    if not isinstance(value, str):
        return ""
    return " ".join(value.split())[:limit]


def _score(value: float) -> int:
    return int(round(min(100.0, max(0.0, value))))


def _rescale(raw_scores: list[float]) -> float:
    """整组分数都 ≤10（且至少一个 >1）按十分制，都 ≤1 按小数制，否则按百分制。"""
    present = [s for s in raw_scores if s is not None]
    if present and max(present) <= 1 and any(0 < s < 1 for s in present):
        return 100.0
    if present and max(present) <= 10 and any(s > 1 for s in present):
        return 10.0
    return 1.0


def _raw_number(value) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, str):
        match = re.search(r"-?\d+(?:\.\d+)?", value)
        return float(match.group(0)) if match else None
    return float(value) if isinstance(value, (int, float)) and value == value else None


def verified_quote(quote, answers: list[str]) -> str:
    """原话核对：去掉外层引号后，必须是某一次回答里逐字、连续的片段，否则返回空串。"""
    text = _clean(quote, 200).strip(_QUOTE_MARKS)
    if len(text) < 2 or _ELLIPSIS_RE.search(text):
        return ""
    return text if any(quote_in(text, answer) for answer in answers) else ""


def _scrub_quotes(text: str, answers: list[str], report: dict) -> str:
    """理由、总评里引号括起来却在回答里找不到的片段整段删掉，不让编造的原话混进来。"""
    def keep(match):
        inner = match.group(0)[1:-1]
        if any(quote_in(inner, answer) for answer in answers):
            return match.group(0)
        report["scrubbed"] = report.get("scrubbed", 0) + 1
        return ""
    return re.sub(r"\s{2,}", " ", _QUOTED_SPAN_RE.sub(keep, text)).strip()


def check_viva_radar(widget: dict, answers: list[str], report: dict | None = None) -> dict:
    """把模型给的 viva_radar 规范成前端可直接渲染的结构。"""
    report = report if report is not None else {}
    raw_dims = widget.get("dimensions")
    by_key: dict[str, dict] = {}
    items = raw_dims if isinstance(raw_dims, list) else []
    if isinstance(raw_dims, dict):  # {"concept": {...}} 或 {"概念准确度": 80}
        items = [{"key": k, **(v if isinstance(v, dict) else {"score": v})} for k, v in raw_dims.items()]
    for index, item in enumerate(items):
        if not isinstance(item, dict):
            continue
        key = item.get("key")
        if key not in dict(DIMENSIONS):
            key = _LABEL_TO_KEY.get(_clean(item.get("label") or item.get("key") or item.get("name"), 20))
        if key is None and len(items) == len(DIMENSIONS):
            key = DIMENSIONS[index][0]  # 没写 key 但顺序齐全：按约定顺序认领
        if key and key not in by_key:
            by_key[key] = item
    scale = _rescale([_raw_number(item.get("score")) for item in by_key.values()])
    dimensions = []
    for key, label in DIMENSIONS:
        item = by_key.get(key)
        if item is None:
            report["missing"] = report.get("missing", 0) + 1
            dimensions.append({"key": key, "label": label, "score": None, "quote": "", "reason": ""})
            continue
        raw = _raw_number(item.get("score"))
        score = _score(raw * scale) if raw is not None else None
        if raw is not None and (raw * scale < 0 or raw * scale > 100):
            report["clamped"] = report.get("clamped", 0) + 1
        raw_quote = item.get("quote", item.get("evidence"))
        quote = verified_quote(raw_quote, answers)
        if _clean(raw_quote, 200).strip(_QUOTE_MARKS) and not quote:
            report["dropped_quotes"] = report.get("dropped_quotes", 0) + 1
        reason = _scrub_quotes(_clean(item.get("reason") or item.get("comment"), 120), answers, report)
        dimensions.append({"key": key, "label": label, "score": score, "quote": quote, "reason": reason})
    scored = [d["score"] for d in dimensions if d["score"] is not None]
    suggestions = widget.get("suggestions")
    if isinstance(suggestions, str):
        suggestions = [suggestions]
    cleaned_suggestions = [s for s in (_clean(x, 120) for x in suggestions or [] if isinstance(x, str)) if s][:3]
    return {
        "type": "viva_radar",
        "title": _clean(widget.get("title"), 40) or "模拟复试 · 五维评估",
        "topic": _clean(widget.get("topic"), 40),
        "dimensions": dimensions,
        "overall": round(sum(scored) / len(scored)) if scored else None,
        "verdict": _scrub_quotes(_clean(widget.get("verdict") or widget.get("summary"), 300), answers, report),
        "suggestions": cleaned_suggestions,
    }


def guard_viva_radar(text: str, answers: list[str] | None) -> tuple[str, dict]:
    """核对回复里的 viva_radar 微件；没有该微件时原样返回、报告为空。answers 为 None 时所有引用都视为无法核实。"""
    answers = [a for a in answers or [] if a]
    report: dict = {}

    def replace(match):
        try:
            widget = json.loads(match.group(1))
        except ValueError:
            if '"viva_radar"' not in match.group(1):
                return match.group(0)
            report["invalid"] = report.get("invalid", 0) + 1
            return INVALID_NOTE
        if not isinstance(widget, dict) or widget.get("type") != "viva_radar":
            return match.group(0)
        if report.get("kept"):
            report["duplicates"] = report.get("duplicates", 0) + 1
            return ""
        report["kept"] = 1
        fixed = check_viva_radar(widget, answers, report)
        return "```knowgap-widget\n" + json.dumps(fixed, ensure_ascii=False) + "\n```"

    return WIDGET_RE.sub(replace, text or ""), report

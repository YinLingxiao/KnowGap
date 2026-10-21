"""problem_drill：socratic_practice 出题环节的升级版。先搜真题母题，再按误区做同构变式，校验通过才出题。

本文件提供四样东西：
1. PROBLEM_DRILL_SKILL / problem_drill_prompt()：挂载给模型的 SOP，作答后的引导直接沿用 socratic_practice 原文。
2. verify_problem_variant 工具：改编题，以及给计算/填空原题配的选项，都必须先过这里的 sympy 数值校验。
3. guard_reply()：回复生成后逐个核对 micro_quiz 微件。来源不明或被改动的题直接拦截，meta.source 由服务端按登记记录重写。
4. 辅助函数：读取未解决误区、拼装和解析「再出一道同型好题」请求、收集已出过的题目指纹。

数值校验的安全边界：表达式先过 AST 白名单（只允许数字、变量、四则运算、乘方和白名单函数），
再放进独立子进程（python -I）里用 sympy 计算，超时直接杀掉。模型写的表达式永远不在服务进程里执行。
"""

from __future__ import annotations

import ast
import asyncio
import hashlib
import json
import re
import subprocess
import sys
from typing import Literal

from pydantic import BaseModel, Field, ValidationError, field_validator

from app.chat.skills.thread_skills import SOCRATIC_PRACTICE_SKILL

# problem_search 在文件末尾导入，原因见那里的注释。模块级代码不能用 ps。
SEARCH_TOOL = "search_good_problems"
VERIFY_TOOL = "verify_problem_variant"
DRILL_TOOLS = frozenset({SEARCH_TOOL, VERIFY_TOOL})
MAX_ATTEMPTS = 3            # 每道母题最多校验 3 次（首次 + 重试 2 次），之后回退
SYMPY_TIMEOUT = 8.0         # 子进程超时：Windows 上启动 Python 并导入 sympy 本身就要 1～2 秒
MAX_EXPR = 300
MAX_NODES = 200
MAX_EXPONENT = 1000
VARIANT_TTL_SIZE = 512

# ============================================================ Skill SOP

PROBLEM_DRILL_STEPS = """【当前挂载 Skill：problem_drill（真题母题 → 靶向变式出题）】
出练习题时严格按以下流程，禁止凭空编题：
1. 用户给出了具体知识点（如「定积分换元法」）就直接往下做，不要追问难度、题型或题量：题量默认 3（最多 5），用户没说的难度和题型留空不填。
   只有知识点过宽（如「微积分」「高数」）或完全没给知识点时，才先追问一句。
2. 读误区：只看 turn_context.learner_memories 里 kind=misconception、status 不是 resolved、与该知识点相关的条目（最多 3 条），记下 id 和 summary。
   没有就当作没有误区，直接下一步。不要向用户询问他有哪些误区。
3. 必须先调用 `search_good_problems`（对话里已有本轮的检索结果时直接使用，不要重复调用）。knowledge_point 填规范的知识点名；misconception_hints 填误区的简短概念词，不要带用户身份信息。
   用户没明确说题型就不要填 problem_types，没说难度就不要填 difficulty。
   用户消息以「再出一道同型好题」开头时，把其中的「题型」填入 pattern，把「已出」列出的指纹和本对话里已出过的题目指纹一起填入 exclude_fingerprints。
4. 工具返回 status=no_result 时，如实告诉用户没找到可溯源的好题，建议换一个更具体的知识点或上传含例题的讲义。此时不出任何题。
5. 选母题并决定出法：
   - 没有相关误区，或用户明确要原题/真题：原题直出（L0）。候选题本身是选择题时，照抄 stem、options 和 answer_index。
     是计算/填空题时，题干照抄，另配 3～4 个选项（干扰项按常见错误构造），并调用 `verify_problem_variant`（level=L0）校验。
   - 有相关误区：挑解题过程会触发该误区的母题做同构改编。L1 只换数值或参数，解题骨架不变；L2 保持解题模型，改设问（如求值改为求参数范围）。
     干扰项对准误区构造，option_misconceptions 标出每个错误选项对应的误区 id。改编题必须调用 `verify_problem_variant`，
     check 里写可由 sympy 计算的参数、约束、答案表达式和每个选项的值。
   - 证明题、开放题、无法用 sympy 计算的概念题不改编：原本是选择题就原题直出，否则换一道候选题。
   - 校验不通过时按返回的 errors 修正后重试。工具返回 fallback 后不再改编这道母题：fallback=original 改为原题直出，fallback=skip 换一道候选题。
6. 出题方式：每题在回复里单独一行写一个占位符，系统会按检索记录自动生成测验卡并标注来源：
   - 原题选择题写 [[quiz:candidate_id]]，例如 [[quiz:cand_1a2b3c4d5e6f]]
   - 计算/填空原题也写 [[quiz:candidate_id]]，系统会展示原文题干（不给答案）
   - 校验通过的题写 [[quiz:variant_id]]，例如 [[quiz:var_0123456789abcdef]]
   占位符里的 id 必须来自本轮工具结果，否则这道题会被隐藏。不要自己写 knowgap-widget 代码块。
   正文只写一两句引导语：不要复述题干和选项，不要提前给答案或解析，不要写出处、年份、题号或链接，
   不要提工具名，也不要描述你调用工具的过程。不要编造用户说过的话（如「你之前提到」），除非对话里确实有。
7. 用户作答后按下面 socratic_practice 的方法引导；用户选中某个误区干扰项时，针对那条误区给提示。"""

PROBLEM_DRILL_SKILL = f"{PROBLEM_DRILL_STEPS}\n\n{SOCRATIC_PRACTICE_SKILL}"

_REPORT_STEP = "3. 本轮结束前调用 `report_progress` 回报当前练习进展（等待用户继续作答时设 `needs_user=true`）。"


def problem_drill_prompt(role: str) -> str:
    """thread 角色需要 report_progress；普通 chat 没有这个工具，去掉那一步（与 skills/__init__.py 的处理一致）。"""
    return PROBLEM_DRILL_SKILL if role == "thread" else PROBLEM_DRILL_SKILL.replace(_REPORT_STEP, "")


# ============================================================ 误区与「再来一道」

def unresolved_misconceptions(memories, limit: int = 3) -> list[dict]:
    """memories 是 store.relevant_memories() 的返回值 [(LearnerMemory, scope)]，已按相关度排好序。"""
    result = []
    for item in memories or []:
        memory = item[0] if isinstance(item, tuple) else item
        if getattr(memory, "kind", None) == "misconception" and getattr(memory, "status", None) != "resolved":
            result.append({"id": memory.id, "topic": memory.topic, "summary": memory.summary})
    return result[:limit]


def misconception_hints(items: list[dict]) -> list[str]:
    """误区 summary（如「认为换元后积分限不用改」）压成搜索用的短语，去掉「认为」等前缀。"""
    hints = []
    for item in items:
        text = re.sub(r"^(?:用户)?(?:认为|以为|误以为|觉得)", "", str(item.get("summary") or "")).strip("，。 ")
        if text:
            hints.append(text[:20])
    return hints[:3]


MORE_PREFIX = "再出一道同型好题"
_MORE_FIELD_RE = re.compile(r"(知识点|题型|已出)[:：]\s*([^｜|\n]*)")


def build_more_request(knowledge_point: str, pattern: str | None, fingerprints: list[str]) -> str:
    """前端「再来一道同型好题」按钮发出的消息。以「再出…题」开头，能命中 _PRACTICE_RE 进入练习技能。"""
    parts = [MORE_PREFIX, f"知识点：{knowledge_point}"]
    if pattern:
        parts.append(f"题型：{pattern}")
    if fingerprints:
        parts.append(f"已出：{','.join(fingerprints[-20:])}")
    return "｜".join(parts)


def parse_more_request(text: str) -> dict | None:
    if not isinstance(text, str) or not text.strip().startswith(MORE_PREFIX):
        return None
    fields = {key: value.strip() for key, value in _MORE_FIELD_RE.findall(text)}
    fingerprints = [fp for fp in re.split(r"[,，\s]+", fields.get("已出", "")) if re.fullmatch(r"[0-9a-f]{16}", fp)]
    return {
        "knowledge_point": fields.get("知识点") or None,
        "pattern": fields.get("题型") or None,
        "exclude_fingerprints": fingerprints,
    }


WIDGET_RE = re.compile(r"```knowgap-widget[^\n]*\n(.*?)\n?```", re.S)


def shown_fingerprints(texts) -> list[str]:
    """从本对话已有的回复里收集出过的题目指纹，供「再来一道」排除。"""
    seen: list[str] = []
    for text in texts or []:
        for match in WIDGET_RE.finditer(text or ""):
            try:
                widget = json.loads(match.group(1))
            except ValueError:
                continue
            meta = widget.get("meta") if isinstance(widget, dict) else None
            fp = meta.get("fingerprint") if isinstance(meta, dict) else None
            if isinstance(fp, str) and re.fullmatch(r"[0-9a-f]{16}", fp) and fp not in seen:
                seen.append(fp)
    return seen


# ============================================================ 服务端兜底搜题

# 「找几道 X 的好题练手」「出两道 X 的练习题」这类明确要题的说法
_ASK_RE = re.compile(r"(?:找|出|来|搜|推荐|整)\s*(?:几|一|两|二|三|四|五|\d+)?\s*(?:道|个|些)|好题|真题|母题|练手|刷题|练习题|习题")
_KP_PREFIX_RE = re.compile(
    r"^(?:请|麻烦|能不能|可以)?\s*(?:你)?\s*(?:帮我|给我)?\s*(?:找|出|来|搜|推荐|整)\s*"
    r"(?:几|一|两|二|三|四|五|\d+)?\s*(?:道|个|些)?\s*(?:关于)?"
)
_KP_SUFFIX_RE = re.compile(
    r"(?:的)?\s*(?:经典|典型|真实)?\s*(?:好题|真题|母题|练习题|习题|题目|题)\s*(?:来|给我)?\s*"
    r"(?:练手|练练|练习|做做|刷刷|试试)?\s*(?:吧|呗|吗|呀)?$"
)
_KP_BAD_RE = re.compile(r"考我|练习|做题|对不对|解答|我的|这道|那道|[?？，,]")
BROAD_TOPICS = frozenset({"微积分", "高数", "高等数学", "数学", "线代", "线性代数", "概率论", "物理", "数据结构", "题"})


def guess_knowledge_point(text: str) -> str | None:
    """从明确的要题消息里取知识点。取不准就返回 None，交给模型追问，宁可不兜底也不乱搜。"""
    sample = re.sub(r"[。！!？?\s]+$", "", (text or "").strip())
    if not sample or len(sample) > 40 or not _ASK_RE.search(sample):
        return None
    kp = _KP_SUFFIX_RE.sub("", _KP_PREFIX_RE.sub("", sample)).strip(" ：:「」“”\"'")
    if not 2 <= len(kp) <= 16 or kp in BROAD_TOPICS or _KP_BAD_RE.search(kp):
        return None
    return kp if re.search(r"[一-鿿A-Za-z]", kp) else None


# 「先讲概念，再出一道小题」「分步骤带我学」：讲解优先的学习请求，由教学流程出题，不交给真题检索接管
_LESSON_FIRST_RE = re.compile(r"先讲|先讲解|讲清|讲讲|带我学|分步骤|一步步|循序|从概念|先教")
_REAL_PROBLEM_RE = re.compile(r"真题|母题|好题|刷题|考研题|竞赛题")


def lesson_first(text: str) -> bool:
    """讲解优先、没有要真题的学习请求：本轮不提供真题检索工具，题目由教学流程现场出。"""
    return bool(_LESSON_FIRST_RE.search(text or "")) and not _REAL_PROBLEM_RE.search(text or "")


def wants_problems(text: str) -> bool:
    """用户本轮是在要题（而不是提交作答、问「对不对」）。"""
    return bool(parse_more_request(text)) or bool(_ASK_RE.search(text or ""))


def drill_plan(role: str, user_text: str, delegated_task: str | None = None, delegated_skill: str | None = None,
               history_texts=(), memories=()) -> tuple[bool, dict | None]:
    """返回 (本轮是否挂载 problem_drill, 模型漏调搜题时服务端代为调用的参数)。

    路由判断与 skills.select_skill_prompt 一致。第二项为 None 表示不兜底（如知识点太宽、要等用户补充）。
    """
    from app.chat.skills import _FEYNMAN_RE, _PRACTICE_RE, infer_thread_skill
    from app.chat.skills.viva_skill import current_turn

    text = user_text or ""
    # 模拟复试中的开场与回答（「考考我栈」「出栈顺序的问题是…」）不是在要题，不能被搜题接管
    if current_turn(text) is not None:
        return False, None
    if role == "thread":
        active = infer_thread_skill(delegated_task or text, delegated_skill) == "socratic_practice"
    elif role == "chat":
        active = (not _FEYNMAN_RE.search(text) and bool(_PRACTICE_RE.search(text))
                  and not lesson_first(text))
    else:
        active = False
    if not active:
        return False, None
    more = parse_more_request(text)
    if more and more["knowledge_point"]:
        args = {"knowledge_point": more["knowledge_point"],
                "exclude_fingerprints": list(dict.fromkeys(more["exclude_fingerprints"] + shown_fingerprints(history_texts)))[:50]}
        if more["pattern"]:
            args["pattern"] = more["pattern"]
    else:
        kp = guess_knowledge_point(text)
        if kp is None:
            return True, None
        args = {"knowledge_point": kp}
    hints = misconception_hints(unresolved_misconceptions(memories))
    if hints:
        args["misconception_hints"] = hints
    return True, args


# ============================================================ 表达式白名单

FUNC_NAMES = frozenset({
    "sqrt", "cbrt", "exp", "log", "ln", "sin", "cos", "tan", "cot", "sec", "csc", "asin", "acos", "atan",
    "sinh", "cosh", "tanh", "Abs", "factorial", "binomial", "floor", "ceiling", "Min", "Max",
    "integrate", "diff", "limit", "Sum", "Eq", "Ne", "Rational",
})
CONST_NAMES = frozenset({"pi", "E", "oo"})
RESERVED_NAMES = FUNC_NAMES | CONST_NAMES | {"Symbol", "Integer", "Float", "I"}
NAME_RE = re.compile(r"[A-Za-z][A-Za-z0-9_]{0,15}")
_ALLOWED_NODES = (
    ast.Expression, ast.BinOp, ast.UnaryOp, ast.Compare, ast.Call, ast.Name, ast.Load, ast.Constant, ast.Tuple,
    ast.Add, ast.Sub, ast.Mult, ast.Div, ast.Pow, ast.USub, ast.UAdd, ast.Lt, ast.Gt, ast.LtE, ast.GtE,
)


def check_expression(text, *, allow_compare: bool = False) -> tuple[str | None, str | None]:
    """返回 (规范化后的表达式, 错误)。`^` 视为乘方。比较只允许 < > <= >=，相等请用 Eq()。"""
    if not isinstance(text, str) or not text.strip():
        return None, "empty"
    if len(text) > MAX_EXPR:
        return None, "too_long"
    text = text.strip().replace("^", "**")
    try:
        tree = ast.parse(text, mode="eval")
    except SyntaxError:
        return None, "syntax"
    nodes = list(ast.walk(tree))
    if len(nodes) > MAX_NODES:
        return None, "too_complex"
    for node in nodes:
        if not isinstance(node, _ALLOWED_NODES):
            return None, f"forbidden:{type(node).__name__}"
        if isinstance(node, ast.Compare) and not allow_compare:
            return None, "forbidden:Compare"
        if isinstance(node, ast.Call):
            if not isinstance(node.func, ast.Name) or node.func.id not in FUNC_NAMES or node.keywords:
                return None, "forbidden_call"
        elif isinstance(node, ast.Name) and not NAME_RE.fullmatch(node.id):
            return None, "bad_name"
        elif isinstance(node, ast.Constant):
            value = node.value
            if isinstance(value, bool) or not isinstance(value, (int, float)) or abs(value) > 1e12:
                return None, "bad_constant"
        elif isinstance(node, ast.BinOp) and isinstance(node.op, ast.Pow):
            exponent = node.right.operand if isinstance(node.right, ast.UnaryOp) else node.right
            if isinstance(exponent, ast.Constant) and isinstance(exponent.value, (int, float)) and abs(exponent.value) > MAX_EXPONENT:
                return None, "exponent_too_large"
            if isinstance(exponent, ast.BinOp) and isinstance(exponent.op, ast.Pow):
                return None, "nested_power"  # 9**9**9 这类塔式乘方会让 sympy 算到超时
    return text, None


# ============================================================ sympy 子进程

SYMPY_SCRIPT = r'''
import json, sys

def main():
    spec = json.load(sys.stdin)
    import sympy as sp
    from sympy.parsing.sympy_parser import parse_expr, standard_transformations
    G = {"__builtins__": {}, "Symbol": sp.Symbol, "Integer": sp.Integer, "Float": sp.Float, "Rational": sp.Rational,
         "sqrt": sp.sqrt, "cbrt": sp.cbrt, "exp": sp.exp, "log": sp.log, "ln": sp.log, "sin": sp.sin, "cos": sp.cos,
         "tan": sp.tan, "cot": sp.cot, "sec": sp.sec, "csc": sp.csc, "asin": sp.asin, "acos": sp.acos, "atan": sp.atan,
         "sinh": sp.sinh, "cosh": sp.cosh, "tanh": sp.tanh, "Abs": sp.Abs, "factorial": sp.factorial,
         "binomial": sp.binomial, "floor": sp.floor, "ceiling": sp.ceiling, "Min": sp.Min, "Max": sp.Max,
         "integrate": sp.Integral, "diff": sp.Derivative, "limit": sp.limit, "Sum": sp.Sum, "Eq": sp.Eq, "Ne": sp.Ne,
         "pi": sp.pi, "E": sp.E, "oo": sp.oo}
    unevaluated = (sp.Integral, sp.Derivative, sp.Sum, sp.Limit)

    def parse(text, ns):
        return parse_expr(text, local_dict=dict(ns), global_dict=G, transformations=standard_transformations)

    def number(expr):
        value = None
        for make in (lambda: expr.doit(), lambda: expr):
            try:
                value = sp.N(make(), 30)
            except Exception:
                value = None
                continue
            if not value.free_symbols and not value.has(*unevaluated):
                break
            value = None
        if value is None:
            raise ValueError("not_number")
        if value.has(sp.nan, sp.zoo, sp.oo, -sp.oo):
            raise ValueError("ill_defined")  # 分母为零、积分发散、极限不存在等
        real, imag = value.as_real_imag()
        if abs(imag) > 1e-12:
            raise ValueError("not_real")
        return real

    errors, ns = [], {}
    for name, text in spec["parameters"].items():
        value = parse(text, {})
        if value.free_symbols:
            errors.append("parameter_not_numeric:" + name)
        ns[name] = value
    for text in spec["constraints"]:
        result = parse(text, ns)
        if not (result is sp.true or result is True):
            errors.append("constraint_failed:" + text[:60])
    try:
        answer = number(parse(spec["answer"], ns))
    except ValueError as exc:
        errors.append("answer_" + str(exc))
        answer = None
    values = []
    for index, text in enumerate(spec["options"]):
        try:
            values.append(number(parse(text, ns)))
        except ValueError as exc:
            errors.append("option_%d_%s" % (index, exc))
            values.append(None)

    def same(a, b):
        return bool(abs(a - b) <= 1e-9 * max(1, abs(a), abs(b)))

    if answer is not None and None not in values:
        matches = [i for i, v in enumerate(values) if same(v, answer)]
        if not matches:
            errors.append("no_option_matches_answer")
        elif len(matches) > 1:
            errors.append("multiple_correct_options")
        elif matches[0] != spec["answer_index"]:
            errors.append("answer_index_mismatch:%d" % matches[0])
        if any(same(values[i], values[j]) for i in range(len(values)) for j in range(i + 1, len(values))):
            errors.append("duplicate_option_values")
    print(json.dumps({"ok": not errors, "errors": errors,
                      "answer": None if answer is None else str(sp.N(answer, 12)),
                      "option_values": [None if v is None else str(sp.N(v, 12)) for v in values]}))

try:
    main()
except Exception as exc:
    print(json.dumps({"ok": False, "errors": ["eval_error:" + type(exc).__name__]}))
'''


def run_sympy(spec: dict, timeout: float = SYMPY_TIMEOUT) -> dict:
    """在隔离子进程里计算。打包成桌面程序（PyInstaller）后没有可用的解释器，直接报不可用，不退回进程内执行。"""
    if getattr(sys, "frozen", False):
        return {"ok": False, "errors": ["sandbox_unavailable"]}
    try:
        done = subprocess.run(
            [sys.executable, "-I", "-c", SYMPY_SCRIPT], input=json.dumps(spec), capture_output=True,
            text=True, encoding="utf-8", timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return {"ok": False, "errors": ["timeout"]}
    except OSError:
        return {"ok": False, "errors": ["sandbox_unavailable"]}
    try:
        result = json.loads(done.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        return {"ok": False, "errors": ["eval_crashed"]}
    return result if isinstance(result, dict) else {"ok": False, "errors": ["eval_crashed"]}


# ============================================================ verify_problem_variant 工具

class VariantCheck(BaseModel):
    model_config = {"extra": "ignore"}

    parameters: dict[str, str] = Field(default_factory=dict)
    constraints: list[str] = Field(default_factory=list, max_length=8)
    answer: str
    options: list[str] = Field(min_length=2, max_length=6)

    @field_validator("parameters", mode="before")
    @classmethod
    def _params(cls, value):
        if not isinstance(value, dict):
            return {}
        return {str(k): str(v) for k, v in list(value.items())[:10]}

    @field_validator("answer", mode="before")
    @classmethod
    def _answer(cls, value):
        return str(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else value

    @field_validator("options", mode="before")
    @classmethod
    def _options(cls, value):
        if not isinstance(value, list):
            return value
        return [str(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else v for v in value]


class VerifyVariantInput(BaseModel):
    model_config = {"extra": "ignore"}

    base_candidate_id: str = Field(min_length=1, max_length=40)
    level: Literal["L0", "L1", "L2"]
    question: str = Field(min_length=4, max_length=1500)
    options: list[str] = Field(min_length=2, max_length=6)
    answer_index: int
    explanation: str = Field(default="", max_length=1500)
    adaptation_note: str | None = Field(default=None, max_length=200)
    target_misconceptions: list[str] = Field(default_factory=list, max_length=3)
    option_misconceptions: list[str | None] | None = None
    check: VariantCheck


_VARIANTS: dict[str, tuple[float, dict]] = {}
_ATTEMPTS: dict[str, tuple[float, int]] = {}


def lookup_variant(variant_id: str) -> dict | None:
    variant = ps._recall(_VARIANTS, variant_id)
    return dict(variant) if variant else None


def clear_state() -> None:
    _VARIANTS.clear()
    _ATTEMPTS.clear()


def _same_text(a, b) -> bool:
    return isinstance(a, str) and isinstance(b, str) and ps._normalize_for_fp(a) == ps._normalize_for_fp(b)


def _structural_errors(inp: VerifyVariantInput, candidate: dict) -> list[str]:
    errors = []
    if not 0 <= inp.answer_index < len(inp.options):
        errors.append("answer_index_out_of_range")
    if len(inp.check.options) != len(inp.options):
        errors.append("check_options_count_mismatch")
    if len({ps._normalize_for_fp(o) for o in inp.options}) != len(inp.options):
        errors.append("duplicate_options")
    if inp.option_misconceptions is not None and len(inp.option_misconceptions) != len(inp.options):
        errors.append("option_misconceptions_count_mismatch")
    if inp.level == "L0":
        # 原题直出只是配选项：题干必须包含原题题干
        if ps._normalize_for_fp(candidate["stem"]) not in ps._normalize_for_fp(inp.question):
            errors.append("L0_stem_altered")
    elif not (inp.adaptation_note or "").strip():
        errors.append("adaptation_note_required")
    for name in inp.check.parameters:
        if not NAME_RE.fullmatch(name) or name in RESERVED_NAMES:
            errors.append(f"bad_parameter_name:{name}")
    expressions = [("answer", inp.check.answer, False)]
    expressions += [(f"option_{i}", text, False) for i, text in enumerate(inp.check.options)]
    expressions += [(f"parameter_{name}", text, False) for name, text in inp.check.parameters.items()]
    expressions += [(f"constraint_{i}", text, True) for i, text in enumerate(inp.check.constraints)]
    for label, text, compare in expressions:
        _, error = check_expression(text, allow_compare=compare)
        if error:
            errors.append(f"{label}:{error}")
    return errors


async def verify_variant(arguments: dict, ctx=None) -> dict:
    inp = VerifyVariantInput.model_validate(arguments or {})
    candidate = ps.lookup_candidate(inp.base_candidate_id)
    if candidate is None:
        return {"ok": False, "errors": ["unknown_candidate"],
                "note": "base_candidate_id 必须来自本轮 search_good_problems 的结果。"}
    fallback = "original" if candidate.get("answer_index") is not None else "skip"
    key = f"{getattr(ctx, 'conversation_id', '')}:{inp.base_candidate_id}"
    used = ps._recall(_ATTEMPTS, key) or 0
    if used >= MAX_ATTEMPTS:
        return {"ok": False, "errors": ["too_many_attempts"], "fallback": fallback,
                "note": "这道母题不再改编。fallback=original 时原题直出，fallback=skip 时换一道候选题。"}

    errors = _structural_errors(inp, candidate)
    computed = {}
    if not errors:
        spec = {
            "parameters": {k: check_expression(v)[0] for k, v in inp.check.parameters.items()},
            "constraints": [check_expression(c, allow_compare=True)[0] for c in inp.check.constraints],
            "answer": check_expression(inp.check.answer)[0],
            "options": [check_expression(o)[0] for o in inp.check.options],
            "answer_index": inp.answer_index,
        }
        computed = await asyncio.to_thread(run_sympy, spec)
        errors = list(computed.get("errors") or ([] if computed.get("ok") else ["eval_failed"]))

    if errors:
        used += 1
        ps._remember(_ATTEMPTS, key, used, VARIANT_TTL_SIZE)
        result = {"ok": False, "errors": errors[:8], "attempts_left": max(0, MAX_ATTEMPTS - used)}
        if used >= MAX_ATTEMPTS:
            result["fallback"] = fallback
        return result

    variant_id = "var_" + hashlib.sha256(json.dumps(
        [inp.base_candidate_id, inp.question, inp.options, inp.answer_index], ensure_ascii=False,
    ).encode()).hexdigest()[:16]
    ps._remember(_VARIANTS, variant_id, {
        "variant_id": variant_id, "base_candidate_id": inp.base_candidate_id, "level": inp.level,
        "question": inp.question, "options": inp.options, "answer_index": inp.answer_index,
        "explanation": inp.explanation, "adaptation_note": (inp.adaptation_note or "").strip() or None,
        "target_misconceptions": inp.target_misconceptions, "option_misconceptions": inp.option_misconceptions,
        "computed_answer": computed.get("answer"),
    }, VARIANT_TTL_SIZE)
    return {"ok": True, "variant_id": variant_id, "computed_answer": computed.get("answer"),
            "note": f"在回复里单独一行写 [[quiz:{variant_id}]]，系统会生成测验卡。"}


async def run_verify(arguments: dict, ctx) -> str:
    """工具入口：永远返回 JSON 文本，不向外抛异常（原因同 problem_search.run）。"""
    try:
        result = await verify_variant(arguments, ctx)
    except ValidationError as exc:
        fields = ", ".join(".".join(str(p) for p in error["loc"]) for error in exc.errors()[:6]) or "参数"
        result = {"ok": False, "errors": [f"invalid_arguments:{fields}"]}
    except Exception:
        ps.logger.exception("verify_problem_variant failed")
        result = {"ok": False, "errors": ["internal_error"]}
    return json.dumps(result, ensure_ascii=False)


VERIFY_DEFINITION = {
    "type": "function",
    "function": {
        "name": VERIFY_TOOL,
        "description": (
            "用 sympy 校验一道基于 search_good_problems 候选题的改编题（L1 换数值、L2 改设问），"
            "或给计算/填空原题配的选项（L0）。检查约束是否成立、答案是否良定义、是否恰有一个正确选项。"
            "通过后返回 variant_id，出题时写入 micro_quiz 的 meta.variant_id；未通过的题不得输出。"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "base_candidate_id": {"type": "string", "description": "母题的 candidate_id"},
                "level": {"type": "string", "enum": ["L0", "L1", "L2"]},
                "question": {"type": "string", "description": "将显示给用户的题干"},
                "options": {"type": "array", "minItems": 2, "maxItems": 6, "items": {"type": "string"}},
                "answer_index": {"type": "integer", "description": "正确选项下标，从 0 开始"},
                "explanation": {"type": "string"},
                "adaptation_note": {"type": "string", "description": "改了什么、针对哪个误区；L1/L2 必填"},
                "target_misconceptions": {"type": "array", "maxItems": 3, "items": {"type": "string"}},
                "option_misconceptions": {"type": "array", "items": {"type": ["string", "null"]},
                                          "description": "与 options 等长，错误选项对应的误区 id，正确项填 null"},
                "check": {
                    "type": "object",
                    "description": "sympy 可计算的规格。用 ** 或 ^ 表示乘方，积分写 integrate(f, (x, a, b))，相等用 Eq(a, b)",
                    "properties": {
                        "parameters": {"type": "object", "additionalProperties": {"type": "string"},
                                       "description": "参数名到数值表达式，如 {\"a\": \"9\"}"},
                        "constraints": {"type": "array", "items": {"type": "string"},
                                        "description": "题目隐含的条件，如 \"b**2-4*c > 0\""},
                        "answer": {"type": "string", "description": "正确答案的表达式"},
                        "options": {"type": "array", "items": {"type": "string"}, "description": "每个选项的数值表达式，顺序与 options 一致"},
                    },
                    "required": ["answer", "options"],
                    "additionalProperties": False,
                },
            },
            "required": ["base_candidate_id", "level", "question", "options", "answer_index", "check"],
            "additionalProperties": False,
        },
    },
}


# ============================================================ 回复核对

BLOCKED_NOTE = "\n> 有一道题没能核对到可信来源或数值校验记录，已隐藏。\n"


def source_label(candidate: dict, kind: str) -> str:
    source = candidate["source"]
    if source.get("origin_type") == "讲义例题":
        text = f"讲义例题 · {source.get('title') or '课程讲义'}" + (f" 第{source['page']}页" if source.get("page") else "")
    elif candidate.get("exam_tag"):
        text = candidate["exam_tag"]
    else:
        text = f"{source.get('origin_type') or '经典母题'} · {source.get('site') or source.get('title') or '网页'}"
    return f"改编自 {text}" if kind == "adapted" else text


def _meta_source(candidate: dict, kind: str, variant: dict | None) -> dict:
    source = candidate["source"]
    return {
        "kind": kind, "origin_type": source.get("origin_type"), "label": source_label(candidate, kind)[:80],
        "title": source.get("title"), "site": source.get("site"), "url": source.get("url"),
        "retrieved_at": source.get("retrieved_at"),
        "adaptation_note": variant.get("adaptation_note") if variant and kind == "adapted" else None,
    }


def check_widget(widget: dict, allowed_misconceptions: set[str] | None = None) -> tuple[dict | None, str | None]:
    """核对一张 micro_quiz。通过时返回重写过 meta 的新微件，否则返回 (None, 原因)。"""
    question, options, index = widget.get("question"), widget.get("options"), widget.get("answerIndex")
    meta = widget.get("meta") or {}
    if not isinstance(question, str) or not isinstance(options, list) or not all(isinstance(o, str) for o in options) \
            or not isinstance(index, int) or isinstance(index, bool):
        return None, "malformed"
    candidate = ps.lookup_candidate(str(meta.get("candidate_id") or ""))
    if candidate is None:
        return None, "unknown_candidate"
    variant = None
    if meta.get("variant_id"):
        variant = lookup_variant(str(meta["variant_id"]))
        if variant is None or variant["base_candidate_id"] != candidate["candidate_id"]:
            return None, "unknown_variant"
        if not (_same_text(question, variant["question"]) and len(options) == len(variant["options"])
                and all(_same_text(a, b) for a, b in zip(options, variant["options"]))
                and index == variant["answer_index"]):
            return None, "altered"
        kind = "original" if variant["level"] == "L0" else "adapted"
    else:
        if not candidate.get("options") or candidate.get("answer_index") is None:
            return None, "needs_verification"  # 计算/填空原题配的选项没经过校验
        if ps._normalize_for_fp(candidate["stem"]) not in ps._normalize_for_fp(question) \
                or len(options) != len(candidate["options"]) \
                or not all(_same_text(a, b) for a, b in zip(options, candidate["options"])) \
                or index != candidate["answer_index"]:
            return None, "altered"
        kind = "original"
    if not 0 <= index < len(options):
        return None, "malformed"

    targets = variant["target_misconceptions"] if variant else meta.get("target_misconceptions") or []
    targets = [str(t) for t in targets if isinstance(t, str)]
    if allowed_misconceptions is not None:
        targets = [t for t in targets if t in allowed_misconceptions]
    new_meta = {
        "source": _meta_source(candidate, kind, variant),
        "candidate_id": candidate["candidate_id"],
        "pattern_id": candidate.get("pattern") or (str(meta.get("pattern_id"))[:60] if meta.get("pattern_id") else None),
        "knowledge_point": str(meta.get("knowledge_point") or (candidate.get("knowledge_points") or [""])[0])[:40],
        "fingerprint": candidate["fingerprint"],
        "target_misconceptions": targets[:3],
        "verified": True,
    }
    if variant:
        new_meta["variant_id"] = variant["variant_id"]
        if variant.get("option_misconceptions"):
            option_targets = variant["option_misconceptions"]
            if allowed_misconceptions is not None:
                option_targets = [t if t in allowed_misconceptions else None for t in option_targets]
            new_meta["option_misconceptions"] = option_targets
    explanation = widget.get("explanation") if isinstance(widget.get("explanation"), str) else ""
    if variant and variant.get("explanation"):
        explanation = variant["explanation"]
    return {"type": "micro_quiz", "question": question, "options": options, "answerIndex": index,
            "explanation": explanation, "meta": new_meta}, None


# 小模型偶尔把占位符包进 \[ \] 或 $$ $$，一并吃掉，否则展开后的代码块会落在公式环境里
PLACEHOLDER_RE = re.compile(
    r"(?:\\\[|\$\$)?\s*\[\[\s*quiz\s*[:：]\s*([A-Za-z0-9_]{1,40})\s*\]\]\s*(?:\\\]|\$\$)?"
)


def problem_text_block(candidate: dict) -> str:
    """计算/填空原题没有校验过的选项，做不成测验卡：按登记记录原文展示题干和来源，不给答案。"""
    kind = {"计算": "计算题", "填空": "填空题"}.get(candidate.get("type"), "原题")
    lines = [f"**原题（{kind}）** · {source_label(candidate, 'original')}"]
    lines += [line for line in candidate["stem"].splitlines() if line.strip()]
    url = candidate["source"].get("url")
    if url and not re.search(r"[\s<>]", url):
        lines.append(f"[查看原文](<{url}>)")
    return "\n\n" + "\n>\n".join("> " + line for line in lines) + "\n\n"


def quiz_from_id(quiz_id: str, allowed_misconceptions: set[str] | None = None) -> tuple[dict | None, str | None]:
    """[[quiz:id]] 占位符 → 测验卡。题干、选项、答案全部取自登记记录，模型只负责挑题。

    小模型抄写长 JSON 时经常转义错、改选项、漏 meta，让服务端生成比事后核对可靠得多。
    生成结果再过一遍 check_widget，来源和误区的处理与模型手写的微件完全一致。
    """
    if quiz_id.startswith("var_"):
        variant = lookup_variant(quiz_id)
        if variant is None:
            return None, "unknown_variant"
        widget = {"type": "micro_quiz", "question": variant["question"], "options": variant["options"],
                  "answerIndex": variant["answer_index"], "explanation": variant.get("explanation") or "",
                  "meta": {"candidate_id": variant["base_candidate_id"], "variant_id": quiz_id}}
    else:
        candidate = ps.lookup_candidate(quiz_id)
        if candidate is None:
            return None, "unknown_candidate"
        if not candidate.get("options") or candidate.get("answer_index") is None:
            return None, "needs_verification"  # 计算/填空题要先用 verify_problem_variant 配选项
        widget = {"type": "micro_quiz", "question": candidate["stem"], "options": candidate["options"],
                  "answerIndex": candidate["answer_index"], "explanation": candidate["solution"][:600],
                  "meta": {"candidate_id": quiz_id}}
    return check_widget(widget, allowed_misconceptions)


ASK_SPECIFIC_NOTE = ("想练哪个具体的知识点？说得具体一点（比如「定积分换元法」而不是「微积分」），"
                     "我再去找可溯源的真题和母题。")


def guard_reply(text: str, tool_log: list[dict] | None = None, *, require_source: bool | None = None,
                allowed_misconceptions=None, drill_active: bool = False,
                first_turn: bool = False, viva_answers: list[str] | None = None) -> tuple[str, dict]:
    """回复生成后调用。返回 (核对后的回复, 报告)。

    require_source 为 None 时自动判断：本轮调用过搜题或校验工具，就要求每张 micro_quiz 都能溯源；
    否则只核对自带 candidate_id 的微件，其他技能生成的普通 micro_quiz 原样保留，保持向后兼容。
    viva_answers 是本场模拟复试的回答原文，用于核对 viva_radar 的引用；不传时取本次生成里
    select_skill_prompt 记下的复试状态，都没有时 viva_radar 的引用一律视为无法核实。
    """
    from app.chat.skills.viva_skill import current_turn, guard_viva_radar

    if viva_answers is None:
        turn = current_turn()
        viva_answers = turn["answers"] if turn else []
    text, viva_report = guard_viva_radar(text, viva_answers)
    used = any(isinstance(call, dict) and call.get("name") in DRILL_TOOLS for call in tool_log or [])
    searched = any(isinstance(call, dict) and call.get("name") == SEARCH_TOOL for call in tool_log or [])
    # drill_active：用户本轮在要题（服务端判断）。即使模型没调用工具，也按出题轮核对，防止它自己编题
    require = (used or drill_active) if require_source is None else require_source
    allowed = set(allowed_misconceptions) if allowed_misconceptions is not None else None
    report = {"checked": 0, "kept": 0, "blocked": []}
    if viva_report:
        report["viva_radar"] = viva_report
    # 服务端生成的内容（测验卡、原文题块、隐藏提示）先换成占位 token，清理正文时不会误伤，最后再换回来
    blocks: list[str] = []
    rendered: set[str] = set()  # 本轮已经展示过的候选题 id

    def stash(content: str) -> str:
        blocks.append(content)
        return f"\x00{len(blocks) - 1}\x00"

    def render_candidate(candidate: dict) -> str:
        """正文里复述了某道候选题：换成按登记记录生成的标准展示，同一道题只展示一次。"""
        candidate_id = candidate["candidate_id"]
        if candidate_id in rendered:
            return ""
        rendered.add(candidate_id)
        report["restated"] = report.get("restated", 0) + 1
        if candidate.get("answer_index") is not None:
            fixed, _ = quiz_from_id(candidate_id, allowed)
            if fixed is not None:
                report["kept"] += 1
                return stash("\n```knowgap-widget\n" + json.dumps(fixed, ensure_ascii=False) + "\n```\n")
        report["text_problems"] = report.get("text_problems", 0) + 1
        return stash(problem_text_block(candidate))

    def replace(match):
        try:
            widget = json.loads(match.group(1))
        except ValueError:
            # 小模型常把 JSON 写坏（转义引号、LaTeX 反斜杠），前端会一直显示骨架屏。出题轮里直接隐藏
            if require and "micro_quiz" in match.group(1):
                report["checked"] += 1
                report["blocked"].append("invalid_json")
                return stash(BLOCKED_NOTE)
            return match.group(0)
        if not isinstance(widget, dict) or widget.get("type") != "micro_quiz":
            return match.group(0)
        meta = widget.get("meta")
        has_source = isinstance(meta, dict) and bool(meta.get("candidate_id"))
        if not has_source and not require:
            return match.group(0)
        report["checked"] += 1
        fixed, reason = check_widget(widget, allowed) if has_source else (None, "no_source")
        if fixed is not None:
            report["kept"] += 1
            rendered.add(fixed["meta"]["candidate_id"])
            return stash("```knowgap-widget\n" + json.dumps(fixed, ensure_ascii=False) + "\n```")
        report["blocked"].append(reason)
        return stash(BLOCKED_NOTE)

    def expand(match):
        report["checked"] += 1
        fixed, reason = quiz_from_id(match.group(1), allowed)
        if fixed is None and reason == "needs_verification":
            # 计算/填空原题来源可查，只是没有校验过的选项：展示原文题干，不算拦截
            report["text_problems"] = report.get("text_problems", 0) + 1
            rendered.add(match.group(1))
            return stash(problem_text_block(ps.lookup_candidate(match.group(1))))
        if fixed is None:
            report["blocked"].append(reason)
            return stash(BLOCKED_NOTE)
        report["kept"] += 1
        rendered.add(fixed["meta"]["candidate_id"])
        # 前后补换行：代码围栏必须独占一行，占位符可能写在句子中间
        return stash("\n```knowgap-widget\n" + json.dumps(fixed, ensure_ascii=False) + "\n```\n")

    text = WIDGET_RE.sub(replace, text or "")
    text = PLACEHOLDER_RE.sub(expand, text)
    if require:
        text = TOOL_TAG_RE.sub("", text)  # qwen 等模型偶尔把模板里的工具标签漏进正文
        text = THINKING_TAG_RE.sub("", text)
        text = _scrub_prose(text, _turn_candidates(tool_log), render_candidate, report, first_turn)
        text = DISPLAY_WRAP_RE.sub(lambda m: m.group(1).rstrip("\n"), text)
    text = TOKEN_RE.sub(lambda m: blocks[int(m.group(0)[1:-1])], text)
    # 只在没有任何测验卡、也没有被拦截的题时补；被拦截的保留隐藏提示，不悄悄换成别的题
    if require and report["kept"] == 0 and not report["blocked"]:
        text = _append_found_quizzes(text, tool_log, allowed, report, rendered)
    if drill_active and not searched and (
        report["blocked"] or (not re.search(r"[？?]", text) and len(text.strip()) < 160)
    ):
        # 用户在要题、本轮没检索（知识点太宽，服务端没代为搜题），模型却：
        # - 出了题：题一定是编的，周围的正文（「这是例1的改编题」）也不可信；或
        # - 既没出题也没追问（「好的，我们来出几道题…」然后结束）：用户什么都拿不到。
        # 两种都整条换成追问，让用户给出具体知识点
        report["replaced"] = "ask_specific"
        return ASK_SPECIFIC_NOTE, report
    if require:
        text = re.sub(r"\n{3,}", "\n\n", text)  # 删行、展开占位符后留下的多余空行
    return text, report


TOOL_TAG_RE = re.compile(r"</?tool_call>")
TOKEN_RE = re.compile(r"\x00\d+\x00")
AUTO_QUIZ_LEAD = "\n\n下面是检索到的原题，可以直接点选作答："
RESTATED_STEM = 0.6  # 某行包含候选题题干 3-gram 的比例达到这个值，就视为在复述这道题

# 带标签的答案/解析行：「答案：」「**解析**：」「- 正确答案：」
ANSWER_LINE_RE = re.compile(
    r"^\s*(?:[-*•]\s*|\d+[.、)）]\s*)?(?:\*\*)?\s*"
    r"(?:正确答案|参考答案|标准答案|最终答案|答案|解析|详解|详细解答|解答)\s*(?:\*\*)?\s*[:：]"
)
OPTION_LINE_RE = re.compile(r"^\s*(?:[-*•]\s*)?(?:\*\*)?\s*(?:选项\s*(?:\*\*)?\s*[:：]|[（(]?[A-F]\s*[)）.．、:：])")
# 句子级：直接点破选项、提工具名或描述调用过程、模板里漏出来的英文元叙述
CHOICE_LEAK_RE = re.compile(r"(?:故选|应选|正确选项(?:是|为)?|答案(?:是|为|应为|选))\s*[：:]?\s*[（(]?\s*[A-F](?![A-Za-z])")
TOOL_MENTION_RE = re.compile(
    r"search_good_problems|verify_problem_variant|knowgap-widget|candidate_id|variant_id|tool_call"
    r"|previous context|past knowledge|调用[^。！？\n]{0,8}?(?:工具|函数)|系统会自动|占位符|单独一行|只写一行", re.I,
)
TITLE_NO_RE = re.compile(r"第\s*(\d+)\s*题")
# 第一轮对话里的「你之前提到」「按照之前的练习经验」一定是编的
HISTORY_CLAIM_RE = re.compile(
    r"(?:你|您)(?:之前|以前|上次|刚才)?(?:提到|说过|提过|提供的信息)|(?:之前|以前|上次)的(?:练习|对话|经验)|按照之前|根据之前"
)
THINKING_TAG_RE = re.compile(r"\[\s*(?:思考中|正在思考|thinking)[.…。]*\s*\]", re.I)
MD_LINK_RE = re.compile(r"!?\[([^\]]*)\]\(\s*<?([^)\s>]*)>?[^)]*\)")
EMPTY_BULLET_RE = re.compile(r"\s*(?:[-*•]|\d+[.、)）])?\s*[:：]?\s*")
# 「2023 年考研数学一」这类出处说法：年份必须出现在本轮候选题的 exam_tag 里
SOURCE_CLAIM_RE = re.compile(r"((?:19|20)\d{2})\s*年?[^\n。；;]{0,24}?(?:考研|高考|竞赛|联赛|统考|入学|数学[一二三])")
# 被替换掉的复述行如果原本包在多行公式环境里，连同 \[ \] 或 $$ 一起去掉
DISPLAY_WRAP_RE = re.compile(
    r"(?m)^[ \t]*(?:\\\[|\$\$)[ \t]*\n((?:[ \t]*\x00\d+\x00[ \t]*\n)+)[ \t]*(?:\\\]|\$\$)[ \t]*$"
)


def _bump(report: dict, key: str, amount: int = 1) -> None:
    report[key] = report.get(key, 0) + amount


def _turn_candidates(tool_log) -> list[dict]:
    """本轮 search_good_problems 返回过的候选题，字段以登记记录为准（工具输出可能被截短）。"""
    found, seen = [], set()
    for call in tool_log or []:
        if not isinstance(call, dict) or call.get("name") != SEARCH_TOOL:
            continue
        try:
            result = json.loads(call.get("output") or "")
        except ValueError:
            continue
        for item in (result.get("candidates") if isinstance(result, dict) else None) or []:
            candidate_id = item.get("candidate_id") if isinstance(item, dict) else None
            if candidate_id and candidate_id not in seen:
                candidate = ps.lookup_candidate(candidate_id)
                if candidate is not None:
                    seen.add(candidate_id)
                    found.append(candidate)
    return found


def _scrub_prose(text: str, candidates: list[dict], render, report: dict, first_turn: bool = False) -> str:
    """出题轮的正文清理。题目以测验卡和原文题块为准，正文只留引导语：

    - 复述某道候选题题干的行 → 换成这道题的标准展示（同一道题只展示一次，重复的直接删）
    - 带标签的答案/解析行、出现候选题答案值的行、复述选项的行 → 删除，避免作答前泄底或抄错数字
    - 提工具名、描述调用过程、点破选项、年份对不上的出处说法 → 按句删除

    代码围栏内的内容和服务端 token 不动。
    """
    backed_years = {y for c in candidates for y in re.findall(r"(?:19|20)\d{2}", c.get("exam_tag") or "")}
    answers = [a for a in (ps._normalize_for_fp(c.get("answer") or "") for c in candidates) if len(a) >= 3]
    options = [[o for o in (ps._normalize_for_fp(x) for x in c.get("options") or []) if len(o) >= 3]
               for c in candidates]

    backed_numbers = {n for c in candidates for n in TITLE_NO_RE.findall(c.get("exam_tag") or "")}
    backed_urls = {c["source"].get("url") for c in candidates if c.get("source", {}).get("url")}

    def bad_sentence(sentence: str) -> bool:
        if TOOL_MENTION_RE.search(sentence) or CHOICE_LEAK_RE.search(sentence):
            return True
        if first_turn and HISTORY_CLAIM_RE.search(sentence):
            return True
        claims = list(SOURCE_CLAIM_RE.finditer(sentence))
        if any(m.group(1) not in backed_years for m in claims):
            return True
        # 出处说法里的题号也要有据可查；不带出处的「第1题」只是序号，不管
        return bool(claims) and any(n not in backed_numbers for n in TITLE_NO_RE.findall(sentence))

    out: list[str] = []
    fenced = False
    for line in text.split("\n"):
        stripped = line.strip()
        if stripped.startswith("```"):
            fenced = not fenced
            out.append(line)
            continue
        if fenced or not stripped or TOKEN_RE.fullmatch(stripped):
            out.append(line)
            continue
        tokens = "".join(TOKEN_RE.findall(line))  # 删行时保留行内的服务端内容
        body = TOKEN_RE.sub("", line)
        parts = re.split(r"(?<=[。！？!?；;])", body)
        kept_parts = [part for part in parts if not bad_sentence(part)]
        changed = len(kept_parts) != len(parts)
        if changed:
            _bump(report, "sentences_removed", len(parts) - len(kept_parts))
            body = "".join(kept_parts)
        # 模型自己写的链接（如「[题目来源](讲义.md)」）：只保留指向本轮候选题原文的，其余删掉。
        # 服务端题块里的「查看原文」链接已经暂存成 token，不受影响
        linked = MD_LINK_RE.sub(lambda m: m.group(0) if m.group(2) in backed_urls else "", body)
        if linked != body:
            _bump(report, "links_removed")
            body, changed = linked, True
        if not body.strip() or EMPTY_BULLET_RE.fullmatch(body):
            if tokens:
                out.append(tokens)
            continue
        normalized = ps._normalize_for_fp(body)
        if ANSWER_LINE_RE.match(body) or any(answer in normalized for answer in answers):
            _bump(report, "answer_lines_removed")
            if tokens:
                out.append(tokens)
            continue
        grams = ps.shingles(body)
        restated = next((c for c in candidates if ps.containment(c["stem"], grams) >= RESTATED_STEM), None)
        if restated is not None:
            out.append(render(restated) + tokens)
            continue
        option_hits = max((sum(option in normalized for option in opts) for opts in options), default=0)
        # 带字母标号的选项行（「- D. 0」这种短选项匹配不到内容）：本轮有选择题时一律删，测验卡里已有选项
        lettered = bool(OPTION_LINE_RE.match(body)) and any(c.get("options") for c in candidates)
        if option_hits >= 2 or (option_hits >= 1 and OPTION_LINE_RE.match(body)) or lettered:
            _bump(report, "option_lines_removed")
            if tokens:
                out.append(tokens)
            continue
        out.append(body + tokens if changed else line)
    return re.sub(r"\n{3,}", "\n\n", "\n".join(out))


def _append_found_quizzes(text: str, tool_log, allowed, report: dict, rendered: set[str] | None = None,
                          limit: int = 3) -> str:
    """兜底：工具已经找到可直出的选择题，模型却没写占位符（只把题目抄成了文字）时，服务端补上测验卡。

    题目来自本轮工具输出里的 candidate_id，再经 quiz_from_id → check_widget 生成，与模型写占位符的结果一致。
    """
    ids = [c["candidate_id"] for c in _turn_candidates(tool_log)
           if c.get("quiz") and c["candidate_id"] not in (rendered or set())]
    cards = []
    for candidate_id in ids[:limit]:
        fixed, _ = quiz_from_id(candidate_id, allowed)
        if fixed is not None:
            cards.append("\n```knowgap-widget\n" + json.dumps(fixed, ensure_ascii=False) + "\n```\n")
    if not cards:
        return text
    report["auto_added"] = len(cards)
    return text.rstrip() + AUTO_QUIZ_LEAD + "".join(cards)


# 放在末尾是为了打破循环导入：app.agent_tools/__init__.py 在模块级读取本文件的 VERIFY_DEFINITION，
# 而导入 app.agent_tools.problem_search 会先执行那个 __init__.py。若本文件先被导入，
# 到这里时 VERIFY_DEFINITION 等已经定义好，__init__.py 拿到的半初始化模块也够用。
from app.agent_tools import problem_search as ps  # noqa: E402

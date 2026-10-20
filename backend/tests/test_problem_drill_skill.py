"""problem_drill 技能的单元测试：表达式白名单、sympy 校验、回复核对、「再来一道」消息。"""

import asyncio
import json
from types import SimpleNamespace

import pytest

from app.agent_tools import problem_search as ps
from app.chat.skills import _PRACTICE_RE
from app.chat.skills import problem_drill_skill as drill
from tests.test_problem_search import KP, PROBLEM_1, PROBLEM_2, page


@pytest.fixture(autouse=True)
def fresh_state():
    ps.clear_cache()
    drill.clear_state()
    yield
    ps.clear_cache()
    drill.clear_state()


def register(raw):
    candidate, reason = ps.build_candidate(raw, page(), KP, "2026-10-20")
    assert reason is None
    ps._remember(ps._REGISTRY, candidate["candidate_id"], candidate, ps.REGISTRY_SIZE)
    return ps.public_candidate(candidate)


def ctx(name="conv1"):
    return SimpleNamespace(conversation_id=name)


def widget_block(widget):
    return "```knowgap-widget\n" + json.dumps(widget, ensure_ascii=False) + "\n```"


def widgets_in(text):
    return [json.loads(m.group(1)) for m in drill.WIDGET_RE.finditer(text)]


# 把 ∫_0^4 改成 ∫_0^9 的 L1 改编：t=√x，原式 = 2[t - ln(1+t)]_0^3 = 6 - 2ln4
VARIANT_L1 = {
    "level": "L1",
    "question": "计算定积分 $\\int_0^9 \\frac{dx}{1+\\sqrt{x}}$。",
    "options": ["$6-2\\ln 4$", "$6-2\\ln 3$", "$6$", "$9-2\\ln 4$"],
    "answer_index": 0,
    "explanation": "令 $t=\\sqrt{x}$，积分限同步变为 $0\\to3$。",
    "adaptation_note": "上限 4 改为 9，针对「换元后未同步改积分限」",
    "target_misconceptions": ["mc_1"],
    "option_misconceptions": [None, "mc_1", None, "mc_1"],
    "check": {
        "parameters": {"a": "9"},
        "constraints": ["a > 0"],
        "answer": "integrate(1/(1+sqrt(x)), (x, 0, a))",
        "options": ["6-2*log(4)", "6-2*log(3)", "6", "9-2*log(4)"],
    },
}


# ------------------------------------------------------------ 表达式白名单

@pytest.mark.parametrize("text", [
    "__import__('os').system('dir')", "x.__class__", "(lambda: 1)()", "open('a')", "[1, 2]",
    "9**9**9", "2**100000", "'abc'", "x if 1 else 2", "sp.exp(1)", "integrate(x, x, conds='none')",
])
def test_expression_whitelist_rejects(text):
    assert drill.check_expression(text)[1] is not None


def test_expression_whitelist_accepts_and_converts_caret():
    assert drill.check_expression("integrate(1/(1+sqrt(x)), (x, 0, 4))") == ("integrate(1/(1+sqrt(x)), (x, 0, 4))", None)
    assert drill.check_expression("x^2 + 1")[0] == "x**2 + 1"
    assert drill.check_expression("b**2 - 4*c > 0")[1] == "forbidden:Compare"
    assert drill.check_expression("b**2 - 4*c > 0", allow_compare=True)[1] is None


# ------------------------------------------------------------ sympy 子进程

def spec(answer, options, answer_index=0, parameters=None, constraints=()):
    return {"parameters": parameters or {}, "constraints": list(constraints), "answer": answer,
            "options": options, "answer_index": answer_index}


def test_sympy_accepts_correct_variant():
    result = drill.run_sympy(spec("integrate(1/(1+sqrt(x)), (x, 0, a))", ["6-2*log(4)", "6-2*log(3)", "6"],
                                  parameters={"a": "9"}, constraints=["a > 0"]))
    assert result["ok"] is True, result
    assert result["answer"].startswith("3.227")


@pytest.mark.parametrize("case,error", [
    # 判别式为负却问两个实根：约束不成立
    (spec("-b/2", ["-1/2", "1/2"], parameters={"b": "1", "c": "1"}, constraints=["b**2 - 4*c > 0"]), "constraint_failed"),
    (spec("1/(a-1)", ["1", "2"], parameters={"a": "1"}), "answer_ill_defined"),
    (spec("integrate(1/x, (x, 0, 1))", ["1", "2"]), "answer_ill_defined"),          # 积分发散
    (spec("1", ["1", "2/2", "3"]), "multiple_correct_options"),
    (spec("2", ["1", "2", "3"], answer_index=0), "answer_index_mismatch:1"),
    (spec("5", ["1", "2"]), "no_option_matches_answer"),
    (spec("sqrt(-1)", ["1", "2"]), "answer_not_real"),
    (spec("1", ["1", "2", "2"]), "duplicate_option_values"),
])
def test_sympy_rejects_inconsistent_problems(case, error):
    result = drill.run_sympy(case)
    assert result["ok"] is False and any(e.startswith(error) for e in result["errors"]), result


# ------------------------------------------------------------ verify_problem_variant

def test_verify_registers_variant():
    base = register(PROBLEM_1)
    result = asyncio.run(drill.verify_variant({**VARIANT_L1, "base_candidate_id": base["candidate_id"]}, ctx()))
    assert result["ok"] is True and result["variant_id"].startswith("var_")
    stored = drill.lookup_variant(result["variant_id"])
    assert stored["base_candidate_id"] == base["candidate_id"] and stored["level"] == "L1"


def test_verify_rejects_unknown_candidate_and_bad_structure():
    unknown = asyncio.run(drill.verify_variant({**VARIANT_L1, "base_candidate_id": "cand_invented"}, ctx()))
    assert unknown == {"ok": False, "errors": ["unknown_candidate"], "note": unknown["note"]}

    base = register(PROBLEM_1)
    bad = asyncio.run(drill.verify_variant({
        **VARIANT_L1, "base_candidate_id": base["candidate_id"], "adaptation_note": None,
        "check": {**VARIANT_L1["check"], "parameters": {"pi": "3"}, "answer": "__import__('os')"},
    }, ctx()))
    assert bad["ok"] is False
    assert {"adaptation_note_required", "bad_parameter_name:pi"} <= set(bad["errors"])
    assert any(e.startswith("answer:") for e in bad["errors"])


def test_L0_must_keep_original_stem():
    base = register(PROBLEM_1)
    result = asyncio.run(drill.verify_variant({
        **VARIANT_L1, "level": "L0", "base_candidate_id": base["candidate_id"],
    }, ctx()))
    assert "L0_stem_altered" in result["errors"]


def test_attempt_limit_then_fallback():
    calc, choice = register(PROBLEM_1), register(PROBLEM_2)
    broken = {**VARIANT_L1, "adaptation_note": None}  # 结构错误，不会启动子进程
    results = [asyncio.run(drill.verify_variant({**broken, "base_candidate_id": calc["candidate_id"]}, ctx()))
               for _ in range(drill.MAX_ATTEMPTS + 1)]
    assert [r.get("attempts_left") for r in results[:3]] == [2, 1, 0]
    assert results[2]["fallback"] == "skip"  # 计算题没有现成选项，只能换题
    assert results[3]["errors"] == ["too_many_attempts"]
    other = asyncio.run(drill.verify_variant({**broken, "base_candidate_id": calc["candidate_id"]}, ctx("conv2")))
    assert other["attempts_left"] == 2  # 计数按对话隔离

    for _ in range(drill.MAX_ATTEMPTS):
        last = asyncio.run(drill.verify_variant({**broken, "base_candidate_id": choice["candidate_id"]}, ctx()))
    assert last["fallback"] == "original"  # 选择题可以原题直出


def test_run_verify_never_raises():
    assert json.loads(asyncio.run(drill.run_verify({}, ctx())))["errors"][0].startswith("invalid_arguments")
    assert json.loads(asyncio.run(drill.run_verify({**VARIANT_L1, "base_candidate_id": "x"}, ctx())))["errors"] == ["unknown_candidate"]


# ------------------------------------------------------------ 回复核对

def original_choice_widget(candidate, **changes):
    widget = {
        "type": "micro_quiz", "question": candidate["stem"], "options": list(candidate["options"]),
        "answerIndex": candidate["answer_index"], "explanation": "令 u=1-x。",
        "meta": {"candidate_id": candidate["candidate_id"], "pattern_id": candidate["pattern"],
                 "knowledge_point": KP, "fingerprint": candidate["fingerprint"],
                 # 模型自己编的出处，应被服务端记录覆盖
                 "source": {"label": "2023 考研数学一 第5题", "url": "https://evil.example.com/"}},
    }
    widget.update(changes)
    return widget


def test_original_choice_kept_and_source_rewritten():
    candidate = register(PROBLEM_2)
    text = "先做这道：\n" + widget_block(original_choice_widget(candidate)) + "\n做完告诉我。"
    guarded, report = drill.guard_reply(text, [{"name": ps.TOOL_NAME}])
    assert report == {"checked": 1, "kept": 1, "blocked": []}
    assert guarded.startswith("先做这道：") and guarded.endswith("做完告诉我。")
    meta = widgets_in(guarded)[0]["meta"]
    assert meta["source"]["url"] == "https://math.a.edu.cn/kaoyan/2019"
    assert meta["source"]["kind"] == "original" and "2023" not in meta["source"]["label"]
    assert meta["verified"] is True and meta["fingerprint"] == candidate["fingerprint"]


@pytest.mark.parametrize("changes,reason", [
    ({"options": ["$\\int_0^1 f(x)dx$", "$-\\int_0^2 f(x)dx$", "$2\\int_0^1 f(x)dx$", "$0$"]}, "altered"),
    ({"answerIndex": 1}, "altered"),
    ({"question": "设 $f(x)$ 连续，则 $\\int_0^2 f(2-x)dx$ 等于（ ）"}, "altered"),
    ({"meta": {"candidate_id": "cand_invented"}}, "unknown_candidate"),
    ({"meta": {}}, "no_source"),
])
def test_untraceable_or_altered_widgets_blocked(changes, reason):
    candidate = register(PROBLEM_2)
    guarded, report = drill.guard_reply(widget_block(original_choice_widget(candidate, **changes)),
                                        [{"name": ps.TOOL_NAME}])
    assert report["blocked"] == [reason] and widgets_in(guarded) == []
    assert "已隐藏" in guarded


def test_calculation_problem_needs_verified_options():
    candidate = register(PROBLEM_1)
    widget = {"type": "micro_quiz", "question": candidate["stem"], "options": ["$4-2\\ln 3$", "$4$"], "answerIndex": 0,
              "meta": {"candidate_id": candidate["candidate_id"]}}
    _, report = drill.guard_reply(widget_block(widget), [{"name": ps.TOOL_NAME}])
    assert report["blocked"] == ["needs_verification"]


def test_verified_variant_kept_as_adapted():
    base = register(PROBLEM_1)
    verified = asyncio.run(drill.verify_variant({**VARIANT_L1, "base_candidate_id": base["candidate_id"]}, ctx()))
    widget = {"type": "micro_quiz", "question": VARIANT_L1["question"], "options": VARIANT_L1["options"],
              "answerIndex": 0, "explanation": "模型另写的解析",
              "meta": {"candidate_id": base["candidate_id"], "variant_id": verified["variant_id"],
                       "target_misconceptions": ["mc_1", "mc_other_user"]}}
    guarded, report = drill.guard_reply(widget_block(widget), [{"name": drill.VERIFY_TOOL}], allowed_misconceptions={"mc_1"})
    assert report["kept"] == 1
    meta = widgets_in(guarded)[0]["meta"]
    assert meta["source"]["kind"] == "adapted" and meta["source"]["label"] == "改编自 2019 考研数学一"
    assert meta["source"]["adaptation_note"] == VARIANT_L1["adaptation_note"]
    assert meta["target_misconceptions"] == ["mc_1"] and meta["option_misconceptions"] == [None, "mc_1", None, "mc_1"]
    assert widgets_in(guarded)[0]["explanation"] == VARIANT_L1["explanation"]

    tampered = dict(widget, options=["$6-2\\ln 5$", *VARIANT_L1["options"][1:]])
    _, report = drill.guard_reply(widget_block(tampered), [{"name": drill.VERIFY_TOOL}])
    assert report["blocked"] == ["altered"]


def test_other_skills_quiz_untouched():
    plain = {"type": "micro_quiz", "question": "栈的特点？", "options": ["LIFO", "FIFO"], "answerIndex": 0}
    text = "讲完了。\n" + widget_block(plain)
    assert drill.guard_reply(text, [{"name": "plan_steps"}]) == (text, {"checked": 0, "kept": 0, "blocked": []})
    other = widget_block({"type": "step_simulator", "title": "t", "steps": []})
    assert drill.guard_reply(other, [{"name": ps.TOOL_NAME}])[0] == other


# ------------------------------------------------------------ 误区与「再来一道」

def test_more_request_roundtrip_and_routing():
    message = drill.build_more_request(KP, "定积分换元-积分限同步变换", ["0123456789abcdef", "fedcba9876543210"])
    assert _PRACTICE_RE.search(message)  # 能进入练习技能
    assert drill.parse_more_request(message) == {
        "knowledge_point": KP, "pattern": "定积分换元-积分限同步变换",
        "exclude_fingerprints": ["0123456789abcdef", "fedcba9876543210"],
    }
    assert drill.parse_more_request("再来一道") is None


def test_unresolved_misconceptions_and_hints():
    def memory(id, kind, status, summary):
        return SimpleNamespace(id=id, kind=kind, status=status, topic=KP, summary=summary)
    memories = [(memory("p1", "preference", "confirmed", "喜欢先看例子"), "global"),
                (memory("m1", "misconception", "suspected", "认为换元后积分限不用改"), "subject"),
                (memory("m2", "misconception", "resolved", "已经解决的"), "subject"),
                (memory("m3", "mastery", "confirmed", "会了"), "subject")]
    items = drill.unresolved_misconceptions(memories)
    assert [item["id"] for item in items] == ["m1"]
    assert drill.misconception_hints(items) == ["换元后积分限不用改"]


def test_shown_fingerprints_from_history():
    history = [widget_block({"type": "micro_quiz", "meta": {"fingerprint": "0123456789abcdef"}}),
               "```knowgap-widget\n{bad json\n```",
               widget_block({"type": "micro_quiz", "meta": {"fingerprint": "0123456789abcdef"}})]
    assert drill.shown_fingerprints(history) == ["0123456789abcdef"]


def test_placeholder_expands_to_sourced_quiz():
    candidate = register(PROBLEM_2)
    text = f"先做这道：[[quiz:{candidate['candidate_id']}]] 做完告诉我。"
    guarded, report = drill.guard_reply(text, [{"name": ps.TOOL_NAME}])
    assert report == {"checked": 1, "kept": 1, "blocked": []}
    [quiz] = widgets_in(guarded)
    assert quiz["question"] == candidate["stem"] and quiz["options"] == candidate["options"]
    assert quiz["answerIndex"] == candidate["answer_index"] and quiz["meta"]["verified"] is True
    assert quiz["meta"]["source"]["url"] == "https://math.a.edu.cn/kaoyan/2019"
    assert "[[quiz:" not in guarded and guarded.startswith("先做这道：") and guarded.endswith("做完告诉我。")


def test_placeholder_for_variant_and_bad_ids():
    calc = register(PROBLEM_1)
    verified = asyncio.run(drill.verify_variant({**VARIANT_L1, "base_candidate_id": calc["candidate_id"]}, ctx()))
    guarded, report = drill.guard_reply(f"[[quiz:{verified['variant_id']}]]", [{"name": drill.VERIFY_TOOL}])
    assert report["kept"] == 1 and widgets_in(guarded)[0]["meta"]["source"]["kind"] == "adapted"

    text = f"[[quiz:{calc['candidate_id']}]]\n[[quiz:cand_invented]]\n[[quiz：var_0000000000000000]]"
    guarded, report = drill.guard_reply(text, [{"name": ps.TOOL_NAME}])
    assert report["blocked"] == ["unknown_candidate", "unknown_variant"] and report["text_problems"] == 1
    assert widgets_in(guarded) == [] and guarded.count("已隐藏") == 2


def test_calculation_placeholder_shows_original_text_without_answer():
    calc = register(PROBLEM_1)
    guarded, report = drill.guard_reply(f"先算这道：\n\\[\n[[quiz:{calc['candidate_id']}]]\n\\]\n算完告诉我。",
                                        [{"name": ps.TOOL_NAME}])
    assert report == {"checked": 1, "kept": 0, "blocked": [], "text_problems": 1}
    assert "> **原题（计算题）** · 2019 考研数学一" in guarded and calc["stem"] in guarded
    assert "[查看原文](<https://math.a.edu.cn/kaoyan/2019>)" in guarded
    assert calc["answer"] not in guarded  # 不泄露答案
    assert "\\[" not in guarded and "\\]" not in guarded and "[[quiz" not in guarded


def test_broken_quiz_json_hidden_only_in_drill_turns():
    broken = '```knowgap-widget\n{\\"type\\":\\"micro_quiz\\",\\"question\\":\\"x\\"}\n```'
    guarded, report = drill.guard_reply(broken, [{"name": ps.TOOL_NAME}])
    assert report["blocked"] == ["invalid_json"] and "已隐藏" in guarded
    assert drill.guard_reply(broken, [])[0] == broken  # 其他技能的回复不动


def test_backslash_dropped_by_model_still_matches_source():
    pg = page()
    assert ps.containment("4-2ln 3", pg.shingles) == 1.0 and ps.digits_verbatim("4-2ln 3", pg.shingles)


def search_log(*candidates):
    output = json.dumps({"status": "ok", "candidates": [ps.public_candidate(c) for c in candidates]}, ensure_ascii=False)
    return [{"name": ps.TOOL_NAME, "output": output}]


def test_quiz_auto_added_when_model_only_writes_text():
    choice, calc = register(PROBLEM_2), register(PROBLEM_1)
    log = search_log(ps.lookup_candidate(choice["candidate_id"]), ps.lookup_candidate(calc["candidate_id"]))
    text = "找到了一道题：设 $f(x)$ 连续……请先自己想想。</tool_call>"
    guarded, report = drill.guard_reply(text, log)
    assert report["auto_added"] == 1  # 计算题没有校验过的选项，不补
    [quiz] = widgets_in(guarded)
    assert quiz["meta"]["candidate_id"] == choice["candidate_id"] and quiz["meta"]["verified"] is True
    assert "</tool_call>" not in guarded and guarded.startswith("找到了一道题")


def test_no_auto_add_when_model_already_made_a_quiz():
    choice = register(PROBLEM_2)
    log = search_log(ps.lookup_candidate(choice["candidate_id"]))
    guarded, report = drill.guard_reply(f"[[quiz:{choice['candidate_id']}]]", log)
    assert report["kept"] == 1 and "auto_added" not in report and len(widgets_in(guarded)) == 1


def test_restated_problems_replaced_and_answers_removed():
    choice, calc = register(PROBLEM_2), register(PROBLEM_1)
    log = search_log(ps.lookup_candidate(choice["candidate_id"]), ps.lookup_candidate(calc["candidate_id"]))
    # 本地 7B 模型的真实写法：把两道题连同答案、选项、解析都抄进正文
    text = "\n".join([
        "好的，我来找题。我将调用 `search_good_problems` 工具来查找相关题目。",
        "1. 计算定积分 \\(\\int_0^4 \\frac{dx}{1+\\sqrt{x}}\\)。",
        "   - 正确答案：\\(4-2\\ln 3\\)。",
        "2. 设 \\(f(x)\\) 连续，则 \\(\\int_0^1 f(1-x)dx\\) 等于（ ）。",
        "   - **选项**：A. \\(\\int_0^1 f(x)dx\\) B. \\(-\\int_0^1 f(x)dx\\) C. \\(2\\int_0^1 f(x)dx\\) D. \\(0\\)",
        "   - **答案**：A。",
        "   - **解析**：令 \\(u = 1 - x\\)，则 \\(dx = -du\\)，故选 A。",
        "这是 2023 年考研数学一的真题。做完告诉我你的答案。",
    ])
    guarded, report = drill.guard_reply(text, log)
    assert report["restated"] == 2 and report["kept"] == 1 and report["text_problems"] == 1
    assert "auto_added" not in report
    [quiz] = widgets_in(guarded)
    assert quiz["meta"]["candidate_id"] == choice["candidate_id"]
    assert guarded.count("> **原题（计算题）**") == 1
    prose = drill.WIDGET_RE.sub("", guarded)
    for leaked in ("search_good_problems", "正确答案", "**答案**", "**解析**", "**选项**", "4-2\\ln 3", "2023"):
        assert leaked not in prose, leaked
    assert prose.startswith("好的，我来找题。") and "做完告诉我你的答案。" in prose


def test_backed_source_claim_kept_and_display_wrapper_removed():
    calc = register(PROBLEM_1)
    log = search_log(ps.lookup_candidate(calc["candidate_id"]))
    text = "这道是 2019 年考研数学一的题。\n\\[\n\\int_0^4 \\frac{dx}{1+\\sqrt{x}}\n\\]\n试试看。"
    guarded, report = drill.guard_reply(text, log)
    assert guarded.startswith("这道是 2019 年考研数学一的题。")  # 年份与候选题 exam_tag 一致，保留
    assert "\\[" not in guarded and "\\]" not in guarded and "> **原题（计算题）**" in guarded
    assert report["restated"] == 1 and guarded.rstrip().endswith("试试看。")


def test_repeated_restatement_rendered_once():
    choice = register(PROBLEM_2)
    log = search_log(ps.lookup_candidate(choice["candidate_id"]))
    text = f"[[quiz:{choice['candidate_id']}]]\n再看一遍：设 $f(x)$ 连续，则 $\\int_0^1 f(1-x)dx$ 等于（ ）"
    guarded, report = drill.guard_reply(text, log)
    assert len(widgets_in(guarded)) == 1 and "再看一遍" not in guarded


def test_prose_untouched_outside_drill_turns():
    for text in ("答案：A", "这是 2023 年考研数学一的真题。", "我将调用工具查一下。"):
        assert drill.guard_reply(text, [])[0] == text


@pytest.mark.parametrize("text,expected", [
    ("找几道定积分换元法的好题练手", "定积分换元法"),
    ("出两道分部积分的练习题", "分部积分"),
    ("帮我找3道洛必达法则的真题", "洛必达法则"),
    ("来几道题考考我微积分", None),   # 知识点太宽，交给模型追问
    ("找几道微积分的题", None),
    ("栈和队列有什么区别", None),     # 不是要题
    ("来看看我的解答对不对", None),
])
def test_guess_knowledge_point(text, expected):
    assert drill.guess_knowledge_point(text) == expected


def test_drill_plan_routes_and_builds_forced_search():
    def memory(id, summary):
        return SimpleNamespace(id=id, kind="misconception", status="suspected", topic=KP, summary=summary)

    active, args = drill.drill_plan("chat", "找几道定积分换元法的好题练手",
                                    memories=[(memory("m1", "认为换元后积分限不用改"), "subject")])
    assert active and args == {"knowledge_point": "定积分换元法", "misconception_hints": ["换元后积分限不用改"]}

    assert drill.drill_plan("chat", "来几道题考考我微积分") == (True, None)
    assert drill.drill_plan("main", "找几道定积分换元法的好题练手") == (False, None)
    assert drill.drill_plan("chat", "栈和队列有什么区别") == (False, None)

    more = drill.build_more_request(KP, "定积分换元-积分限同步变换", ["0123456789abcdef"])
    history = [widget_block({"type": "micro_quiz", "meta": {"fingerprint": "fedcba9876543210"}})]
    active, args = drill.drill_plan("chat", more, history_texts=history)
    assert args["pattern"] == "定积分换元-积分限同步变换"
    assert args["exclude_fingerprints"] == ["0123456789abcdef", "fedcba9876543210"]


def test_unbacked_problem_number_removed():
    calc = register(PROBLEM_1)
    log = search_log(ps.lookup_candidate(calc["candidate_id"]))
    text = (f"[[quiz:{calc['candidate_id']}]]\n这道题来源于 2019 年考研数学一的第 17 题。"
            "先看第1题。系统会自动展示题目和来源信息。祝你练习愉快！")
    guarded, report = drill.guard_reply(text, log)
    prose = drill.WIDGET_RE.sub("", guarded)
    assert "第 17 题" not in prose and "系统会自动" not in prose  # 题号无据可查、元叙述
    assert "先看第1题。" in prose and "祝你练习愉快！" in prose  # 普通序号和引导语保留


def test_lettered_option_line_and_prompt_echo_removed():
    choice = register(PROBLEM_2)
    log = search_log(ps.lookup_candidate(choice["candidate_id"]))
    text = (f"[[quiz:{choice['candidate_id']}]]\n   - D. \\(0\\)\n"
            "注意每道题在回复中只写一行，例如这样：。\n请先思考并作答。")
    guarded, _ = drill.guard_reply(text, log)
    prose = drill.WIDGET_RE.sub("", guarded)
    assert "D." not in prose and "只写一行" not in prose and "请先思考并作答。" in prose


def test_restated_stem_with_header_now_replaced():
    choice = register({**PROBLEM_2, "stem": "2019 年全国硕士研究生入学统一考试 数学一 真题解析\n" + PROBLEM_2["stem"]})
    log = search_log(ps.lookup_candidate(choice["candidate_id"]))
    text = (f"1. [选择题] 设 $f(x)$ 连续，则 $\\int_0^1 f(1-x)dx$ 等于（ ）\n\n"
            f"[[quiz:{choice['candidate_id']}]]")
    guarded, _ = drill.guard_reply(text, log)
    assert len(widgets_in(guarded)) == 1 and "[选择题]" not in guarded


@pytest.mark.parametrize("text", [
    "好的，先做这道改编题：[[quiz:var_0000000000000000]] 请作答。",
    widget_block({"type": "micro_quiz", "question": "x", "options": ["a", "b"], "answerIndex": 0}),
])
def test_problem_without_search_replaced_by_follow_up(text):
    guarded, report = drill.guard_reply(text, [], drill_active=True)
    assert guarded == drill.ASK_SPECIFIC_NOTE and report["replaced"] == "ask_specific"


def test_broad_request_reply_without_question_replaced():
    # 本地 7B 模型的真实回复：没追问、没出题，还自己补了一个知识点
    text = "好的，我们将针对定积分换元法出几道练习题来帮助你练习。\n\n[思考中...]"
    guarded, report = drill.guard_reply(text, [], drill_active=True)
    assert guarded == drill.ASK_SPECIFIC_NOTE and report["replaced"] == "ask_specific"


def test_history_claims_removed_only_on_first_turn():
    choice = register(PROBLEM_2)
    log = search_log(ps.lookup_candidate(choice["candidate_id"]))
    text = f"根据你之前提到的重点，选了这道。[[quiz:{choice['candidate_id']}]]\n\n\n[思考中...]\n\n\n加油！"
    first, _ = drill.guard_reply(text, log, first_turn=True)
    later, _ = drill.guard_reply(text, log, first_turn=False)
    assert "之前提到" not in first and "之前提到" in later
    assert "思考中" not in first and "加油！" in first and len(widgets_in(first)) == 1
    assert "\n\n\n" not in first


def test_unbacked_links_removed_from_prose():
    calc = register(PROBLEM_1)
    log = search_log(ps.lookup_candidate(calc["candidate_id"]))
    text = (f"[[quiz:{calc['candidate_id']}]]\n   - [题目来源](定积分换元法讲义.md)\n"
            "详见[原文](https://math.a.edu.cn/kaoyan/2019)和[这里](https://evil.example.com/)。")
    guarded, report = drill.guard_reply(text, log)
    assert "定积分换元法讲义.md)" not in guarded and "evil.example.com" not in guarded
    assert "[原文](https://math.a.edu.cn/kaoyan/2019)" in guarded
    assert "[查看原文](<https://math.a.edu.cn/kaoyan/2019>)" in guarded  # 服务端题块里的链接不动
    assert report["links_removed"] == 2


def test_follow_up_question_without_search_untouched():
    text = "你想练哪个具体知识点？"
    assert drill.guard_reply(text, [], drill_active=True)[0] == text


def test_wants_problems():
    assert drill.wants_problems("来几道题考考我微积分")
    assert drill.wants_problems(drill.build_more_request(KP, None, []))
    assert not drill.wants_problems("来看看我的解答对不对")


def test_prompt_variants():
    assert "search_good_problems" in drill.PROBLEM_DRILL_SKILL and "report_progress" in drill.problem_drill_prompt("thread")
    assert drill._REPORT_STEP not in drill.problem_drill_prompt("chat")
    assert drill.VERIFY_DEFINITION["function"]["name"] == drill.VERIFY_TOOL

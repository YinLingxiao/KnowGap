"""viva_interview 模拟复试：触发识别、轮次计数、viva_radar 核对，以及走一遍真实聊天接口的 3 轮复试。"""

import json

import pytest
from fastapi.testclient import TestClient

from app.chat.skills import THREAD_SKILLS, recommend_widget, select_skill_prompt
from app.chat.skills import problem_drill_skill as drill
from app.chat.skills import viva_skill as viva
from app.main import create_app
from tests.test_acceptance_support import isolated_settings
from tests.test_chat import FakeChat, context_of, send


@pytest.fixture(autouse=True)
def fresh_turn():
    token = viva._VIVA_TURN.set(None)
    yield
    viva._VIVA_TURN.reset(token)


def block(widget):
    return "```knowgap-widget\n" + json.dumps(widget, ensure_ascii=False) + "\n```"


def radar_in(text):
    found = [json.loads(m.group(1)) for m in viva.WIDGET_RE.finditer(text)]
    return [w for w in found if w.get("type") == "viva_radar"]


ANSWERS = [
    "栈是一种后进先出的线性表，只能在栈顶插入和删除。",
    "栈空的时候再出栈就会下溢，我觉得返回空值就行。",
    "函数调用栈就是这个思想，递归太深会栈溢出，类似浏览器的后退按钮。",
]


# ============================================================ 触发与轮次

@pytest.mark.parametrize("text", [
    "来一场模拟复试吧", "帮我模拟面试一下数据结构", "我想试试压力面试", "你当我的复试官，问我栈",
    "开始模拟答辩", "viva on linked lists",
])
def test_trigger_phrases(text):
    assert viva.is_viva_trigger(text)
    assert viva.viva_progress([text]) == 0


@pytest.mark.parametrize("text", ["面试官一般问什么", "讲讲栈", "复试要准备什么材料", "考我一道栈的题"])
def test_non_triggers(text):
    assert viva.viva_progress([text]) is None


def test_progress_counts_answers_and_ends_after_final_report():
    texts = ["模拟复试：栈"]
    assert viva.viva_progress(texts) == 0
    for k, answer in enumerate(ANSWERS, start=1):
        texts.append(answer)
        assert viva.viva_progress(texts) == k
    assert viva.viva_answers(texts) == ANSWERS
    texts.append("谢谢面试官，我去复习边界条件")
    assert viva.viva_progress(texts) is None  # 总评已给出，会话回到普通聊天
    texts.append("再来一场模拟面试")
    assert viva.viva_progress(texts) == 0


def test_mentioning_mock_interview_mid_session_counts_as_an_answer_unless_restarting():
    texts = ["模拟面试", "栈是后进先出", "模拟面试时我会紧张，所以没说清楚"]
    assert viva.viva_progress(texts) == 2
    assert viva.viva_progress([*texts, "算了，重新开始模拟面试"]) == 0


def test_exit_stops_the_session():
    assert viva.viva_progress(["模拟复试", "栈是后进先出", "结束面试吧"]) is None
    assert viva.viva_progress(["模拟复试", "不知道，直接给答案"]) is None


# ============================================================ 技能挂载

def test_skill_prompt_per_round_for_chat_and_thread():
    texts = ["模拟复试：栈", *ANSWERS]
    for k in range(4):
        prompt = select_skill_prompt("chat", texts[k], earlier_user_texts=texts[:k])
        assert prompt.startswith("【当前挂载 Skill：viva_interview")
        if k < 3:
            assert f"给出第 {k + 1}/3 问" in prompt and "viva_radar" not in prompt.split("【本轮进度】")[1]
        else:
            assert "面试结束" in prompt and '"type":"viva_radar"' in prompt
    assert select_skill_prompt("thread", ANSWERS[0], earlier_user_texts=["模拟面试：栈"]).startswith(
        "【当前挂载 Skill：viva_interview")
    # main 只负责协调，不在主线里开面试
    assert select_skill_prompt("main", "模拟复试") is None


def test_viva_beats_feynman_and_practice_routes_and_does_not_stick_afterwards():
    # 「考官」「考我」本会路由到费曼 / 出题
    assert "viva_interview" in select_skill_prompt("chat", "模拟面试，你当考官考我栈")
    assert "viva_interview" in select_skill_prompt("chat", "出栈顺序的问题我觉得…", earlier_user_texts=["模拟面试"])
    # 复试结束后，开场里的「考官」不应把后续对话粘成费曼自测
    later = select_skill_prompt("chat", "为什么栈顶先出", earlier_user_texts=["模拟面试，你当考官", *ANSWERS])
    assert later != THREAD_SKILLS["feynman_challenge"].replace("，并调用 `report_progress` 回报掌握结论", "")


def test_widget_recommendation_only_on_final_round():
    assert "不嵌入任何微件" in recommend_widget("chat", "模拟复试：讲讲栈的原理", earlier_user_texts=[])
    assert "不嵌入任何微件" in recommend_widget("chat", ANSWERS[0], earlier_user_texts=["模拟复试"])
    assert recommend_widget("chat", ANSWERS[2], earlier_user_texts=["模拟复试", *ANSWERS[:2]]).startswith("viva_radar")
    # 不给 earlier_user_texts 时保持原有行为
    assert recommend_widget("chat", "对比一下栈和队列的区别").startswith("comparison_matrix")


def test_drill_plan_stands_down_during_viva():
    text = "考考我，出一道栈的题"
    assert drill.drill_plan("chat", text)[0] is True
    select_skill_prompt("chat", text, earlier_user_texts=["模拟复试"])
    assert drill.drill_plan("chat", text) == (False, None)
    # 状态只对计算它的那条消息生效
    assert drill.drill_plan("chat", "再出一道栈的题")[0] is True


# ============================================================ viva_radar 核对

def full_radar(**over):
    widget = {
        "type": "viva_radar", "title": "模拟复试 · 五维评估", "topic": "栈",
        "dimensions": [
            {"key": "concept", "score": 82, "quote": "后进先出的线性表", "reason": "定义准确。"},
            {"key": "boundary", "score": 140, "quote": "返回空值就行", "reason": "没有考虑下溢该如何报错。"},
            {"key": "derivation", "score": -5, "quote": "栈的时间复杂度是 O(n)", "reason": "推导缺失。"},
            {"key": "transfer", "score": "61分", "quote": "「类似浏览器的后退按钮」", "reason": "能迁移到实际场景。"},
            {"key": "expression", "score": 70, "quote": "栈空……就会下溢", "reason": "表达基本清楚。"},
        ],
        "verdict": "概念扎实，但你说“栈满了会自动扩容”，边界意识弱。",
        "suggestions": ["复习下溢与上溢的处理", "练习递归深度的推导", "多举反例", "第四条会被截掉"],
    }
    widget.update(over)
    return widget


def test_radar_scores_are_clamped_and_fake_quotes_removed():
    text, report = viva.guard_viva_radar("**复试 · 总评**\n" + block(full_radar()), ANSWERS)
    (radar,) = radar_in(text)
    dims = {d["key"]: d for d in radar["dimensions"]}
    assert [d["label"] for d in radar["dimensions"]] == [label for _, label in viva.DIMENSIONS]
    assert [dims[k]["score"] for k in ("concept", "boundary", "derivation", "transfer", "expression")] == [82, 100, 0, 61, 70]
    assert dims["concept"]["quote"] == "后进先出的线性表"
    assert dims["boundary"]["quote"] == "返回空值就行"
    assert dims["derivation"]["quote"] == ""          # 学生从没说过
    assert dims["transfer"]["quote"] == "类似浏览器的后退按钮"  # 外层引号去掉后逐字匹配
    assert dims["expression"]["quote"] == ""           # 省略号拼接不算原话
    assert "自动扩容" not in radar["verdict"] and radar["verdict"].startswith("概念扎实")
    assert radar["suggestions"] == ["复习下溢与上溢的处理", "练习递归深度的推导", "多举反例"]
    assert radar["overall"] == round((82 + 100 + 0 + 61 + 70) / 5)
    assert report["dropped_quotes"] == 2 and report["clamped"] == 2 and report["scrubbed"] == 1


def test_missing_fields_and_ten_point_scale_are_tolerated():
    widget = {"type": "viva_radar", "dimensions": [
        {"label": "概念准确度", "score": 8}, {"label": "表达条理性", "score": 6.5, "quote": "后进先出"},
    ]}
    text, report = viva.guard_viva_radar(block(widget), ANSWERS)
    (radar,) = radar_in(text)
    dims = {d["key"]: d for d in radar["dimensions"]}
    assert dims["concept"]["score"] == 80 and dims["expression"]["score"] == 65
    assert dims["expression"]["quote"] == "后进先出"
    assert dims["boundary"] == {"key": "boundary", "label": "边界严密性", "score": None, "quote": "", "reason": ""}
    assert radar["title"] == "模拟复试 · 五维评估" and radar["suggestions"] == [] and radar["verdict"] == ""
    assert radar["overall"] == 72 and report["missing"] == 3


def test_unkeyed_dimensions_in_order_and_only_one_radar_kept():
    dims = [{"score": s, "reason": "r"} for s in (90, 80, 70, 60, 50)]
    text, report = viva.guard_viva_radar(block({"type": "viva_radar", "dimensions": dims}) * 2, ANSWERS)
    (radar,) = radar_in(text)
    assert [d["score"] for d in radar["dimensions"]] == [90, 80, 70, 60, 50]
    assert report["duplicates"] == 1


def test_invalid_radar_json_is_replaced_and_other_widgets_untouched():
    quiz = block({"type": "micro_quiz", "question": "q", "options": ["a", "b"], "answerIndex": 0})
    broken = '```knowgap-widget\n{"type":"viva_radar","dimensions":[{"key":"concept",}]\n```'
    text, report = viva.guard_viva_radar(f"{quiz}\n{broken}", ANSWERS)
    assert quiz in text and "格式有误" in text and report == {"invalid": 1}
    assert viva.guard_viva_radar("普通回复", ANSWERS) == ("普通回复", {})


def test_without_known_answers_every_quote_is_dropped():
    text, _ = viva.guard_viva_radar(block(full_radar()), None)
    assert all(d["quote"] == "" for d in radar_in(text)[0]["dimensions"])


def test_guard_reply_uses_the_turn_state():
    select_skill_prompt("chat", ANSWERS[2], earlier_user_texts=["模拟复试", *ANSWERS[:2]])
    text, report = drill.guard_reply(block(full_radar()), [])
    dims = {d["key"]: d for d in radar_in(text)[0]["dimensions"]}
    assert dims["concept"]["quote"] == "后进先出的线性表" and report["viva_radar"]["kept"] == 1


# ============================================================ 走一遍聊天接口

FINAL_REPLY = "**复试 · 总评**\n整体不错。\n" + block(full_radar()) + "\n想针对边界再练练吗？"


def test_three_round_viva_through_the_chat_api(tmp_path):
    model = FakeChat([
        "**复试 · 第 1/3 问（概念）**\n请定义栈。",
        "**复试 · 第 2/3 问（边界）**\n栈空时出栈会怎样？",
        "**复试 · 第 3/3 问（迁移推导）**\n栈的思想还用在哪？",
        FINAL_REPLY,
        "好的。",
    ])
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=model)) as client:
        conversation_id = client.post("/api/conversations", json={}).json()["id"]
        turns = ["模拟复试：数据结构的栈，考考我", *ANSWERS, "谢谢，我想再问问别的"]
        for i, text in enumerate(turns):
            events = send(client, conversation_id, text, f"req-viva-{i:04d}")
            assert events[-2][0] == "done", events[-1]
        contexts = [context_of(call) for call in model.calls]
        for k in range(3):
            assert f"给出第 {k + 1}/3 问" in contexts[k]["active_skill"]
            assert "transfer_learning_hint" not in contexts[k]
        assert "面试结束" in contexts[3]["active_skill"]
        assert contexts[3]["recommended_widget"].startswith("viva_radar")
        assert not (contexts[4]["active_skill"] or "").startswith("【当前挂载 Skill：viva_interview")
        # 开场的「考考我」没有触发服务端代搜题
        assert all(call[-2]["role"] != "tool" for call in model.calls)

        stored = client.get(f"/api/conversations/{conversation_id}").json()["messages"][7]["content"]
        dims = {d["key"]: d for d in radar_in(stored)[0]["dimensions"]}
        assert dims["boundary"]["score"] == 100 and dims["derivation"]["quote"] == ""
        assert dims["concept"]["quote"] == "后进先出的线性表"

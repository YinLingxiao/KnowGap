"""Free chats are a general assistant: no keyword-mounted teaching flow, memory and widgets kept."""

from app.chat.agent import chat_messages, learning_context
from app.chat.prompts import CHAT_CONTEXT_PROMPT, CHAT_PROMPT, CHAT_ROLE_PROMPT
from app.chat.skills import THREAD_SKILLS, recommend_widget, select_skill_prompt
from app.chat.skills.file_skills import file_skill_prompt
from app.chat.skills.problem_drill_skill import drill_plan
from app.memory.curated import snapshot_text
from app.vision.pipeline import build_relay_prompt
from app.vision.routing import Route

ANCHORS = "先验技能：C语言、Java\n§\n讲解偏好：先举例"
# The extract-mode relay always ends with "…就讲解这道题的解题思路", which used to match the explain router.
RELAY = build_relay_prompt(
    marker=None, structured_problem="计算 ∫0^1 dx ∫x^√x (cos y / y) dy", question="直接告诉我这道题的答案",
    sections=["请依据上述条件回答学生的问题；如果学生没有提问，就讲解这道题的解题思路。"],
    relay_route=Route("high", "多步推导"), has_widget=False,
)


def build(content, role="chat", image_question=None, user=ANCHORS):
    rows = [{"role": "user", "content": content, "kind": "text", "status": "complete", "meta_json": "{}"}]
    role_info = {"role": role}
    return chat_messages(rows, [], None, [], conversation_role=role_info,
                         snapshot=snapshot_text({"user": user, "memory": ""}), image_question=image_question)


def test_chat_gets_general_assistant_prompt_without_learning_contract():
    system = build("你好")[0]["content"]
    assert system.startswith(CHAT_ROLE_PROMPT + "\n\n" + CHAT_CONTEXT_PROMPT)
    assert CHAT_PROMPT not in system
    assert "transfer_learning_hint" not in CHAT_CONTEXT_PROMPT and "available_exercises" not in CHAT_CONTEXT_PROMPT
    assert "不要为了考用户而设" in CHAT_CONTEXT_PROMPT  # the plan only tracks multi-step tasks here
    assert "延伸发问" in CHAT_ROLE_PROMPT and "不考用户的理解" in CHAT_ROLE_PROMPT
    assert "knowgap-widget" in system  # interactive cards stay available


def test_chat_keeps_memory_and_preferences_but_drops_teaching_fields():
    context = learning_context(build("我学过C语言，想学习Python的原理"))
    assert context["teaching_preferences"] == [{"source": "USER", "summary": "讲解偏好：先举例"}]
    assert "learner_memories" in context and "preference_evidence" in context
    for field in ("transfer_learning_hint", "prior_knowledge_anchors", "reported_prior_knowledge"):
        assert field not in context
    assert context["active_skill"] is None


def test_chat_never_mounts_keyword_teaching_skills():
    for text in ("为什么栈是后进先出的结构", "出几道链表题考考我", "我来讲给你听，你挑刺", "帮我整理一份讲义"):
        assert select_skill_prompt("chat", text) is None
        assert drill_plan("chat", text) == (False, None)
    assert select_skill_prompt("thread", "为什么栈是后进先出的结构") == THREAD_SKILLS["deep_explain"]


def test_chat_still_recommends_interactive_cards():
    assert recommend_widget("chat", "为什么快速排序要选基准") is not None
    assert recommend_widget("chat", "画个二叉树的遍历动画") is not None


def test_image_turn_routes_on_the_students_words_not_the_relay():
    context = learning_context(build(RELAY, image_question="直接告诉我这道题的答案"))
    assert context["latest_user_message"] == "直接告诉我这道题的答案"
    assert context["recommended_widget"] is None
    image_only = learning_context(build(RELAY, image_question=""))
    assert image_only["latest_user_message"] == RELAY


def test_pictured_problem_in_a_thread_skips_the_prior_knowledge_matrix():
    context = learning_context(build(RELAY, role="thread", image_question="讲讲这道题"))
    assert "transfer_learning_hint" not in context


def test_chat_file_rules_drop_guide_first_teaching():
    plain = file_skill_prompt("这份讲义第三页讲了什么", plain=True)
    assert "先引导" not in plain and "资料使用规则" in plain
    assert "file_export" in file_skill_prompt("把它做成 PPT", plain=True)
    assert "先引导" in file_skill_prompt("这份讲义第三页讲了什么")

"""Skills for free/parallel conversations (`chat`) and first-run Onboarding interview."""

ONBOARDING_TITLE = "初识引导 · 定制你的学习画像"

ONBOARDING_INTERVIEW_SKILL = """【Skill：初识引导（初次填充 USER / MEMORY）】
你正在和学习者进行首次破冰对话，目标是在 1～2 轮轻松交流内了解对方，并立即调用 `memory` 工具写入长期档案：
1. 写入 `target="user"`（按五层前缀规范，已有同项用 patch 或跳过，绝不编造用户没说的内容）：
   - 称呼：`[Identity] 称呼：...`（若 USER 快照已有且用户未要求改名，不要重复写）
   - 先验基础：`[Identity] 先验技能：...`、`[Identity] 常学领域：...`
   - 学习目标与约束：`[Context] 阶段目标：...`、`[Context] 背景约束：...`
   - 讲解与互动偏好：`[Preference] 讲解偏好：...`、`[Preference] 互动偏好：...`
2. 写入 `target="memory"`（仅在用户明确提到本地资料目录、学习环境、常用工具或工作约定等环境事实时写入，如 `[Experience] 经验法则：...` 或资料位置；没提到就不要写，禁止编造）。
3. 风格与收尾：
   - 语气自然亲切、简短不冗长，不要像问卷审讯。
   - 若用户已说出核心信息（在学内容、基础或偏好），先调用 `memory` 落盘，再简短复述记住的要点并直接衔接到对方想学的第一个问题或建议建一个学习空间。
   - 若用户只打了招呼没给信息，轻声追问一次即可，不要连续盘问。
   - 本阶段不要强行输出微件卡片或学习计划。"""


def onboarding_greeting(display_name: str = "") -> str:
    name = (display_name or "").strip()
    hello = f"你好，{name}！" if name and name not in {"学习者", "演示学习者"} else "你好！"
    return (
        f"{hello}我是 KnowGap，以后会陪你一起学。先花 1 分钟互相认识一下，我会把你的情况记进长期记忆里，方便后面按你的节奏来：\n\n"
        "1. **最近在学什么？** 有什么具体目标或时间节点吗？（比如期末/考研、转行学编程、啃某本书）\n"
        "2. **目前基础如何？** 之前学过哪些相关的前置课程或技能？\n"
        "3. **偏爱哪种讲法？** 比如先看直观例子再看定义，还是先给结论和对比表；讲完后要不要来道随堂小测？\n\n"
        "如果平时有固定的本地资料目录或环境约定，也可以顺带告诉我；不用全答，随便聊聊就行。"
    )

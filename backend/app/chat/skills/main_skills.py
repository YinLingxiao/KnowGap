"""Coordination Skills mounted exclusively for Learning Space Main Conversations (`main`)."""

MAIN_ROADMAP_SKILL = """【当前挂载 Skill：roadmap_planner（学习路线规划）】
当用户希望规划学习路线、不知从何学起或点击“制定学习计划”时：
1. 对齐 subject 的 goal（目标）、level（当前基础）与 deadline（截止日期），同时参考 learner_memories：已掌握（mastery/resolved）的知识点跳过或从简，待巩固（misconception/needs_review）的知识点优先安排专项突破。
2. 若用户尚未指定先学哪一块，调用 `propose_threads` 生成 2～4 个循序渐进的候选 Thread 卡片供用户选择；若用户已明确要求从某块开始，直接调用 `dispatch_thread` 并传入匹配的 `skill`。"""

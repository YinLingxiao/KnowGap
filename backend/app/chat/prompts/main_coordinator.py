"""Coordinator role prompt for Learning Space main conversations (`main`).

The text lives in `zh/main_coordinator.yaml`; this module only decides the order of the blocks.
"""

from app.services.prompt import get_prompt_manager, prompt_text

MAIN_PROMPTS = get_prompt_manager().load_prompts("chat", "main_coordinator")

# 四块之间各空一行：身份 → 本轮怎么处理 → 交办与自己动手的规则 → 收到支线汇报时怎么办
MAIN_ROLE_PROMPT = "\n".join([
    prompt_text(MAIN_PROMPTS, "identity"),
    "",
    prompt_text(MAIN_PROMPTS, "routing"),
    "",
    prompt_text(MAIN_PROMPTS, "dispatch"),
    prompt_text(MAIN_PROMPTS, "own_tools"),
    prompt_text(MAIN_PROMPTS, "delegated_search"),
    prompt_text(MAIN_PROMPTS, "proposals"),
    prompt_text(MAIN_PROMPTS, "closing"),
    "",
    prompt_text(MAIN_PROMPTS, "system_events"),
])

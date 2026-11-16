"""Shared context contract, memory adaptation rules, and safety boundaries across all roles.

Learning-space roles (`main`, `thread`) get the full learning contract; free chats (`chat`) get the
general assistant contract, which keeps memory and profile but drops teaching-flow fields.

Role-independent text (audience, format, tools) is in `zh/shared.yaml`; the learning contract is in
`zh/learning_space.yaml`; the free-chat contract is assembled in `parallel_chat.py`.
"""

from app.services.prompt import get_prompt_manager, prompt_text

SHARED_PROMPTS = get_prompt_manager().load_prompts("chat", "shared")
_GENERAL_INTRO = prompt_text(SHARED_PROMPTS, "audience")
_FORMAT = prompt_text(SHARED_PROMPTS, "format")
_TOOLS = prompt_text(SHARED_PROMPTS, "tools")

LEARNING_PROMPTS = get_prompt_manager().load_prompts("chat", "learning_space")
_LEARNING_INTRO = prompt_text(LEARNING_PROMPTS, "intro")
_LEARNING_BACKGROUND = prompt_text(LEARNING_PROMPTS, "background")
_LEARNING_CONTEXT = prompt_text(LEARNING_PROMPTS, "context")

COMMON_CONTEXT_PROMPT = "\n".join([_LEARNING_INTRO, _GENERAL_INTRO, _LEARNING_BACKGROUND, "", _FORMAT, "",
                                   _LEARNING_CONTEXT, _TOOLS])

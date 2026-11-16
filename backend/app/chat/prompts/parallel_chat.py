"""Prompts for free/parallel conversations (`chat`): a general assistant, not a tutor.

The text lives in `zh/parallel_chat.yaml` (role, intro, background, context contract) and
`zh/shared.yaml` (audience, format, tools). This module only decides the assembly order.
"""

from app.chat.prompts.common import SHARED_PROMPTS
from app.services.prompt import get_prompt_manager, prompt_text

CHAT_PROMPTS = get_prompt_manager().load_prompts("chat", "parallel_chat")

CHAT_ROLE_PROMPT = prompt_text(CHAT_PROMPTS, "role")

# Identity first, the per-turn context contract and tool rules last; blank lines set off the format rules.
CHAT_CONTEXT_PROMPT = "\n".join([
    prompt_text(CHAT_PROMPTS, "system", "intro"),
    prompt_text(SHARED_PROMPTS, "audience"),
    prompt_text(CHAT_PROMPTS, "system", "background"),
    "",
    prompt_text(SHARED_PROMPTS, "format"),
    "",
    prompt_text(CHAT_PROMPTS, "system", "context"),
    prompt_text(SHARED_PROMPTS, "tools"),
])

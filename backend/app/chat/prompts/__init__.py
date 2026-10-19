"""Role-separated prompt modules for `main`, `thread`, and `chat`."""

from app.chat.prompts.common import COMMON_CONTEXT_PROMPT as CHAT_PROMPT
from app.chat.prompts.main_coordinator import MAIN_ROLE_PROMPT
from app.chat.prompts.parallel_chat import CHAT_ROLE_PROMPT
from app.chat.prompts.thread_worker import THREAD_ROLE_PROMPT

ROLE_PROMPTS = {
    "main": MAIN_ROLE_PROMPT,
    "thread": THREAD_ROLE_PROMPT,
    "chat": CHAT_ROLE_PROMPT,
}

__all__ = [
    "CHAT_PROMPT",
    "CHAT_ROLE_PROMPT",
    "MAIN_ROLE_PROMPT",
    "ROLE_PROMPTS",
    "THREAD_ROLE_PROMPT",
]

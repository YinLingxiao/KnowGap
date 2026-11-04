"""Role-separated prompt modules for `main`, `thread`, and `chat`."""

from app.chat.prompts.common import CHAT_CONTEXT_PROMPT, COMMON_CONTEXT_PROMPT as CHAT_PROMPT
from app.chat.prompts.main_coordinator import MAIN_ROLE_PROMPT
from app.chat.prompts.parallel_chat import CHAT_ROLE_PROMPT
from app.chat.prompts.thread_worker import THREAD_ROLE_PROMPT

ROLE_PROMPTS = {
    "main": MAIN_ROLE_PROMPT,
    "thread": THREAD_ROLE_PROMPT,
    "chat": CHAT_ROLE_PROMPT,
}

# Learning-space roles share the full learning contract; free chats are a general assistant.
CONTEXT_PROMPTS = {
    "main": CHAT_PROMPT,
    "thread": CHAT_PROMPT,
    "chat": CHAT_CONTEXT_PROMPT,
}

__all__ = [
    "CHAT_CONTEXT_PROMPT",
    "CHAT_PROMPT",
    "CHAT_ROLE_PROMPT",
    "CONTEXT_PROMPTS",
    "MAIN_ROLE_PROMPT",
    "ROLE_PROMPTS",
    "THREAD_ROLE_PROMPT",
]

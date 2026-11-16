"""Worker role prompt for Learning Space execution threads (`thread`).

The text lives in `zh/thread_worker.yaml`; the whole file is joined in order.
"""

from app.services.prompt import get_prompt_manager, prompt_text

THREAD_PROMPTS = get_prompt_manager().load_prompts("chat", "thread_worker")

THREAD_ROLE_PROMPT = prompt_text(THREAD_PROMPTS)

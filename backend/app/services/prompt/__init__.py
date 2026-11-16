"""提示词统一加载：每个智能体一份 YAML，按语言分目录（组织方式参照 DeepTutor）。

    prompts = get_prompt_manager().load_prompts("chat", "parallel_chat")
    role = prompt_text(prompts, "role")              # 整段：子键按文件顺序用换行拼接
    rule = prompt_text(prompts, "role", "closing")   # 单独取某一项
"""

from app.services.prompt.manager import PromptError, PromptManager, get_prompt_manager, prompt_text

__all__ = ["PromptError", "PromptManager", "get_prompt_manager", "prompt_text"]

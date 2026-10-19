"""Provider-reported token accounting; absent or malformed data is never estimated."""


def normalize_usage(raw) -> dict | None:
    if not isinstance(raw, dict):
        return None

    def count(value):
        return value if type(value) is int and value >= 0 else None

    inputs = count(raw.get("prompt_tokens", raw.get("input_tokens")))
    outputs = count(raw.get("completion_tokens", raw.get("output_tokens")))
    if inputs is None or outputs is None:
        return None
    details = raw.get("prompt_tokens_details") or raw.get("input_tokens_details") or {}
    cached = count(details.get("cached_tokens")) if isinstance(details, dict) else None
    if cached is None:
        cached = count(raw.get("prompt_cache_hit_tokens"))
    if cached is not None and cached > inputs:
        cached = None
    # Cache hits are a subset of input tokens, NOT extra tokens to add to total.
    return {"input_tokens": inputs, "output_tokens": outputs, "cached_tokens": cached}

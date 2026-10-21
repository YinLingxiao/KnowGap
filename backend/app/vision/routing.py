"""Dynamic thinking-effort routing for image questions. Pure functions, so every rule is unit-tested.

Concept questions and simple circuits are forced to `low` to avoid overthinking; multi-step
comprehensive derivations get `high`. The user's Composer choice of "标准（off）" is a cap.
"""

from dataclasses import asdict, dataclass

EFFORTS = ("off", "low", "medium", "high")


@dataclass(frozen=True)
class Route:
    effort: str
    reason: str
    source: str = "auto"

    def as_dict(self) -> dict:
        return asdict(self)


def route_problem(kind: str, steps: int, category: str | None = None) -> Route:
    """Handwritten answers and printed problems: problem type first, then the vision model's step estimate."""
    label = "手写作答" if kind == "handwritten" else "题目"
    if category == "concept":
        return Route("low", f"{label}是概念判断类，直接给结论，避免过度思考")
    if category == "comprehensive":
        detail = f"约需 {steps} 步推导" if steps else "需要多步联立推导"
        return Route("high", f"{label}是综合计算题，{detail}")
    if steps <= 1:
        return Route("low", f"{label}只需约 {max(steps, 1)} 步，直接给结论")
    if steps > 3:
        return Route("high", f"{label}约需 {steps} 步推导")
    return Route("medium", f"{label}约需 {steps} 步推导")


def route_circuit_card() -> Route:
    # The first circuit turn only shows the confirmation card; no calculation happens yet.
    return Route("low", "先确认电路拓扑，本轮不计算")


def route_circuit_solve(complexity: dict) -> Route:
    """Same thresholds as the eval set's simple/complex split: simple = at most 3 nodes, one loop,
    one independent source, no controlled source."""
    nodes = int(complexity.get("node_count", 0))
    loops = int(complexity.get("independent_loops", 0))
    sources = int(complexity.get("independent_sources", 1))
    controlled = bool(complexity.get("has_controlled_source"))
    if controlled or nodes >= 4 or loops >= 3 or sources >= 2:
        parts = [f"{nodes} 个节点", f"{loops} 个独立回路"]
        if sources >= 2:
            parts.append(f"{sources} 个独立源")
        if controlled:
            parts.append("含受控源")
        return Route("high", "、".join(parts) + "，列 KCL/KVL 需要多步推演")
    if nodes <= 3 and loops <= 1:
        return Route("low", "单回路简单电路，直接求解")
    return Route("medium", f"{nodes} 个节点、{loops} 个独立回路")


def apply_user_cap(route: Route, user_effort: str | None) -> Route:
    if user_effort == "off" and route.effort in {"medium", "high"}:
        return Route("low", f"{route.reason}；你选择了标准档，已限制为低", source="user")
    return route

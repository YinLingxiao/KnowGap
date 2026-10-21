"""Circuit netlist: lenient parsing of a vision-model draft, topology checks and complexity hints.

The netlist is only a draft until the student confirms it; errors block confirmation,
warnings are shown on the card so the student knows where to look.
"""

import math
import re
from collections import Counter
from dataclasses import asdict, dataclass
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

ELEMENTS = ("R", "L", "C", "V", "I", "VCVS", "VCCS", "CCVS", "CCCS", "SW", "W", "OTHER")
CONTROLLED = frozenset({"VCVS", "VCCS", "CCVS", "CCCS"})
MAX_NODES, MAX_BRANCHES = 60, 80

_ALIASES = {
    "RESISTOR": "R", "电阻": "R",
    "INDUCTOR": "L", "电感": "L", "线圈": "L",
    "CAPACITOR": "C", "电容": "C",
    "VS": "V", "VSOURCE": "V", "VOLTAGE": "V", "VOLTAGESOURCE": "V", "BATTERY": "V", "电压源": "V", "电池": "V",
    "IS": "I", "ISOURCE": "I", "CURRENT": "I", "CURRENTSOURCE": "I", "电流源": "I",
    "SWITCH": "SW", "开关": "SW",
    "WIRE": "W", "SHORT": "W", "导线": "W",
}
_QUANTITY = {"U": "U", "V": "U", "电压": "U", "I": "I", "电流": "I"}
_ID_RE = re.compile(r"[^\s\x00-\x1f\x7f]{1,16}")


class Control(BaseModel):
    ref: str
    quantity: Literal["U", "I"] | None = None
    direction: str = ""


class Node(BaseModel):
    id: str
    note: str = ""


class Branch(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str
    element: str
    value: str = ""
    from_: str = Field(alias="from")
    to: str
    polarity: str = ""
    control: Control | None = None


class Netlist(BaseModel):
    nodes: list[Node]
    branches: list[Branch]
    uncertain: list[str] = Field(default_factory=list)

    def dump(self) -> dict:
        return self.model_dump(by_alias=True)


@dataclass(frozen=True)
class Issue:
    level: Literal["error", "warning"]
    code: str
    message: str
    ref: str | None = None

    def as_dict(self) -> dict:
        return asdict(self)


def _text(value, limit: int) -> str:
    if isinstance(value, bool):
        return ""
    if isinstance(value, str):
        return value.strip()[:limit]
    if isinstance(value, int) or (isinstance(value, float) and math.isfinite(value)):
        return str(value)[:limit]
    return ""


def _ident(value) -> str | None:
    text = _text(value, 17)
    return text if _ID_RE.fullmatch(text) else None


def _first(*values):
    return next((value for value in values if value is not None), None)


def _list(value) -> list:
    return value if isinstance(value, list) else []


def normalize_element(raw) -> str:
    text = _text(raw, 30).upper().replace(" ", "").replace("_", "").replace("-", "")
    if text in ELEMENTS:
        return text
    return _ALIASES.get(text, "OTHER")


def _control(raw) -> Control | None:
    if not isinstance(raw, dict):
        return None
    ref = _ident(_first(raw.get("ref"), raw.get("branch"), raw.get("by")))
    if not ref:
        return None
    quantity = _QUANTITY.get(_text(raw.get("quantity"), 4).upper())
    return Control(ref=ref, quantity=quantity, direction=_text(raw.get("direction"), 24))


def parse_netlist(raw) -> Netlist:
    """Accept the shapes models actually emit (string nodes, `nodes: [a, b]` branches, aliases)."""
    if not isinstance(raw, dict):
        raise ValueError("网表格式无效。")
    nodes: dict[str, Node] = {}
    for item in _list(raw.get("nodes"))[:MAX_NODES]:
        if isinstance(item, dict):
            node_id, note = _ident(_first(item.get("id"), item.get("label"))), _text(item.get("note"), 60)
        else:
            node_id, note = _ident(item), ""
        if node_id and node_id not in nodes:
            nodes[node_id] = Node(id=node_id, note=note)
    branches: list[Branch] = []
    for index, item in enumerate(_list(raw.get("branches"))[:MAX_BRANCHES]):
        if not isinstance(item, dict):
            continue
        ends = _list(item.get("nodes"))
        start = _ident(_first(item.get("from"), ends[0] if ends else None))
        end = _ident(_first(item.get("to"), ends[1] if len(ends) > 1 else None))
        if not start or not end:
            continue
        missing = [n for n in dict.fromkeys((start, end)) if n not in nodes]
        if len(nodes) + len(missing) > MAX_NODES:
            continue
        for node_id in missing:
            nodes[node_id] = Node(id=node_id)
        branches.append(Branch(
            id=_ident(_first(item.get("id"), item.get("name"))) or f"B{index + 1}",
            element=normalize_element(_first(item.get("element"), item.get("type"), item.get("component"))),
            value=_text(item.get("value"), 40), from_=start, to=end,
            polarity=_text(_first(item.get("polarity"), item.get("direction")), 24),
            control=_control(item.get("control")),
        ))
    if not branches:
        raise ValueError("网表里没有可用的支路。")
    ids = {branch.id for branch in branches}
    uncertain = [u for u in dict.fromkeys(_ident(x) for x in _list(raw.get("uncertain"))) if u in ids]
    return Netlist(nodes=list(nodes.values()), branches=branches, uncertain=uncertain)


def _degrees(netlist: Netlist) -> Counter:
    degree: Counter = Counter()
    for branch in netlist.branches:
        if branch.from_ != branch.to:
            degree[branch.from_] += 1
            degree[branch.to] += 1
    return degree


def _components(netlist: Netlist) -> int:
    parent: dict[str, str] = {}

    def find(node: str) -> str:
        parent.setdefault(node, node)
        while parent[node] != node:
            parent[node] = parent[parent[node]]
            node = parent[node]
        return node

    for branch in netlist.branches:
        if branch.from_ != branch.to:
            parent[find(branch.from_)] = find(branch.to)
    return len({find(node) for node in list(parent)})


def check_topology(netlist: Netlist) -> list[Issue]:
    issues: list[Issue] = []
    seen: set[str] = set()
    for branch in netlist.branches:
        if branch.id in seen:
            issues.append(Issue("error", "duplicate_branch", f"支路编号 {branch.id} 重复，请改成不同的编号。", branch.id))
        seen.add(branch.id)
    for branch in netlist.branches:
        if branch.from_ == branch.to:
            issues.append(Issue("error", "self_loop", f"支路 {branch.id} 两端接在同一节点 {branch.to}。", branch.id))
        if branch.element in CONTROLLED:
            if branch.control is None:
                issues.append(Issue("error", "missing_control", f"受控源 {branch.id} 缺少控制量。", branch.id))
            elif branch.control.ref == branch.id or branch.control.ref not in seen:
                issues.append(Issue("error", "bad_control_ref",
                                    f"受控源 {branch.id} 的控制支路 {branch.control.ref} 不存在。", branch.id))
            elif branch.control.quantity is None:
                issues.append(Issue("error", "missing_control", f"受控源 {branch.id} 缺少控制量类型。", branch.id))
            else:
                expected = "U" if branch.element in {"VCVS", "VCCS"} else "I"
                if branch.control.quantity != expected:
                    name = "电压" if expected == "U" else "电流"
                    issues.append(Issue("error", "bad_control_quantity",
                                        f"受控源 {branch.id} 应使用{name}控制量。", branch.id))
    degree = _degrees(netlist)
    for node in netlist.nodes:
        if degree[node.id] == 0:
            issues.append(Issue("warning", "unused_node", f"节点 {node.id} 没有连接任何支路。", node.id))
        elif degree[node.id] == 1:
            issues.append(Issue("warning", "dangling_node", f"节点 {node.id} 只连了一条支路，可能漏识别了连线。", node.id))
    parts = _components(netlist)
    if parts > 1:
        issues.append(Issue("warning", "disconnected", f"电路分成了 {parts} 个互不相连的部分。"))
    # Dependent sources alone cannot excite a circuit; at least one independent V/I source is expected.
    if not any(branch.element in {"V", "I"} for branch in netlist.branches):
        issues.append(Issue("warning", "no_source", "没有识别到独立电压源或电流源，可能漏识别了电源。"))
    for branch_id in netlist.uncertain:
        issues.append(Issue("warning", "uncertain", f"支路 {branch_id} 识别不确定，请重点核对。", branch_id))
    return issues


def has_errors(issues: list[Issue]) -> bool:
    return any(issue.level == "error" for issue in issues)


def complexity(netlist: Netlist) -> dict:
    degree = _degrees(netlist)
    branches = sum(branch.from_ != branch.to for branch in netlist.branches)
    nodes = sum(1 for count in degree.values() if count)
    parts = _components(netlist)
    return {
        "node_count": nodes, "branch_count": branches,
        "independent_loops": max(0, branches - nodes + parts),
        "has_controlled_source": any(branch.element in CONTROLLED for branch in netlist.branches),
        "independent_sources": sum(branch.element in {"V", "I"} for branch in netlist.branches),
    }


def netlist_text(netlist: Netlist) -> str:
    """Plain-text netlist for the reasoning model's trusted context."""
    lines = [f"节点：{'、'.join(node.id for node in netlist.nodes)}"]
    for branch in netlist.branches:
        line = f"{branch.id}（{branch.element}{' ' + branch.value if branch.value else ''}）：{branch.from_} → {branch.to}"
        if branch.polarity:
            line += f"，参考方向/极性 {branch.polarity}"
        if branch.control:
            quantity = {"U": "电压", "I": "电流"}.get(branch.control.quantity or "", "控制量")
            line += f"，受 {branch.control.ref} 的{quantity}控制"
            if branch.control.direction:
                line += f"（方向 {branch.control.direction}）"
        lines.append(line)
    return "\n".join(lines)

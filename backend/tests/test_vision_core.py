"""Unit tests for app/vision core modules. No real provider is called; HTTP uses httpx.MockTransport."""

import asyncio
import json
import struct

import httpx
import pytest
from pydantic import SecretStr

from app.agents.llm import ProviderError
from app.vision import circuit_netlist as cn
from app.vision.grounding import extract, extraction_prompt, json_object, normalize_bbox, parse_extraction
from app.vision.routing import apply_user_cap, route_circuit_card, route_circuit_solve, route_problem
from app.vision.settings import VisionConfig
from app.vision.store import ImageRejected, VersionConflict, VisionStore, sniff_image

SECRET = "sk-vision-secret-123"
DATA_URL = "data:image/png;base64,iVBORw0KGgo="


def png(width=640, height=480) -> bytes:
    return (b"\x89PNG\r\n\x1a\n" + b"\x00\x00\x00\x0d" + b"IHDR" + struct.pack(">II", width, height)
            + b"\x08\x02\x00\x00\x00" + b"\x00" * 16)


def jpeg(width=800, height=600) -> bytes:
    app0 = b"\xff\xe0" + struct.pack(">H", 16) + b"JFIF\x00" + b"\x00" * 9
    sof0 = b"\xff\xc0" + struct.pack(">H", 17) + b"\x08" + struct.pack(">HH", height, width) + b"\x03" + b"\x00" * 9
    return b"\xff\xd8" + app0 + sof0 + b"\x00" * 16


def webp(width=320, height=200) -> bytes:
    return (b"RIFF" + struct.pack("<I", 30) + b"WEBP" + b"VP8X" + struct.pack("<I", 10) + b"\x00" * 4
            + (width - 1).to_bytes(3, "little") + (height - 1).to_bytes(3, "little") + b"\x00" * 8)


def config(**overrides) -> VisionConfig:
    data = {"base_url": "https://vision.example/v1", "model": "qwen3.5-plus", "api_key": SecretStr(SECRET),
            "bbox_format": "xyxy_1000"}
    return VisionConfig(**{**data, **overrides})


# ---------- grounding: coordinates ----------

@pytest.mark.parametrize("fmt, raw, size, expected", [
    ("xyxy_1000", [100, 200, 300, 400], None, (200, 100, 400, 300)),
    ("yxyx_1000", [200, 100, 400, 300], None, (200, 100, 400, 300)),
    ("xyxy_unit", [0.1, 0.2, 0.3, 0.4], None, (200, 100, 400, 300)),
    ("xyxy_pixel", [64, 96, 192, 192], (640, 480), (200, 100, 400, 300)),
    ("xyxy_1000", [300, 400, 100, 200], None, (200, 100, 400, 300)),  # reversed corners are reordered
    ("xyxy_1000", [-50, -10, 1200, 1500], None, (0, 0, 1000, 1000)),  # clamped to the image
])
def test_normalize_bbox_formats(fmt, raw, size, expected):
    width, height = size or (None, None)
    assert normalize_bbox(raw, fmt, width, height) == expected


@pytest.mark.parametrize("raw", [[1, 2, 3], [1, 2, 3, "x"], [True, 0, 10, 10], [0, 0, float("nan"), 9], "0,0,9,9",
                                 [100, 100, 101, 300]])
def test_normalize_bbox_rejects_unusable(raw):
    assert normalize_bbox(raw, "xyxy_1000") is None


def test_pixel_format_needs_image_size():
    assert normalize_bbox([1, 2, 30, 40], "xyxy_pixel") is None


def test_parse_extraction_is_lenient_but_safe():
    content = "```json\n" + json.dumps({
        "kind": "handwritten", "transcript": "v = at^2", "steps": 4, "category": "calculation",
        "regions": [
            {"id": "r1", "bbox": [100, 100, 900, 200], "text": "第一行"},
            {"id": "../../etc", "bbox_2d": [100, 300, 900, 400], "text": "第二行"},
            {"id": "r1", "bbox": [100, 500, 900, 600]},
            {"id": "r9", "bbox": [5, 5, 5, 5]},
            "not a region",
        ],
        "netlist": {"nodes": ["A"]},
    }) + "\n```"
    result = parse_extraction(content, "xyxy_1000")
    assert result.kind == "handwritten" and result.steps == 4 and result.category == "calculation"
    assert [r.id for r in result.regions] == ["r1", "r2", "r3"]
    assert result.regions[0].bbox == (100, 100, 200, 900)
    assert result.netlist is None  # only circuits keep a netlist draft
    assert result.region("r2").text == "第二行"


def test_parse_extraction_unknown_kind_category_and_garbage():
    result = parse_extraction('{"kind": "selfie", "category": "hard"}', "xyxy_1000")
    assert result.kind == "other" and result.category is None
    with pytest.raises(ValueError):
        parse_extraction("I cannot see the image", "xyxy_1000")


def test_json_object_repairs_trailing_commas_and_latex():
    raw = 'Here you go: {"transcript": "R = 10\\Omega, \\frac{1}{2}", "regions": [{"id": "r1",},],}'
    data = json_object(raw)
    assert data["transcript"] == "R = 10\\Omega, \\frac{1}{2}"
    assert data["regions"] == [{"id": "r1"}]


@pytest.mark.parametrize("raw, expected", [
    # Valid JSON that would silently corrupt LaTeX into control characters.
    ('{"a": "\\frac{1}{2} \\times 3 \\neq \\theta"}', "\\frac{1}{2} \\times 3 \\neq \\theta"),
    ('{"a": "\\beta + \\rho \\right)"}', "\\beta + \\rho \\right)"),
    ('{"a": "\\underline{x} \\overline{AB}"}', "\\underline{x} \\overline{AB}"),
    # Genuine escapes are untouched.
    ('{"a": "x+2=5\\nx=3\\tok"}', "x+2=5\nx=3\tok"),
    ('{"a": "\\u4e2d\\\\frac \\"q\\""}', '中\\frac "q"'),
    ('{"a": "line\\nunit"}', "line\nunit"),
])
def test_json_object_latex_vs_real_escapes(raw, expected):
    assert json_object(raw)["a"] == expected


def test_region_limit_fits_dense_pages():
    regions = [{"id": f"r{i}", "bbox": [0, i * 10, 1000, i * 10 + 9]} for i in range(100)]
    result = parse_extraction(json.dumps({"kind": "handwritten", "regions": regions}), "xyxy_1000")
    assert len(result.regions) == 80


def test_judge_prompt_only_in_single_model_mode():
    prompt = extraction_prompt("xyxy_1000")
    assert "errors" not in prompt
    assert "不评价对错" in prompt
    assert "即使同图还有印刷题干、坐标波形" in prompt
    assert "数字逻辑的门电路图" in prompt
    judging = extraction_prompt("xyxy_1000", judge=True)
    assert "errors" in judging and "region_id" in judging


# ---------- grounding: provider call ----------

def run_extract(handler, cfg=None, **kwargs):
    return asyncio.run(extract(DATA_URL, cfg or config(), width=640, height=480,
                               transport=httpx.MockTransport(handler), **kwargs))


def reply(content: dict, finish="stop"):
    return httpx.Response(200, json={"choices": [{"finish_reason": finish, "message": {"content": json.dumps(content)}}]})


def test_extract_sends_image_and_parses():
    seen = {}

    def handler(request: httpx.Request):
        seen["auth"] = request.headers["authorization"]
        seen["body"] = json.loads(request.content)
        return reply({"kind": "circuit", "transcript": "", "steps": 3,
                      "regions": [{"id": "r1", "bbox": [10, 10, 200, 200], "text": "R1"}],
                      "netlist": {"nodes": ["A", "B"], "branches": [{"id": "R1", "element": "R", "from": "A", "to": "B"}]}})

    result = run_extract(handler)
    assert seen["auth"] == f"Bearer {SECRET}"
    body = seen["body"]
    assert body["model"] == "qwen3.5-plus" and body["temperature"] == 0
    assert body["enable_thinking"] is False  # Qwen only: thinking timed out in testing
    assert body["messages"][1]["content"][0]["image_url"]["url"] == DATA_URL
    assert "[x1, y1, x2, y2]" in body["messages"][0]["content"]
    assert result.kind == "circuit" and result.netlist["branches"][0]["id"] == "R1"


def test_extract_non_qwen_model_gets_no_qwen_switch():
    seen = {}

    def handler(request):
        seen["body"] = json.loads(request.content)
        return reply({"kind": "other", "regions": []})

    run_extract(handler, config(model="gemini-4-argon", bbox_format="yxyx_1000"))
    assert "enable_thinking" not in seen["body"]


def test_extract_single_model_mode_returns_errors():
    def handler(request):
        assert "errors" in json.loads(request.content)["messages"][0]["content"]
        return reply({"kind": "handwritten", "regions": [{"id": "r1", "bbox": [0, 0, 500, 100]}],
                      "errors": [{"region_id": "r1", "note": "符号写反"}], "summary": "一处错误"})

    result = run_extract(handler, judge=True, question="哪里错了")
    assert result.errors == [{"region_id": "r1", "note": "符号写反"}] and result.summary == "一处错误"


@pytest.mark.parametrize("status, code", [(401, 503), (429, 503), (500, 502)])
def test_extract_provider_errors_are_prefixed_and_never_leak_key(status, code):
    with pytest.raises(ProviderError) as info:
        run_extract(lambda request: httpx.Response(status, text=SECRET))
    assert info.value.status_code == code
    assert info.value.detail.startswith("多模态识图模型") and SECRET not in info.value.detail


def test_extract_rejects_truncated_output():
    with pytest.raises(ProviderError) as info:
        run_extract(lambda request: reply({"kind": "other"}, finish="length"))
    assert info.value.status_code == 502


def test_extract_not_configured_never_calls_provider():
    def handler(request):  # pragma: no cover - must not be reached
        raise AssertionError("provider called")

    with pytest.raises(ProviderError) as info:
        run_extract(handler, VisionConfig())
    assert info.value.status_code == 503 and "VISION_API_KEY" in info.value.detail


# ---------- circuit netlist ----------

DRAFT = {
    "nodes": ["A", {"id": "B", "note": "中间"}, "GND"],
    "branches": [
        {"id": "V1", "type": "电压源", "value": "12V", "nodes": ["A", "GND"]},
        {"name": "R1", "component": "resistor", "value": "10Ω", "from": "A", "to": "B"},
        {"id": "E1", "element": "vcvs", "value": "2U", "from": "B", "to": "GND",
         "control": {"ref": "R1", "quantity": "u", "direction": "A→B"}},
        {"id": "R2", "element": "R", "from": "B"},  # missing end: dropped
    ],
    "uncertain": ["E1", "ZZ"],
}


def test_parse_netlist_accepts_model_shapes():
    netlist = cn.parse_netlist(DRAFT)
    assert [n.id for n in netlist.nodes] == ["A", "B", "GND"]
    assert [(b.id, b.element, b.from_, b.to) for b in netlist.branches] == [
        ("V1", "V", "A", "GND"), ("R1", "R", "A", "B"), ("E1", "VCVS", "B", "GND")]
    assert netlist.branches[2].control.quantity == "U"
    assert netlist.uncertain == ["E1"]
    assert netlist.dump()["branches"][1]["from"] == "A"


def test_parse_netlist_rejects_empty():
    with pytest.raises(ValueError):
        cn.parse_netlist({"nodes": ["A"], "branches": []})
    with pytest.raises(ValueError):
        cn.parse_netlist(["not", "a", "dict"])


def test_topology_errors_and_warnings():
    netlist = cn.parse_netlist({
        "nodes": ["A", "B", "C", "X"],
        "branches": [
            {"id": "R1", "element": "R", "from": "A", "to": "A"},
            {"id": "R2", "element": "R", "from": "A", "to": "B"},
            {"id": "F1", "element": "CCCS", "from": "B", "to": "C"},
            {"id": "G1", "element": "VCCS", "from": "B", "to": "C", "control": {"ref": "R9"}},
            {"id": "E1", "element": "VCVS", "from": "A", "to": "B", "control": {"ref": "R2"}},
            {"id": "H1", "element": "CCVS", "from": "A", "to": "C",
             "control": {"ref": "R2", "quantity": "U"}},
            {"id": "R2", "element": "R", "from": "B", "to": "C"},
        ],
    })
    issues = cn.check_topology(netlist)
    codes = {(i.level, i.code, i.ref) for i in issues}
    assert ("error", "self_loop", "R1") in codes
    assert ("error", "missing_control", "F1") in codes
    assert ("error", "bad_control_ref", "G1") in codes
    assert ("error", "missing_control", "E1") in codes
    assert ("error", "bad_control_quantity", "H1") in codes
    assert ("error", "duplicate_branch", "R2") in codes
    assert ("warning", "unused_node", "X") in codes
    assert ("warning", "no_source", None) in codes
    assert cn.has_errors(issues)


def test_valid_circuit_has_no_errors_and_complexity():
    netlist = cn.parse_netlist(DRAFT)
    assert not cn.has_errors(cn.check_topology(netlist))
    assert cn.complexity(netlist) == {"node_count": 3, "branch_count": 3, "independent_loops": 1,
                                      "has_controlled_source": True, "independent_sources": 1}
    assert "E1（VCVS 2U）：B → GND，受 R1 的电压控制（方向 A→B）" in cn.netlist_text(netlist)


# ---------- routing ----------

def test_problem_routing():
    assert route_problem("handwritten", 1).effort == "low"
    assert route_problem("problem", 3).effort == "medium"
    assert route_problem("problem", 5).effort == "high"
    assert route_problem("problem", 6, "concept").effort == "low"  # concept questions never overthink
    assert route_problem("problem", 1, "comprehensive").effort == "high"
    assert route_problem("problem", 2, "calculation").effort == "medium"


def test_circuit_routing_matches_eval_simple_complex_split():
    assert route_circuit_card().effort == "low"
    simple = {"node_count": 3, "independent_loops": 1, "independent_sources": 1}
    assert route_circuit_solve(simple).effort == "low"
    assert route_circuit_solve({**simple, "independent_loops": 2}).effort == "medium"
    assert route_circuit_solve({**simple, "node_count": 4}).effort == "high"
    assert route_circuit_solve({**simple, "independent_sources": 2}).effort == "high"
    assert route_circuit_solve({**simple, "has_controlled_source": True}).effort == "high"


def test_user_cap():
    capped = apply_user_cap(route_problem("problem", 6), "off")
    assert capped.effort == "low" and capped.source == "user"
    assert apply_user_cap(route_problem("problem", 6), "medium").effort == "high"


# ---------- store ----------

@pytest.mark.parametrize("data, expected", [
    (png(640, 480), ("image/png", 640, 480)),
    (jpeg(800, 600), ("image/jpeg", 800, 600)),
    (webp(320, 200), ("image/webp", 320, 200)),
])
def test_sniff_image_by_content(data, expected):
    assert sniff_image(data) == expected


@pytest.mark.parametrize("data, status", [
    (b"<svg onload=alert(1)>", 415), (b"GIF89a" + b"\x00" * 20, 415), (png(0, 10), 415),
    (b"\x89PNG\r\n\x1a\n" + b"\x00" * 4, 415), (b"\x89PNG" + b"\x00" * (10 * 1024 * 1024), 413),
], ids=["svg", "gif", "zero-width", "truncated-png", "over-10mb"])
def test_sniff_image_rejects(data, status):
    with pytest.raises(ImageRejected) as info:
        sniff_image(data)
    assert info.value.status == status


def test_images_are_isolated_and_deduplicated(tmp_path):
    store = VisionStore(tmp_path)
    meta = store.save_image("alice", png())
    assert store.save_image("alice", png())["image_id"] == meta["image_id"]  # same bytes, same id
    assert store.save_image("bob", png())["image_id"] != meta["image_id"]
    assert store.image("alice", meta["image_id"])[0] == png()
    assert store.image("bob", meta["image_id"]) is None
    assert store.image("alice", "../../ai-settings") is None
    url, _ = store.data_url("alice", meta["image_id"])
    assert url.startswith("data:image/png;base64,")


def test_extraction_cache_is_keyed(tmp_path):
    store = VisionStore(tmp_path)
    image_id = store.save_image("alice", png())["image_id"]
    store.cache_extraction("alice", image_id, "qwen|xyxy_1000|extract", {"kind": "circuit"})
    assert store.cached_extraction("alice", image_id, "qwen|xyxy_1000|extract") == {"kind": "circuit"}
    assert store.cached_extraction("alice", image_id, "qwen|xyxy_1000|judge|") is None
    assert store.cached_extraction("bob", image_id, "qwen|xyxy_1000|extract") is None


def test_netlist_versions_and_confirmation(tmp_path):
    store = VisionStore(tmp_path)
    draft = cn.parse_netlist(DRAFT).dump()
    record = store.create_netlist("alice", "img_x", draft, key="img_x")
    assert store.create_netlist("alice", "img_x", draft, key="img_x")["netlist_id"] == record["netlist_id"]
    netlist_id = record["netlist_id"]
    assert store.netlist("bob", netlist_id) is None

    fixed = json.loads(json.dumps(draft))
    fixed["branches"][1]["to"] = "GND"
    confirmed = store.confirm_netlist("alice", netlist_id, 1, fixed)
    assert confirmed["version"] == 2 and confirmed["confirmed"]
    assert store.netlist_version("alice", netlist_id, 2) == (fixed, True)
    assert store.netlist_version("alice", netlist_id, 1) == (draft, False)  # old draft is never "confirmed"

    with pytest.raises(VersionConflict):
        store.confirm_netlist("alice", netlist_id, 1, None)  # stale card
    assert store.confirm_netlist("alice", netlist_id, 2, None)["version"] == 2  # double click is idempotent
    with pytest.raises(LookupError):
        store.confirm_netlist("bob", netlist_id, 2, None)

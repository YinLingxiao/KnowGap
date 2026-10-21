"""HTTP tests for the vision module: service models, the VLM -> logic relay, images and netlists.

Both models are mocked with httpx.MockTransport; no real provider is called. The router is mounted on a
minimal app here, exactly as the integrator mounts it in main.py.
"""

import base64
import json
import struct

import httpx
import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient
from pydantic import SecretStr

from app.auth.deps import reset_student, set_student
from app.config import Settings
from app.services.ai_settings import AISettings
from app.vision import circuit_netlist as cn
from app.vision.router import vision_router
from app.vision.settings import ServiceModels, VisionConfig
from app.vision.store import VisionStore

LOGIC_KEY = "sk-logic-secret-111"
VISION_KEY = "sk-vision-secret-222"
RELAY = "https://relay.example/v1"


def png(width=640, height=480) -> bytes:
    return (b"\x89PNG\r\n\x1a\n" + b"\x00\x00\x00\x0d" + b"IHDR" + struct.pack(">II", width, height)
            + b"\x08\x02\x00\x00\x00" + b"\x00" * 16)


def data_url(data: bytes, mime="image/png") -> str:
    return f"data:{mime};base64,{base64.b64encode(data).decode()}"


def chat_reply(content: dict, finish="stop") -> httpx.Response:
    return httpx.Response(200, json={"choices": [{"finish_reason": finish, "message": {"content": json.dumps(content)}}],
                                     "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}})


HANDWRITTEN = {
    "kind": "handwritten", "transcript": "解：x+2=5\nx=5+2\nx=7", "steps": 2, "category": "calculation",
    "regions": [
        {"id": "r1", "bbox": [100, 100, 900, 200], "text": "x+2=5"},
        {"id": "r2", "bbox": [100, 250, 900, 350], "text": "x=5+2"},
        {"id": "r3", "bbox": [100, 400, 900, 500], "text": "x=7"},
    ],
    "netlist": None,
}

CIRCUIT = {
    "kind": "circuit", "transcript": "求 I", "steps": 3, "category": "calculation",
    "regions": [{"id": "r1", "bbox": [10, 10, 300, 300], "text": "Us"}],
    "netlist": {"nodes": [{"id": "a"}, {"id": "b"}, {"id": "GND"}], "branches": [
        {"id": "Us", "element": "V", "value": "12V", "from": "a", "to": "GND", "polarity": "+a"},
        {"id": "R1", "element": "R", "value": "10Ω", "from": "a", "to": "b"},
        {"id": "R2", "element": "R", "value": "20Ω", "from": "b", "to": "GND"},
    ], "uncertain": ["R2"]},
}


class Recorder:
    """A mock provider that records every request body."""

    def __init__(self, respond):
        self.respond = respond
        self.bodies: list[dict] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        self.bodies.append({"url": str(request.url), "auth": request.headers.get("authorization"), **body})
        return self.respond(body)


def make_client(tmp_path, *, vision=None, logic=None, logic_configured=True, env=None):
    # isolated_settings() pins llm_* to empty strings, so build Settings directly with the same isolation.
    settings = Settings(
        _env_file=None, database_path=tmp_path / "acceptance.sqlite3",
        llm_base_url=RELAY if logic_configured else "", llm_model="gemini-4-argon" if logic_configured else "",
        llm_api_key=LOGIC_KEY if logic_configured else "")
    ai = AISettings(settings)
    env = env if env is not None else VisionConfig(base_url=RELAY, model="qwen3.5-plus",
                                                   api_key=SecretStr(VISION_KEY), source="env")
    service_models = ServiceModels(ai, env=env)
    store = VisionStore(tmp_path)
    app = FastAPI()
    app.include_router(vision_router(
        store, service_models, cors_origins=["http://localhost:3000"],
        vision_transport=httpx.MockTransport(vision) if vision else None,
        logic_transport=httpx.MockTransport(logic) if logic else None,
    ))

    @app.middleware("http")
    async def bind(request: Request, call_next):
        # Stand-in for the real auth middleware in main.py.
        token = set_student(request.headers.get("x-test-student", "alice"))
        try:
            return await call_next(request)
        finally:
            reset_student(token)

    client = TestClient(app)
    client.store, client.ai, client.service_models = store, ai, service_models
    return client


def analyze(client, student="alice", **body):
    return client.post("/api/vision/analyze", json=body, headers={"x-test-student": student})


# ---------------------------------------------------------------- service models

def test_service_models_defaults_and_masking(tmp_path):
    client = make_client(tmp_path)
    res = client.get("/api/vision/service-models")
    assert res.status_code == 200 and res.headers["cache-control"] == "no-store"
    body = res.json()
    assert body["logic_model"]["effective"] == {"model": "gemini-4-argon", "source": "global", "configured": True}
    assert body["vision_model"]["effective"]["model"] == "qwen3.5-plus"
    assert body["vision_model"]["effective"]["source"] == "env"
    assert body["dual_model_relay"] is True and body["circuit_confirm_first"] is True
    assert body["suggest_reply_enabled"] is True
    assert LOGIC_KEY not in res.text and VISION_KEY not in res.text


def test_service_models_save_keeps_other_settings_and_secrets(tmp_path):
    client = make_client(tmp_path)
    ai_path = client.ai.path
    ai_path.parent.mkdir(parents=True, exist_ok=True)
    ai_path.write_text(json.dumps({"base_url": RELAY, "model": "gemini-4-argon", "api_key": LOGIC_KEY,
                                   "workspace": {"keep": True}}), encoding="utf-8")

    res = client.put("/api/vision/service-models", json={
        "vision_model": {"base_url": "https://vlm.example/v1", "model": "qwen3.5-plus", "api_key": VISION_KEY,
                         "bbox_format": "xyxy_1000", "api_key_configured": False, "effective": {"x": 1}},
        "dual_model_relay": False, "suggest_reply_enabled": False,
    })
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["vision_model"]["api_key_configured"] is True and VISION_KEY not in res.text
    assert body["vision_model"]["effective"]["source"] == "service_models"
    assert body["dual_model_relay"] is False and body["suggest_reply_enabled"] is False

    saved = json.loads(ai_path.read_text(encoding="utf-8"))
    assert saved["workspace"] == {"keep": True} and saved["api_key"] == LOGIC_KEY  # other keys untouched
    assert saved["service_models"]["vision_model"]["api_key"] == VISION_KEY

    # Same address with a blank key keeps the secret.
    client.put("/api/vision/service-models", json={"vision_model": {"base_url": "https://vlm.example/v1", "api_key": ""}})
    assert client.service_models.vision_config().api_key.get_secret_value() == VISION_KEY
    # A different address without a key must not inherit it.
    moved = client.put("/api/vision/service-models", json={"vision_model": {"base_url": "https://other.example/v1"}})
    assert moved.status_code == 422 and VISION_KEY not in moved.text

    # AISettings saving the global model later keeps service_models.
    client.ai.save({"base_url": RELAY, "model": "gemini-4-argon", "api_key": LOGIC_KEY})
    assert "service_models" in json.loads(ai_path.read_text(encoding="utf-8"))


def test_vision_model_name_only_reuses_logic_relay(tmp_path):
    client = make_client(tmp_path, env=VisionConfig())
    client.put("/api/vision/service-models", json={"vision_model": {"model": "qwen3.5-plus"}})
    config = client.service_models.vision_config()
    assert (config.base_url, config.model, config.source) == (RELAY, "qwen3.5-plus", "service_models")
    assert config.api_key.get_secret_value() == LOGIC_KEY  # one relay key, two models


@pytest.mark.parametrize("body", [
    {"vision_model": {"base_url": "ftp://x", "model": "m", "api_key": "k"}},
    {"vision_model": {"base_url": "https://x.example", "model": "m", "api_key": "k", "bbox_format": "polar"}},
    {"logic_model": {"base_url": "https://x.example", "model": "m", "api_key": "密钥"}},
    {"vision_model": {"base_url": "https://x.example", "model": "m", "api_key": 123}},
    {"dual_model_relay": "yes"},
    {"unknown": 1},
    ["not", "an", "object"],
])
def test_service_models_validation(tmp_path, body):
    res = make_client(tmp_path).put("/api/vision/service-models", json=body)
    assert res.status_code == 422


def test_service_models_save_is_local_only_and_never_echoes_input(tmp_path):
    client = make_client(tmp_path)
    bad = client.put("/api/vision/service-models", content=b"{not json " + VISION_KEY.encode(),
                     headers={"content-type": "application/json"})
    assert bad.status_code == 422 and VISION_KEY not in bad.text
    foreign = client.put("/api/vision/service-models", json={}, headers={"origin": "https://evil.example"})
    assert foreign.status_code == 403
    remote = TestClient(client.app, client=("192.0.2.1", 50000))
    assert remote.put("/api/vision/service-models", json={}).status_code == 403


# ---------------------------------------------------------------- analyze: annotate

def test_annotate_relay_vlm_locates_logic_judges(tmp_path):
    vision = Recorder(lambda body: chat_reply(HANDWRITTEN))
    logic = Recorder(lambda body: chat_reply({"errors": [
        {"region_id": "r2", "note": "移项时 +2 移到右边应变为 -2，正确为 x=5-2", "leads_to": "r3"},
        {"region_id": "r3", "note": "受上一步影响，结果应为 x=3", "leads_to": None},
        {"region_id": "r9", "note": "不存在的区域", "leads_to": None},
    ], "summary": "移项变号出错"}))
    client = make_client(tmp_path, vision=vision, logic=logic)
    res = analyze(client, image_url=data_url(png()), prompt="帮我看看哪里错了", mode="auto")
    assert res.status_code == 200, res.text
    body = res.json()

    assert body["scene"] == "handwriting" and body["mode"] == "annotate"
    assert body["models"] == {"vision": "qwen3.5-plus", "vision_source": "env", "judge": "logic",
                              "logic": "gemini-4-argon"}
    widget = body["widget"]
    assert widget["type"] == "image_annotator" and widget["image_id"].startswith("img_")
    assert "imageUrl" not in widget and (widget["width"], widget["height"]) == (640, 480)
    assert [a["id"] for a in widget["annotations"]] == ["r2", "r3"]  # invented r9 dropped
    assert widget["annotations"][0]["bbox"] == [250, 100, 350, 900]  # xyxy -> [ymin, xmin, ymax, xmax]
    assert widget["annotations"][0]["arrow_to"] == "r3"
    assert widget["annotations"][0]["label"].startswith("移项时") and widget["summary"] == "移项变号出错"
    assert body["recommended_effort"] == "medium"

    # Eyes and brain are separate calls; the brain never sees pixels or coordinates.
    assert len(vision.bodies) == 1 and len(logic.bodies) == 1
    assert vision.bodies[0]["model"] == "qwen3.5-plus" and vision.bodies[0]["auth"] == f"Bearer {VISION_KEY}"
    assert "不评价对错" in vision.bodies[0]["messages"][0]["content"]
    logic_text = json.dumps(logic.bodies[0]["messages"], ensure_ascii=False)
    assert logic.bodies[0]["model"] == "gemini-4-argon" and "data:image" not in logic_text
    assert "bbox" not in logic_text and "x=5+2" in logic_text

    relay = body["relay_prompt"]
    assert "base64" not in relay and body["image"]["marker"] in relay
    assert "①「x=5+2」" in relay and "【建议思考强度】medium" in relay
    # Coordinates and authoritative widget JSON are attached by the host after inference, never shown to the brain.
    assert "bbox" not in relay and "```knowgap-widget" not in relay
    assert "```knowgap-widget" in body["widget_markdown"] and '"bbox"' in body["widget_markdown"]


def test_annotate_single_model_fallback_when_relay_off(tmp_path):
    vision = Recorder(lambda body: chat_reply({**HANDWRITTEN, "errors": [
        {"region_id": "r2", "note": "移项没有变号"}, {"region_id": "r7", "note": "越界"}], "summary": "一处错误"}))
    logic = Recorder(lambda body: pytest.fail("logic model must not be called"))
    client = make_client(tmp_path, vision=vision, logic=logic)
    client.put("/api/vision/service-models", json={"dual_model_relay": False})
    body = analyze(client, image_url=data_url(png()), mode="annotate").json()
    assert body["models"]["judge"] == "vision"
    assert [a["id"] for a in body["widget"]["annotations"]] == ["r2"]
    assert "region_id" in vision.bodies[0]["messages"][0]["content"]  # judging prompt


def test_annotate_falls_back_to_vision_when_logic_model_missing(tmp_path):
    vision = Recorder(lambda body: chat_reply({**HANDWRITTEN, "errors": [], "summary": "全对"}))
    client = make_client(tmp_path, vision=vision, logic_configured=False)
    body = analyze(client, image_url=data_url(png()), mode="annotate").json()
    assert body["models"]["judge"] == "vision" and body["widget"]["annotations"] == []
    assert body["widget"]["title"] == "作答检查" and "没有发现明显错误" in body["relay_prompt"]


def test_annotate_without_regions_is_rejected(tmp_path):
    client = make_client(tmp_path, vision=lambda r: chat_reply({"kind": "handwritten", "regions": []}),
                         logic=lambda r: pytest.fail("not reached"))
    res = analyze(client, image_url=data_url(png()), mode="annotate")
    assert res.status_code == 422 and "清晰" in res.json()["detail"]


def test_logic_model_garbage_is_502(tmp_path):
    client = make_client(tmp_path, vision=lambda r: chat_reply(HANDWRITTEN),
                         logic=lambda r: chat_reply({"verdict": "bad"}))
    res = analyze(client, image_url=data_url(png()), mode="annotate")
    assert res.status_code == 502 and "主力逻辑模型" in res.json()["detail"]


# ---------------------------------------------------------------- analyze: circuit

def test_circuit_confirm_first_card_and_cache(tmp_path):
    vision = Recorder(lambda body: chat_reply(CIRCUIT))
    client = make_client(tmp_path, vision=vision, logic=lambda r: pytest.fail("no solving before confirmation"))
    first = analyze(client, image_url=data_url(png()), mode="auto").json()
    assert first["scene"] == "circuit" and first["mode"] == "circuit"
    widget = first["widget"]
    assert widget["type"] == "circuit_netlist" and widget["netlist_id"].startswith("net_")
    assert widget["confirm_required"] is True and widget["uncertain"] == ["R2"]
    assert [b["id"] for b in widget["branches"]] == ["Us", "R1", "R2"]
    assert first["recommended_effort"] == "low"  # 3 nodes, one loop, one source
    assert first["relay_effort"] == "low" and "不要列 KCL/KVL 方程" in first["relay_prompt"]
    assert "R1（R 10Ω）" in first["structured_problem"]

    again = analyze(client, image_id=first["image"]["image_id"], mode="circuit").json()
    assert again["widget"]["netlist_id"] == widget["netlist_id"] and again["cached"] is True
    assert len(vision.bodies) == 1  # extraction reused


def test_circuit_without_confirmation_card(tmp_path):
    client = make_client(tmp_path, vision=lambda r: chat_reply(CIRCUIT))
    client.put("/api/vision/service-models", json={"circuit_confirm_first": False})
    body = analyze(client, image_url=data_url(png()), mode="circuit").json()
    assert "netlist_id" not in body["widget"] and body["widget"]["confirm_required"] is False
    assert "KCL/KVL" in body["relay_prompt"] and "不要列" not in body["relay_prompt"]


def test_circuit_mode_on_non_circuit_image(tmp_path):
    client = make_client(tmp_path, vision=lambda r: chat_reply({**HANDWRITTEN, "kind": "problem"}))
    res = analyze(client, image_url=data_url(png()), mode="circuit")
    assert res.status_code == 422 and "电路网表" in res.json()["detail"]


def test_extract_mode_and_concept_routing(tmp_path):
    client = make_client(tmp_path, vision=lambda r: chat_reply(
        {"kind": "problem", "transcript": "什么是最小项？", "steps": 1, "category": "concept", "regions": []}))
    body = analyze(client, image_url=data_url(png()), prompt="讲讲这题").json()
    assert body["mode"] == "extract" and body["scene"] == "general" and body["widget"] is None
    assert body["recommended_effort"] == "low" and "概念" in body["route"]["reason"]
    assert body["structured_problem"] == "什么是最小项？" and "讲讲这题" in body["relay_prompt"]


# ---------------------------------------------------------------- analyze: image sources

def test_public_url_goes_to_provider_unfetched(tmp_path):
    vision = Recorder(lambda body: chat_reply(HANDWRITTEN))
    client = make_client(tmp_path, vision=vision, logic=lambda r: chat_reply({"errors": [], "summary": ""}))
    url = "https://cdn.example.com/hw.png"
    body = analyze(client, image_url=url, mode="annotate").json()
    assert vision.bodies[0]["messages"][1]["content"][0]["image_url"]["url"] == url
    assert body["widget"]["imageUrl"] == url and "image_id" not in body["widget"]
    assert body["image"]["marker"] is None


@pytest.mark.parametrize("url", [
    "http://127.0.0.1/a.png", "http://localhost:8000/a.png", "http://10.0.0.5/a.png", "http://192.168.1.2/a.png",
    "http://[::1]/a.png", "http://169.254.169.254/latest", "http://intranet/a.png", "http://nas.local/a.png",
    "https://user:pw@cdn.example.com/a.png", "file:///etc/passwd", "javascript:alert(1)",
])
def test_private_or_invalid_urls_rejected_before_any_call(tmp_path, url):
    client = make_client(tmp_path, vision=lambda r: pytest.fail("vision must not be called"))
    assert analyze(client, image_url=url).status_code == 422


def test_image_request_validation(tmp_path):
    client = make_client(tmp_path, vision=lambda r: pytest.fail("vision must not be called"))
    assert analyze(client).status_code == 422
    both = analyze(client, image_url=data_url(png()), image_id="img_" + "a" * 20)
    assert both.status_code == 422 and "其中之一" in both.json()["detail"]
    assert analyze(client, image_url="data:image/png;base64,@@@").status_code == 422
    assert analyze(client, image_url=data_url(b"<svg onload=alert(1)></svg>", "image/svg+xml")).status_code == 415
    fake_png = analyze(client, image_url=data_url(b"<svg onload=alert(1)></svg>"))
    assert fake_png.status_code == 415  # sniffed by content, not by the declared type
    assert analyze(client, image_id="img_" + "x" * 20).status_code == 404
    assert analyze(client, image_url="data:image/png;base64,AAAA", mode="draw").status_code == 422


def test_oversized_base64_rejected_without_echo(tmp_path):
    client = make_client(tmp_path, vision=lambda r: pytest.fail("vision must not be called"))
    big = data_url(b"\x00" * (10 * 1024 * 1024 + 100))
    res = analyze(client, image_url=big)
    assert res.status_code == 413 and len(res.text) < 500


def test_other_students_image_is_invisible(tmp_path):
    client = make_client(tmp_path, vision=lambda r: chat_reply(CIRCUIT))
    image_id = analyze(client, image_url=data_url(png()), mode="circuit").json()["image"]["image_id"]
    assert analyze(client, student="bob", image_id=image_id).status_code == 404
    assert analyze(client, student="bob", image_url=f"/api/vision/images/{image_id}").status_code == 404


def test_vision_provider_errors_surface_without_key(tmp_path):
    client = make_client(tmp_path, vision=lambda r: httpx.Response(401, text=VISION_KEY))
    res = analyze(client, image_url=data_url(png()))
    assert res.status_code == 503 and res.json()["detail"].startswith("多模态识图模型") and VISION_KEY not in res.text
    garbage = make_client(tmp_path / "g", vision=lambda r: httpx.Response(
        200, json={"choices": [{"finish_reason": "stop", "message": {"content": "我看不清这张图"}}]}))
    assert analyze(garbage, image_url=data_url(png())).status_code == 502


def test_vision_not_configured(tmp_path):
    client = make_client(tmp_path, env=VisionConfig(), logic_configured=False)
    res = analyze(client, image_url=data_url(png()))
    assert res.status_code == 503 and "服务模型" in res.json()["detail"]


# ---------------------------------------------------------------- images and netlists

def test_upload_and_fetch_own_image(tmp_path):
    client = make_client(tmp_path)
    res = client.post("/api/vision/images", files={"file": ("a.png", png(), "image/png")})
    assert res.status_code == 201
    body = res.json()
    assert body["marker"] == f"[[kg-image:{body['image_id']}]]"
    got = client.get(f"/api/vision/images/{body['image_id']}")
    assert got.status_code == 200 and got.content == png()
    assert got.headers["x-content-type-options"] == "nosniff"
    assert client.get(f"/api/vision/images/{body['image_id']}", headers={"x-test-student": "bob"}).status_code == 404
    fake = client.post("/api/vision/images", files={"file": ("evil.png", b"<svg onload=alert(1)>", "image/png")})
    assert fake.status_code == 415


def test_netlist_confirm_flow(tmp_path):
    client = make_client(tmp_path)
    netlist_id = client.store.create_netlist("alice", None, cn.parse_netlist(CIRCUIT["netlist"]).dump())["netlist_id"]
    view = client.get(f"/api/vision/netlists/{netlist_id}").json()
    assert view["version"] == 1 and view["recommended_effort"] == "low"
    assert client.get(f"/api/vision/netlists/{netlist_id}", headers={"x-test-student": "bob"}).status_code == 404

    branches = [*view["netlist"]["branches"][:2], {**view["netlist"]["branches"][2], "value": "30Ω"}]
    res = client.post(f"/api/vision/netlists/{netlist_id}/confirm",
                      json={"version": 1, "netlist": {**view["netlist"], "branches": branches}})
    assert res.status_code == 200
    body = res.json()
    assert body["version"] == 2 and body["confirmed"] is True
    assert body["marker"] == f"[[kg-netlist:{netlist_id}@2]]"
    assert "R2（R 30Ω）" in body["relay_prompt"] and "KCL/KVL" in body["relay_prompt"]

    assert client.post(f"/api/vision/netlists/{netlist_id}/confirm", json={"version": 1}).status_code == 409
    assert client.post(f"/api/vision/netlists/{netlist_id}/confirm", json={"version": 2}).status_code == 200


def test_netlist_with_errors_cannot_be_confirmed(tmp_path):
    client = make_client(tmp_path)
    broken = {"nodes": ["a", "b"], "branches": [
        {"id": "Us", "element": "V", "from": "a", "to": "b"},
        {"id": "F1", "element": "CCCS", "from": "a", "to": "b"},  # controlled source without control
    ]}
    netlist_id = client.store.create_netlist("alice", None, cn.parse_netlist(broken).dump())["netlist_id"]
    assert client.post(f"/api/vision/netlists/{netlist_id}/confirm", json={"version": 1}).status_code == 422
    res = client.post(f"/api/vision/netlists/{netlist_id}/confirm", json={"version": 1, "netlist": broken})
    assert res.status_code == 422 and res.json()["detail"]["issues"][0]["code"] == "missing_control"
    assert client.post("/api/vision/netlists/net_" + "x" * 20 + "/confirm", json={"version": 1}).status_code == 404

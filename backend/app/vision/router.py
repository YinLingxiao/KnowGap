"""Vision HTTP endpoints. Mounted by the integrator in main.py (see the PR description):

    from app.vision.router import vision_router
    from app.vision.settings import ServiceModels
    from app.vision.store import VisionStore
    app.include_router(vision_router(VisionStore.for_app(settings), ServiceModels(ai_settings),
                                     cors_origins=settings.cors_origins))

- GET  /api/vision/service-models             service-model configuration (keys masked)
- PUT  /api/vision/service-models             save it (local machine only)
- POST /api/vision/analyze                    VLM -> logic-model relay; returns scene, structured_problem,
                                              recommended_effort, widget, relay_prompt
- POST /api/vision/images                     upload one image (multipart field "file")
- GET  /api/vision/images/{image_id}          own image bytes (auth header required; shown via blob: URL)
- GET  /api/vision/netlists/{netlist_id}      latest netlist version with checks and recommended effort
- POST /api/vision/netlists/{netlist_id}/confirm   confirm as-is or with corrections
"""

import json
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, File, HTTPException, Request, Response, UploadFile
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app.agents.llm import ProviderError
from app.auth.deps import current_student
from app.vision import circuit_netlist as cn
from app.vision.pipeline import AnalysisError, analyze_image_for_relay, netlist_view
from app.vision.schemas import MAX_IMAGE_BYTES, MAX_IMAGE_URL_CHARS, VisionAnalyzeRequest
from app.vision.settings import ServiceModels
from app.vision.store import ImageRejected, VersionConflict, VisionStore

LOCAL_HOSTS = {"127.0.0.1", "::1", "testclient"}


class ConfirmNetlist(BaseModel):
    model_config = ConfigDict(extra="forbid")

    version: int = Field(ge=1)
    # null confirms the shown version as-is; an object submits the student's corrections.
    netlist: dict | None = None


def _local_page(origin: str) -> bool:
    return urlsplit(origin).hostname in {"127.0.0.1", "localhost", "::1"}


def _validation_message(exc: ValidationError) -> str:
    # Never echo the input: it may be a 10 MB data URL or contain a key.
    for error in exc.errors():
        if error.get("type") == "value_error":
            return str(error.get("msg", "")).removeprefix("Value error, ")
        if error.get("type") == "string_too_long" and error.get("loc", ())[:1] == ("image_url",):
            return "图片不能超过 10 MB，请压缩或裁剪后再上传。"
    return "请求格式无效，请检查 image_url / image_id、prompt 和 mode。"


def vision_router(
    store: VisionStore, service_models: ServiceModels, *, cors_origins: list[str] | None = None,
    vision_transport: httpx.AsyncBaseTransport | None = None,
    logic_transport: httpx.AsyncBaseTransport | None = None,
) -> APIRouter:
    router = APIRouter(prefix="/api/vision", tags=["视觉识图"])
    allowed_origins = set(cors_origins or [])

    def require_local(request: Request) -> None:
        # Same policy as /api/ai/config: changing models and keys is a local-demo facility.
        if not request.client or request.client.host not in LOCAL_HOSTS:
            raise HTTPException(403, "服务模型配置仅允许从本机修改。")
        origin = request.headers.get("origin")
        if origin and not _local_page(origin) and origin not in allowed_origins:
            raise HTTPException(403, "此页面无权修改服务模型配置。")

    async def json_body(request: Request, limit: int):
        # Parsed by hand: FastAPI's default validation errors echo the rejected input.
        raw = await request.body()
        if len(raw) > limit:
            raise HTTPException(413, "请求体过大：图片不能超过 10 MB。")
        try:
            return json.loads(raw or b"null")
        except ValueError:
            raise HTTPException(422, "请求格式无效，请提交 JSON 对象。") from None

    # ---- service models ----
    @router.get("/service-models")
    def get_service_models(response: Response):
        response.headers["Cache-Control"] = "no-store"
        return service_models.public()

    @router.put("/service-models")
    async def save_service_models(request: Request, response: Response):
        require_local(request)
        body = await json_body(request, 64 * 1024)
        response.headers["Cache-Control"] = "no-store"
        return service_models.save(body)

    # ---- analyze ----
    @router.post("/analyze")
    async def analyze(request: Request):
        body = await json_body(request, MAX_IMAGE_URL_CHARS + 8 * 1024)
        try:
            parsed = VisionAnalyzeRequest.model_validate(body)
        except ValidationError as exc:
            raise HTTPException(422, _validation_message(exc)) from None
        try:
            return await analyze_image_for_relay(
                parsed, service_models, store=store, student_id=current_student(),
                vision_transport=vision_transport, logic_transport=logic_transport,
            )
        except LookupError as exc:
            raise HTTPException(404, str(exc)) from None
        except ImageRejected as exc:
            raise HTTPException(exc.status, str(exc)) from None
        except AnalysisError as exc:
            raise HTTPException(422, str(exc)) from None
        except ProviderError as exc:
            raise HTTPException(exc.status_code, exc.detail) from None

    # ---- images ----
    @router.post("/images", status_code=201)
    async def upload_image(file: UploadFile = File(...)):
        data = await file.read(MAX_IMAGE_BYTES + 1)
        await file.close()
        try:
            meta = store.save_image(current_student(), data)
        except ImageRejected as exc:
            raise HTTPException(exc.status, str(exc)) from None
        return {key: meta[key] for key in ("image_id", "mime", "width", "height")} | {
            "marker": f"[[kg-image:{meta['image_id']}]]",
        }

    @router.get("/images/{image_id}")
    def get_image(image_id: str):
        found = store.image(current_student(), image_id)
        if found is None:
            raise HTTPException(404, "图片不存在或已删除。")
        data, meta = found
        return Response(data, media_type=meta["mime"], headers={
            "Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; sandbox",
        })

    # ---- netlists ----
    @router.get("/netlists/{netlist_id}")
    def get_netlist(netlist_id: str):
        record = store.netlist(current_student(), netlist_id)
        if record is None:
            raise HTTPException(404, "网表不存在或已删除。")
        return netlist_view(record)

    @router.post("/netlists/{netlist_id}/confirm")
    def confirm_netlist(netlist_id: str, body: ConfirmNetlist):
        student_id = current_student()
        record = store.netlist(student_id, netlist_id)
        if record is None:
            raise HTTPException(404, "网表不存在或已删除。")
        corrected = None
        if body.netlist is not None:
            try:
                parsed = cn.parse_netlist(body.netlist)
            except ValueError as exc:
                raise HTTPException(422, str(exc)) from None
            issues = cn.check_topology(parsed)
            if cn.has_errors(issues):
                raise HTTPException(422, {"message": "修正后的网表仍有错误，请先修改。",
                                          "issues": [issue.as_dict() for issue in issues]})
            corrected = parsed.dump()
        elif body.version == record["version"]:
            current = cn.parse_netlist(record["versions"][str(record["version"])])
            if cn.has_errors(cn.check_topology(current)):
                raise HTTPException(422, "当前网表有连接错误，请先修正再确认。")
        try:
            record = store.confirm_netlist(student_id, netlist_id, body.version, corrected)
        except LookupError as exc:
            raise HTTPException(404, str(exc)) from None
        except VersionConflict as exc:
            raise HTTPException(409, str(exc)) from None
        view = netlist_view(record)
        solve = ("【电路拓扑已确认，以下网表为准】\n" + view["netlist_text"]
                 + f"\n【建议思考强度】{view['recommended_effort']}（{view['route']['reason']}）\n"
                 "请先说明选用节点电压法还是网孔电流法，再写出 KCL/KVL 方程并求解。")
        return view | {"marker": f"[[kg-netlist:{netlist_id}@{record['version']}]]", "relay_prompt": solve}

    return router

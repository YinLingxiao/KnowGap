"""Contracts for the vision module: service-model configuration ("服务模型分工") and the analyze request."""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, SecretStr, StringConstraints, model_validator

BboxFormat = Literal["xyxy_1000", "yxyx_1000", "xyxy_pixel", "xyxy_unit"]
# How the vision model writes boxes. Everything is normalized to [ymin, xmin, ymax, xmax] on 0-1000.
#   xyxy_1000  [x1, y1, x2, y2] on 0-1000        (Qwen VL family; verified for qwen3.5-plus in eval/vision)
#   yxyx_1000  [ymin, xmin, ymax, xmax] on 0-1000 (Gemini box_2d)
#   xyxy_pixel [x1, y1, x2, y2] in pixels          (Qwen2.5-VL)
#   xyxy_unit  [x1, y1, x2, y2] on 0-1
BBOX_FORMATS: tuple[str, ...] = ("xyxy_1000", "yxyx_1000", "xyxy_pixel", "xyxy_unit")
Mode = Literal["auto", "annotate", "circuit", "extract"]
Scene = Literal["circuit", "handwriting", "general"]

MAX_IMAGE_BYTES = 10 * 1024 * 1024
# base64 inflates by 4/3; leave room for the data-URL header.
MAX_IMAGE_URL_CHARS = MAX_IMAGE_BYTES * 4 // 3 + 256

ModelName = Annotated[str, StringConstraints(strip_whitespace=True, max_length=200)]
BaseUrl = Annotated[str, StringConstraints(strip_whitespace=True, max_length=500)]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class LogicModelConfig(StrictModel):
    """Main logic and teaching model (the brain). Empty model: the global model from「设置 → 模型接入」.

    model only (no base_url / api_key): same provider and key as the global model, different model name.
    """

    base_url: BaseUrl = ""
    model: ModelName = ""
    api_key: SecretStr = SecretStr("")


class VisionModelConfig(LogicModelConfig):
    """Multimodal recognition and annotation model (the eyes).

    Empty model or enabled=False: VISION_* in backend/.env, then the logic model.
    model only: same provider and key as the logic model (one relay key, two models).
    """

    enabled: bool = True
    bbox_format: BboxFormat = "xyxy_1000"


class MemoryModelConfig(StrictModel):
    """Memory analysis and profile extraction model. Stored here; the chat service reads it once mounted."""

    model: ModelName = ""
    enabled: bool = False


class ServiceModelsConfig(StrictModel):
    logic_model: LogicModelConfig = Field(default_factory=LogicModelConfig)
    vision_model: VisionModelConfig = Field(default_factory=VisionModelConfig)
    memory_model: MemoryModelConfig = Field(default_factory=MemoryModelConfig)
    suggest_reply_enabled: bool = True
    # Images: VLM transcribes and locates, then the logic model judges and solves from text.
    dual_model_relay: bool = True
    # Circuits: show the netlist confirmation card before any KCL/KVL solving.
    circuit_confirm_first: bool = True


class VisionAnalyzeRequest(StrictModel):
    """Exactly one of image_url / image_id.

    image_url: data:image/...;base64,... (stored server-side, at most 10 MB), an http(s) URL (passed to
    the vision provider, never downloaded by this backend) or /api/vision/images/{image_id}.
    """

    image_url: Annotated[str, StringConstraints(strip_whitespace=True, max_length=MAX_IMAGE_URL_CHARS)] = ""
    image_id: Annotated[str, StringConstraints(strip_whitespace=True, max_length=60)] = ""
    prompt: Annotated[str, StringConstraints(strip_whitespace=True, max_length=2000)] = ""
    mode: Mode = "auto"

    @model_validator(mode="after")
    def one_image(self):
        if bool(self.image_url) == bool(self.image_id):
            raise ValueError("请提供 image_url 或 image_id 其中之一。")
        return self

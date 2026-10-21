/** /api/vision/* client. snake_case wire fields are mapped here and nowhere else. */
import { ApiError, type ApiErrorKind } from "./errors";
import { authHeader, request } from "./http-client";
import { API_BASE_URL } from "../config";

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const ACCEPTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];

/* eslint-disable @typescript-eslint/no-explicit-any -- wire payloads are mapped field by field */
type Wire = any;

// ---------------------------------------------------------------- errors

export interface VisionIssue {
  level: "error" | "warning";
  code: string;
  message: string;
  ref: string | null;
}

export class VisionApiError extends ApiError {
  readonly issues: VisionIssue[];

  constructor(kind: ApiErrorKind, message: string, status?: number, issues: VisionIssue[] = []) {
    super(kind, message, status);
    this.name = "VisionApiError";
    this.issues = issues;
  }
}

function kindOf(status: number): ApiErrorKind {
  if (status === 409) return "conflict";
  if (status === 404) return "not_found";
  if (status === 400 || status === 413 || status === 415 || status === 422) return "validation";
  if (status === 502 || status === 503) return "model_unavailable";
  return "server";
}

function noteUnauthorized(status: number) {
  if (status !== 401) return;
  try {
    localStorage.removeItem("knowgap.auth.token.v1");
    window.dispatchEvent(new Event("knowgap:auth-expired"));
  } catch { /* private mode */ }
}

function parseIssues(raw: unknown): VisionIssue[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item: Wire) => (item && typeof item.message === "string"
    ? [{ level: item.level === "error" ? "error" : "warning", code: String(item.code ?? ""),
         message: item.message, ref: item.ref ? String(item.ref) : null } as VisionIssue]
    : []));
}

/** fetch with JSON body that keeps structured 422 details ({message, issues}) for the netlist card. */
async function postJson(path: string, payload: unknown, timeoutMs = 30_000): Promise<Wire> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", ...authHeader() },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch {
    throw new VisionApiError(controller.signal.aborted ? "timeout" : "network",
      controller.signal.aborted ? "识图耗时过长，请稍后重试。" : "无法连接到后端服务，请稍后重试。");
  } finally {
    clearTimeout(timer);
  }
  const body: Wire = await response.json().catch(() => null);
  if (!response.ok) {
    noteUnauthorized(response.status);
    const detail = body?.detail;
    const message = typeof detail === "string" ? detail
      : typeof detail?.message === "string" ? detail.message : `请求失败（HTTP ${response.status}）`;
    throw new VisionApiError(kindOf(response.status), message, response.status, parseIssues(detail?.issues));
  }
  return body ?? {};
}

// ---------------------------------------------------------------- service models

export type BboxFormat = "xyxy_1000" | "yxyx_1000" | "xyxy_pixel" | "xyxy_unit";
export type ModelSource = "global" | "service_models" | "env" | "logic" | "none";

export interface EffectiveModel {
  model: string;
  source: ModelSource;
  configured: boolean;
}

export interface ServiceModels {
  logicModel: { baseUrl: string; model: string; apiKeyConfigured: boolean; effective: EffectiveModel };
  visionModel: {
    baseUrl: string; model: string; enabled: boolean; bboxFormat: BboxFormat; apiKeyConfigured: boolean;
    effective: EffectiveModel & { bboxFormat: BboxFormat };
  };
  memoryModel: { model: string; enabled: boolean; effective: { model: string; source: ModelSource } };
  suggestReplyEnabled: boolean;
  dualModelRelay: boolean;
  circuitConfirmFirst: boolean;
}

/** Fields to change. api_key: omit or "" keeps the saved key for the same address. */
export interface ServiceModelsPatch {
  logicModel?: { baseUrl?: string; model?: string; apiKey?: string } | null;
  visionModel?: { baseUrl?: string; model?: string; apiKey?: string; enabled?: boolean; bboxFormat?: BboxFormat } | null;
  memoryModel?: { model?: string; enabled?: boolean } | null;
  suggestReplyEnabled?: boolean;
  dualModelRelay?: boolean;
  circuitConfirmFirst?: boolean;
}

function effective(raw: Wire): EffectiveModel {
  return { model: String(raw?.model ?? ""), source: (raw?.source ?? "none") as ModelSource, configured: raw?.configured === true };
}

function toServiceModels(data: Wire): ServiceModels {
  const logic = data?.logic_model ?? {};
  const vision = data?.vision_model ?? {};
  const memory = data?.memory_model ?? {};
  return {
    logicModel: { baseUrl: String(logic.base_url ?? ""), model: String(logic.model ?? ""),
                  apiKeyConfigured: logic.api_key_configured === true, effective: effective(logic.effective) },
    visionModel: {
      baseUrl: String(vision.base_url ?? ""), model: String(vision.model ?? ""), enabled: vision.enabled !== false,
      bboxFormat: (vision.bbox_format ?? "xyxy_1000") as BboxFormat, apiKeyConfigured: vision.api_key_configured === true,
      effective: { ...effective(vision.effective), bboxFormat: (vision.effective?.bbox_format ?? "xyxy_1000") as BboxFormat },
    },
    memoryModel: { model: String(memory.model ?? ""), enabled: memory.enabled === true,
                   effective: { model: String(memory.effective?.model ?? ""), source: (memory.effective?.source ?? "logic") as ModelSource } },
    suggestReplyEnabled: data?.suggest_reply_enabled !== false,
    dualModelRelay: data?.dual_model_relay !== false,
    circuitConfirmFirst: data?.circuit_confirm_first !== false,
  };
}

function endpointWire(section: { baseUrl?: string; model?: string; apiKey?: string } | null | undefined) {
  if (section === null) return null;
  if (!section) return undefined;
  const out: Record<string, unknown> = {};
  if (section.baseUrl !== undefined) out.base_url = section.baseUrl.trim();
  if (section.model !== undefined) out.model = section.model.trim();
  if (section.apiKey) out.api_key = section.apiKey.trim();
  return out;
}

export async function getServiceModels(): Promise<ServiceModels> {
  return toServiceModels(await request<Wire>(API_BASE_URL, "/api/vision/service-models", { cache: "no-store" }));
}

export async function saveServiceModels(patch: ServiceModelsPatch): Promise<ServiceModels> {
  const body: Record<string, unknown> = {};
  const logic = endpointWire(patch.logicModel);
  if (logic !== undefined) body.logic_model = logic;
  const vision = endpointWire(patch.visionModel);
  if (vision !== undefined) {
    body.vision_model = vision === null ? null : {
      ...vision,
      ...(patch.visionModel?.enabled !== undefined ? { enabled: patch.visionModel.enabled } : {}),
      ...(patch.visionModel?.bboxFormat ? { bbox_format: patch.visionModel.bboxFormat } : {}),
    };
  }
  if (patch.memoryModel !== undefined) {
    body.memory_model = patch.memoryModel === null ? null : {
      ...(patch.memoryModel.model !== undefined ? { model: patch.memoryModel.model.trim() } : {}),
      ...(patch.memoryModel.enabled !== undefined ? { enabled: patch.memoryModel.enabled } : {}),
    };
  }
  if (patch.suggestReplyEnabled !== undefined) body.suggest_reply_enabled = patch.suggestReplyEnabled;
  if (patch.dualModelRelay !== undefined) body.dual_model_relay = patch.dualModelRelay;
  if (patch.circuitConfirmFirst !== undefined) body.circuit_confirm_first = patch.circuitConfirmFirst;
  return toServiceModels(await request<Wire>(API_BASE_URL, "/api/vision/service-models", {
    method: "PUT", body: JSON.stringify(body),
  }));
}

// ---------------------------------------------------------------- analyze

export type AnalyzeMode = "auto" | "annotate" | "circuit" | "extract";
export type Scene = "circuit" | "handwriting" | "general";
export type Effort = "off" | "low" | "medium" | "high";

export interface VisionRoute {
  effort: Effort;
  reason: string;
  source: "auto" | "user";
}

export interface VisionAnalysis {
  scene: Scene;
  mode: Exclude<AnalyzeMode, "auto">;
  structuredProblem: string;
  recommendedEffort: Effort;
  route: VisionRoute;
  /** effort for the relay turn itself (low while only a confirmation card is shown) */
  relayEffort: Effort;
  /** raw widget data, ready for <LearningWidget>: { type: "image_annotator" | "circuit_netlist", ... } */
  widget: Record<string, unknown> | null;
  /** authoritative widget code to prepend to the displayed/persisted assistant reply only after inference; never send it to a model */
  widgetMarkdown: string;
  /** send this as the user turn to the logic model; it contains no image data, image URL, or coordinates */
  relayPrompt: string;
  summary: string;
  image: { imageId: string | null; width: number | null; height: number | null; marker: string | null };
  models: { vision: string; judge: "logic" | "vision" | null; logic: string | null };
  cached: boolean;
}

function toRoute(raw: Wire): VisionRoute {
  return { effort: (raw?.effort ?? "medium") as Effort, reason: String(raw?.reason ?? ""), source: raw?.source === "user" ? "user" : "auto" };
}

/** image: a stored upload id, a data:image/...;base64 URL, or a public http(s) URL. */
export async function analyzeImage(
  image: { imageId: string } | { imageUrl: string }, options: { prompt?: string; mode?: AnalyzeMode } = {},
): Promise<VisionAnalysis> {
  const data = await postJson("/api/vision/analyze", {
    ...("imageId" in image ? { image_id: image.imageId } : { image_url: image.imageUrl }),
    prompt: options.prompt?.trim() ?? "",
    mode: options.mode ?? "auto",
  }, 150_000);
  return {
    scene: data.scene, mode: data.mode, structuredProblem: String(data.structured_problem ?? ""),
    recommendedEffort: data.recommended_effort, route: toRoute(data.route), relayEffort: data.relay_effort ?? data.recommended_effort,
    widget: data.widget && typeof data.widget === "object" ? data.widget : null,
    widgetMarkdown: String(data.widget_markdown ?? ""), relayPrompt: String(data.relay_prompt ?? ""),
    summary: String(data.summary ?? ""),
    image: { imageId: data.image?.image_id ?? null, width: data.image?.width ?? null, height: data.image?.height ?? null,
             marker: data.image?.marker ?? null },
    models: { vision: String(data.models?.vision ?? ""), judge: data.models?.judge ?? null, logic: data.models?.logic ?? null },
    cached: data.cached === true,
  };
}

// ---------------------------------------------------------------- images

export interface UploadedImage {
  imageId: string;
  mime: string;
  width: number;
  height: number;
  /** text to insert into the message, e.g. [[kg-image:img_x]] */
  marker: string;
}

export async function uploadImage(file: File): Promise<UploadedImage> {
  const form = new FormData();
  form.append("file", file, file.name || "image");
  const data = await request<Wire>(API_BASE_URL, "/api/vision/images", { method: "POST", body: form, timeoutMs: 60_000 });
  return {
    imageId: String(data.image_id), mime: String(data.mime), width: Number(data.width), height: Number(data.height),
    marker: String(data.marker ?? `[[kg-image:${data.image_id}]]`),
  };
}

// The image endpoint needs the Authorization header, which <img>/<image> cannot send, so images are
// fetched once and shown through blob: URLs shared by every widget and thumbnail on the page.
const imageUrls = new Map<string, Promise<string>>();

export function loadImageUrl(imageId: string): Promise<string> {
  const cached = imageUrls.get(imageId);
  if (cached) return cached;
  const pending = fetch(`${API_BASE_URL}/api/vision/images/${encodeURIComponent(imageId)}`, { headers: authHeader() })
    .then(async (response) => {
      if (!response.ok) {
        noteUnauthorized(response.status);
        throw new ApiError(kindOf(response.status), "图片无法加载", response.status);
      }
      return URL.createObjectURL(await response.blob());
    });
  pending.catch(() => imageUrls.delete(imageId));
  imageUrls.set(imageId, pending);
  return pending;
}

// ---------------------------------------------------------------- netlists

export async function getNetlist(netlistId: string): Promise<Record<string, unknown>> {
  return request<Wire>(API_BASE_URL, `/api/vision/netlists/${encodeURIComponent(netlistId)}`, { cache: "no-store" });
}

/** netlist = null confirms the shown version as-is; otherwise the corrections become a new version.
 *  The response carries `marker` and `relay_prompt` (the confirmed netlist plus a KCL/KVL solve request). */
export async function confirmNetlist(
  netlistId: string, version: number, netlist: Record<string, unknown> | null,
): Promise<Record<string, unknown>> {
  return postJson(`/api/vision/netlists/${encodeURIComponent(netlistId)}/confirm`, { version, netlist });
}

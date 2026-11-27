/** Shared request layer for the FastAPI wire contract; page view models live elsewhere. */
import { ApiError, type ApiErrorKind } from "./errors";
import { REQUEST_TIMEOUT_MS } from "../config";
import type { SourceReference } from "../types";

export interface WireSource {
  id: string; document_id: string; title: string; label: string;
  source?: "space" | "general" | null;
  page: number | null; start_line: number | null; end_line: number | null; excerpt: string;
}
export function mapSource(source: WireSource): SourceReference {
  return { id: source.id, documentId: source.document_id, title: source.title, label: source.label,
    source: source.source === "space" || source.source === "general" ? source.source : null,
    page: source.page, startLine: source.start_line, endLine: source.end_line, excerpt: source.excerpt };
}

interface RequestOptions extends RequestInit {
  timeoutMs?: number;
}

export async function request<T = unknown>(
  baseUrl: string, path: string,
  { timeoutMs = REQUEST_TIMEOUT_MS, headers, signal, ...init }: RequestOptions = {},
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // 调用方自己的取消（例如取消上传）：同样中断请求，但报「已取消」而不是「超时」
  const cancel = () => controller.abort();
  if (signal?.aborted) cancel();
  signal?.addEventListener("abort", cancel);
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init, headers: { Accept: "application/json", ...authHeader(), ...(init.body && !(init.body instanceof FormData) ? { "Content-Type": "application/json" } : {}), ...headers },
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = await readDetail(response);
      throw new ApiError(statusToKind(response.status), detail ?? `请求失败（HTTP ${response.status}）`, response.status);
    }
    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (signal?.aborted) throw new ApiError("cancelled", "已取消。");
    if (controller.signal.aborted) throw new ApiError("timeout", "请求超时，输入已保留。继续发送前请先刷新会话，核对是否已保存。");
    if (error instanceof SyntaxError) throw new ApiError("server", "后端返回了无法读取的数据，请稍后重试");
    throw new ApiError("network", "无法连接到后端服务");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}

async function readDetail(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.json();
    if (!body || typeof body !== "object" || !("detail" in body)) return null;
    const { detail } = body as { detail: unknown };
    if (typeof detail === "string") return detail;
    if (Array.isArray(detail)) return detail.map((item) =>
      item && typeof item === "object" && "msg" in item ? String(item.msg) : "").filter(Boolean).join("；");
    return null;
  } catch {
    return null;
  }
}

export function authHeader(): Record<string, string> {
  return {};
}

function statusToKind(status: number): ApiErrorKind {
  if (status === 409) return "conflict";
  if (status === 404) return "not_found";
  if (status === 400 || status === 413 || status === 415 || status === 422) return "validation";
  if (status === 408 || status === 504) return "timeout";
  if (status === 502 || status === 503) return "model_unavailable";
  if (status >= 500) return "server";
  return "unknown";
}

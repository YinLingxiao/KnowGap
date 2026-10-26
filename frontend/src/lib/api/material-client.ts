import { API_BASE_URL } from "../config";
import type { CourseMaterial, SourceReference } from "../types";
import { authHeader, mapSource, request, type WireSource } from "./http-client";
import { ApiError } from "./errors";

interface WireMaterial {
  id: string; title: string; kind: "pdf" | "txt" | "md" | "csv" | "docx" | "pptx" | "xlsx";
  page_count: number; chunk_count: number; created_at: string; subject_id?: string | null;
  size_bytes?: number;
}
function mapMaterial(data: WireMaterial): CourseMaterial {
  return { id: data.id, title: data.title, kind: data.kind, pageCount: data.page_count,
    chunkCount: data.chunk_count, createdAt: data.created_at, subjectId: data.subject_id ?? null,
    sizeBytes: data.size_bytes ?? 0 };
}
export function createMaterialClient(baseUrl = API_BASE_URL) {
  return {
    /** 默认列出全部；subjectId 只列该 Subject；unassigned 只列未归类资料 */
    async list(scope: { subjectId?: string; unassigned?: boolean } = {}): Promise<CourseMaterial[]> {
      const query = scope.subjectId ? `?subject_id=${encodeURIComponent(scope.subjectId)}` : scope.unassigned ? "?unassigned=true" : "";
      return (await request<WireMaterial[]>(baseUrl, `/api/materials${query}`)).map(mapMaterial);
    },
    async upload(file: File, subjectId?: string): Promise<CourseMaterial> {
      const body = new FormData(); body.append("file", file);
      const query = subjectId ? `?subject_id=${encodeURIComponent(subjectId)}` : "";
      return mapMaterial(await request<WireMaterial>(baseUrl, `/api/materials${query}`, { method: "POST", body }));
    },
    async search(query: string): Promise<SourceReference[]> {
      return (await request<WireSource[]>(baseUrl, `/api/materials/search?q=${encodeURIComponent(query)}`)).map(mapSource);
    },
    /** 大纲（标题列表）：用于 PPTX / 旧版 doc·ppt 的「大纲预览」降级视图 */
    async outline(id: string): Promise<string[]> {
      const data = await request<{ outline: string[] }>(baseUrl, `/api/materials/${encodeURIComponent(id)}/outline`);
      return data.outline;
    },
    /** 取回原始文件字节，供预览面板本地渲染；不同于 chat/api.ts 的 downloadFile，这里返回 Blob 而不是触发保存 */
    async downloadBytes(id: string): Promise<Blob> {
      let response: Response;
      try {
        response = await fetch(`${baseUrl}/api/files/${encodeURIComponent(id)}/download`, { headers: authHeader() });
      } catch {
        throw new ApiError("network", "无法连接到后端服务，文件没有取到。");
      }
      if (!response.ok) {
        throw new ApiError(response.status === 404 ? "not_found" : "server",
          response.status === 404 ? "文件已经不在了。" : `取回文件失败（HTTP ${response.status}）`, response.status);
      }
      return response.blob();
    },
    async remove(id: string): Promise<void> {
      await request(baseUrl, `/api/materials/${encodeURIComponent(id)}`, { method: "DELETE" });
    },
  };
}

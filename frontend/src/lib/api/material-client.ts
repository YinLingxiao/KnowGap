import { API_BASE_URL } from "../config";
import type { CourseMaterial, SourceReference } from "../types";
import { mapSource, request, type WireSource } from "./http-client";

interface WireMaterial {
  id: string; title: string; kind: "pdf" | "txt" | "md";
  page_count: number; chunk_count: number; created_at: string; subject_id?: string | null;
}
function mapMaterial(data: WireMaterial): CourseMaterial {
  return { id: data.id, title: data.title, kind: data.kind, pageCount: data.page_count,
    chunkCount: data.chunk_count, createdAt: data.created_at, subjectId: data.subject_id ?? null };
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
    async remove(id: string): Promise<void> {
      await request(baseUrl, `/api/materials/${encodeURIComponent(id)}`, { method: "DELETE" });
    },
  };
}

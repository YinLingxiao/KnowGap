import { API_BASE_URL } from "../config";
import type { CourseMaterial, SourceReference } from "../types";
import { mapSource, request, type WireSource } from "./http-client";

interface WireMaterial {
  id: string; title: string; kind: "pdf" | "txt" | "md";
  page_count: number; chunk_count: number; created_at: string;
}
function mapMaterial(data: WireMaterial): CourseMaterial {
  return { id: data.id, title: data.title, kind: data.kind, pageCount: data.page_count,
    chunkCount: data.chunk_count, createdAt: data.created_at };
}
export function createMaterialClient(baseUrl = API_BASE_URL) {
  return {
    async list(): Promise<CourseMaterial[]> {
      return (await request<WireMaterial[]>(baseUrl, "/api/materials")).map(mapMaterial);
    },
    async upload(file: File): Promise<CourseMaterial> {
      const body = new FormData(); body.append("file", file);
      return mapMaterial(await request<WireMaterial>(baseUrl, "/api/materials", { method: "POST", body }));
    },
    async search(query: string): Promise<SourceReference[]> {
      return (await request<WireSource[]>(baseUrl, `/api/materials/search?q=${encodeURIComponent(query)}`)).map(mapSource);
    },
    async remove(id: string): Promise<void> {
      await request(baseUrl, `/api/materials/${encodeURIComponent(id)}`, { method: "DELETE" });
    },
  };
}

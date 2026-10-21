/**
 * 空间知识迷雾拓扑图的外环。内环与中环来自 insights，本接口只返回模型推导的待解锁概念。
 */
import { request } from "@/lib/api/http-client";
import { API_BASE_URL } from "@/lib/config";

/* eslint-disable @typescript-eslint/no-explicit-any -- wire payloads are mapped field by field below */
type Wire = any;

export interface FogConcept {
  id: string;
  name: string;
  summary: string;
  relatedIds: string[];
}

export interface ConceptGraphResult {
  subjectId: string;
  generatedAt: string;
  cached: boolean;
  degraded: boolean;
  notice: string | null;
  model: string | null;
  nodes: FogConcept[];
}

export function mapConceptGraph(data: Wire): ConceptGraphResult {
  return {
    subjectId: data.subject_id,
    generatedAt: data.generated_at ?? "",
    cached: Boolean(data.cached),
    degraded: Boolean(data.degraded),
    notice: data.notice ?? null,
    model: data.model ?? null,
    nodes: (data.nodes ?? []).map((node: Wire) => ({
      id: node.id,
      name: node.name,
      summary: node.summary,
      relatedIds: node.related_ids ?? [],
    })),
  };
}

const root = API_BASE_URL;

export const conceptGraphApi = {
  /** force=true 跳过缓存，重新调用模型。模型失败时外环为空并带 notice，不会 500。 */
  async get(subjectId: string, options: { force?: boolean } = {}): Promise<ConceptGraphResult> {
    return mapConceptGraph(await request(root, `/api/subjects/${encodeURIComponent(subjectId)}/concept-graph`, {
      method: "POST",
      body: JSON.stringify({ force: Boolean(options.force) }),
      timeoutMs: 90_000,
    }));
  },
};

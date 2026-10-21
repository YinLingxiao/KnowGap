/**
 * 学习空间聚合数据（insights）与考前一页纸（cheatsheet）。
 * 接口约定见 docs/contracts/subject-insights.md；snake_case 只在本文件内出现。
 */
import { request } from "@/lib/api/http-client";
import { API_BASE_URL } from "@/lib/config";
import type { Level, LearnerMemoryStatus } from "./types";

/* eslint-disable @typescript-eslint/no-explicit-any -- wire payloads are mapped field by field below */
type Wire = any;

export interface InsightEvidence {
  quote: string;
  reason: string;
  signal: "supports" | "contradicts";
  conversationId: string | null;
  messageId: string | null;
  sourceAvailable: boolean;
  createdAt: string;
}

export interface InsightMemory {
  id: string;
  kind: "misconception" | "mastery";
  topic: string;
  topicKey: string | null;
  summary: string;
  status: LearnerMemoryStatus;
  confidence: number;
  userCorrected: boolean;
  tags: string[];
  evidence: InsightEvidence[];
  createdAt: string;
  updatedAt: string;
  /** 仅 mastered 列表：已掌握类记忆，或已解决的误区 */
  source?: "mastery" | "resolved_misconception";
}

export interface InsightThread {
  id: string;
  title: string;
  status: "open" | "resolved";
  summary: string;
  takeaways: string[];
  memoryIds: string[];
  anchorMessageId: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

export interface InsightStats {
  misconceptions: number;
  toReview: number;
  improving: number;
  mastered: number;
  evidence: number;
  threadsOpen: number;
  threadsResolved: number;
  materials: number;
  lastStudiedAt: string | null;
  daysToDeadline: number | null;
}

export interface SubjectInsights {
  schemaVersion: number;
  subject: {
    id: string; name: string; description: string; goal: string; level: Level | null;
    deadline: string | null; color: string; mainConversationId: string | null;
  };
  stats: InsightStats;
  misconceptions: InsightMemory[];
  mastered: InsightMemory[];
  threads: InsightThread[];
  materials: Array<{ id: string; title: string; kind: string; chunkCount: number; createdAt: string }>;
}

export interface CheatSheet {
  subjectId: string;
  subject: { id: string; name: string; goal: string; level: Level | null; deadline: string | null };
  stats: InsightStats;
  generatedAt: string;
  cached: boolean;
  degraded: boolean;
  notice: string | null;
  model: string | null;
  sections: {
    pitfalls: Array<{ memoryId: string; topic: string; summary: string; status: LearnerMemoryStatus; quotes: string[] }>;
    conclusions: Array<{ threadId: string; title: string; summary: string; takeaways: string[] }>;
    formulas: Array<{ name: string; formula: string; conditions: string; pitfall: string }>;
    contrasts: Array<{ a: string; b: string; difference: string; tip: string }>;
    quiz: Array<{ question: string; answer: string }>;
  };
  markdown: string;
}

function mapStats(data: Wire): InsightStats {
  return {
    misconceptions: data.misconceptions, toReview: data.to_review, improving: data.improving,
    mastered: data.mastered, evidence: data.evidence, threadsOpen: data.threads_open,
    threadsResolved: data.threads_resolved, materials: data.materials,
    lastStudiedAt: data.last_studied_at ?? null, daysToDeadline: data.days_to_deadline ?? null,
  };
}

function mapMemory(data: Wire): InsightMemory {
  return {
    id: data.id, kind: data.kind, topic: data.topic, topicKey: data.topic_key ?? null, summary: data.summary,
    status: data.status, confidence: data.confidence, userCorrected: data.user_corrected, tags: data.tags ?? [],
    evidence: (data.evidence ?? []).map((e: Wire) => ({
      quote: e.quote, reason: e.reason, signal: e.signal, conversationId: e.conversation_id ?? null,
      messageId: e.message_id ?? null, sourceAvailable: e.source_available, createdAt: e.created_at,
    })),
    createdAt: data.created_at, updatedAt: data.updated_at,
    ...(data.source ? { source: data.source } : {}),
  };
}

export function mapInsights(data: Wire): SubjectInsights {
  const s = data.subject;
  return {
    schemaVersion: data.schema_version,
    subject: {
      id: s.id, name: s.name, description: s.description, goal: s.goal, level: s.level ?? null,
      deadline: s.deadline ?? null, color: s.color, mainConversationId: s.main_conversation_id ?? null,
    },
    stats: mapStats(data.stats),
    misconceptions: (data.misconceptions ?? []).map(mapMemory),
    mastered: (data.mastered ?? []).map(mapMemory),
    threads: (data.threads ?? []).map((t: Wire) => ({
      id: t.id, title: t.title, status: t.status, summary: t.summary, takeaways: t.takeaways ?? [],
      memoryIds: t.memory_ids ?? [], anchorMessageId: t.anchor_message_id ?? null,
      createdAt: t.created_at, updatedAt: t.updated_at, resolvedAt: t.resolved_at ?? null,
    })),
    materials: (data.materials ?? []).map((m: Wire) => ({
      id: m.id, title: m.title, kind: m.kind, chunkCount: m.chunk_count, createdAt: m.created_at,
    })),
  };
}

export function mapCheatSheet(data: Wire): CheatSheet {
  const sec = data.sections ?? {};
  return {
    subjectId: data.subject_id,
    subject: { ...data.subject, level: data.subject.level ?? null, deadline: data.subject.deadline ?? null },
    stats: mapStats(data.stats),
    generatedAt: data.generated_at, cached: data.cached, degraded: data.degraded,
    notice: data.notice ?? null, model: data.model ?? null,
    sections: {
      pitfalls: (sec.pitfalls ?? []).map((p: Wire) => ({
        memoryId: p.memory_id, topic: p.topic, summary: p.summary, status: p.status, quotes: p.quotes ?? [],
      })),
      conclusions: (sec.conclusions ?? []).map((c: Wire) => ({
        threadId: c.thread_id, title: c.title, summary: c.summary, takeaways: c.takeaways ?? [],
      })),
      formulas: sec.formulas ?? [],
      contrasts: sec.contrasts ?? [],
      quiz: sec.quiz ?? [],
    },
    markdown: data.markdown ?? "",
  };
}

const root = API_BASE_URL;
const base = (subjectId: string) => `/api/subjects/${encodeURIComponent(subjectId)}`;

export const insightsApi = {
  async getInsights(subjectId: string): Promise<SubjectInsights> {
    return mapInsights(await request(root, `${base(subjectId)}/insights`, { cache: "no-store" }));
  },
  /** force=true 跳过缓存重新调用模型；notes 为浏览器里的空间 Pages 笔记，可作补充素材。 */
  async getCheatSheet(subjectId: string, options: { force?: boolean; notes?: string } = {}): Promise<CheatSheet> {
    return mapCheatSheet(await request(root, `${base(subjectId)}/cheatsheet`, {
      method: "POST",
      body: JSON.stringify({ force: Boolean(options.force), notes: (options.notes ?? "").slice(0, 20000) }),
      // 模型生成最长约 60 秒，留出余量。
      timeoutMs: 90_000,
    }));
  },
};

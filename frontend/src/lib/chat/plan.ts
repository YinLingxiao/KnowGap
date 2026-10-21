/**
 * 对话学习计划：类型、映射与 API。接口约定见 docs/contracts/learning-plan.md；snake_case 只在本文件内出现。
 */
import { request } from "@/lib/api/http-client";
import { API_BASE_URL } from "@/lib/config";

/* eslint-disable @typescript-eslint/no-explicit-any -- wire payloads are mapped field by field below */
type Wire = any;

export type PlanStepStatus = "pending" | "in_progress" | "awaiting_learner" | "done" | "skipped";

export interface PlanStep {
  id: string;
  title: string;
  status: PlanStepStatus;
  note: string;
  threadId: string | null;
  completedMessageId: string | null;
  updatedAt: string | null;
}

export interface LearningPlan {
  conversationId: string;
  version: number;
  steps: PlanStep[];
  completedAt: string | null;
  updatedAt: string | null;
}

/** 助手消息 meta 里的计划变更，用于时间线标记 */
export interface PlanChange {
  stepId: string;
  title: string;
  from: PlanStepStatus | null;
  to: PlanStepStatus;
}

/** useChat 收到 SSE plan 事件后派发；detail: { conversationId, plan } */
export const PLAN_EVENT = "knowgap:plan";

export interface PlanEventDetail {
  conversationId: string;
  plan: LearningPlan;
}

const STATUSES = new Set<PlanStepStatus>(["pending", "in_progress", "awaiting_learner", "done", "skipped"]);

function status(value: unknown): PlanStepStatus {
  return STATUSES.has(value as PlanStepStatus) ? value as PlanStepStatus : "pending";
}

function str(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

export function mapPlan(data: Wire, conversationId = ""): LearningPlan {
  return {
    conversationId: String(data?.conversation_id ?? conversationId),
    version: typeof data?.version === "number" ? data.version : 0,
    steps: Array.isArray(data?.steps) ? data.steps.map((step: Wire): PlanStep => ({
      id: String(step.id),
      title: String(step.title ?? ""),
      status: status(step.status),
      note: typeof step.note === "string" ? step.note : "",
      threadId: str(step.thread_id),
      completedMessageId: str(step.completed_message_id),
      updatedAt: str(step.updated_at),
    })) : [],
    completedAt: str(data?.completed_at),
    updatedAt: str(data?.updated_at),
  };
}

export function mapPlanChanges(raw: unknown): PlanChange[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((item) => item && typeof item === "object").map((item: Wire) => ({
    stepId: String(item.step_id ?? ""),
    title: String(item.title ?? ""),
    from: item.from == null ? null : status(item.from),
    to: status(item.to),
  }));
}

const base = (conversationId: string) => `/api/conversations/${encodeURIComponent(conversationId)}/plan`;

export const planApi = {
  async get(conversationId: string): Promise<LearningPlan> {
    return mapPlan(await request<Wire>(API_BASE_URL, base(conversationId), { cache: "no-store" }), conversationId);
  },
  async addStep(conversationId: string, title: string): Promise<LearningPlan> {
    return mapPlan(await request<Wire>(API_BASE_URL, `${base(conversationId)}/steps`, {
      method: "POST", body: JSON.stringify({ title }),
    }), conversationId);
  },
  async updateStep(
    conversationId: string, stepId: string, patch: { status?: "done" | "skipped" | "pending"; title?: string },
  ): Promise<LearningPlan> {
    return mapPlan(await request<Wire>(API_BASE_URL, `${base(conversationId)}/steps/${encodeURIComponent(stepId)}`, {
      method: "PATCH", body: JSON.stringify(patch),
    }), conversationId);
  },
  async deleteStep(conversationId: string, stepId: string): Promise<LearningPlan> {
    return mapPlan(await request<Wire>(API_BASE_URL, `${base(conversationId)}/steps/${encodeURIComponent(stepId)}`, {
      method: "DELETE",
    }), conversationId);
  },
  async clear(conversationId: string): Promise<void> {
    await request<void>(API_BASE_URL, base(conversationId), { method: "DELETE" });
  },
};

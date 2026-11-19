/**
 * 多智能体复习任务草稿（B6）。接口约定见 docs/后端接口约定.md 第 4 节；
 * 该接口当前尚未上线，前端按契约实现并用 mock 验证。
 */
import { request } from "@/lib/api/http-client";
import { API_BASE_URL } from "@/lib/config";

/* eslint-disable @typescript-eslint/no-explicit-any -- wire payloads are mapped field by field below */
type Wire = any;

const root = API_BASE_URL;

export type PlanAgentName = "diagnose" | "plan" | "review";

export interface PlanWeakPoint {
  memoryId?: string;
  topic?: string;
  summary?: string;
  due?: string;
  priority?: number;
}

export interface PlanTaskDraft {
  draftTaskId: string;
  title: string;
  memoryId?: string;
  evidence?: string;
  durationMinutes?: number | null;
  scheduledDate?: string | null;
  order?: number;
}

export interface PlanRejectedTask {
  draftTaskId?: string;
  code?: string;
  message?: string;
}

export type PlanAgentOutput =
  | { kind: "diagnose"; weakPoints: PlanWeakPoint[] }
  | { kind: "plan"; tasks: PlanTaskDraft[] }
  | { kind: "review"; approved: string[]; rejected: PlanRejectedTask[]; totalMinutes: number | null };

export interface PlanAgent {
  agent: PlanAgentName;
  startedAt?: string;
  finishedAt?: string;
  output: PlanAgentOutput;
}

export interface LearningPlanDraft {
  draftId: string;
  agents: PlanAgent[];
  tasks: PlanTaskDraft[];
}

export interface ConfirmedPlanTask {
  id: string;
  title: string;
  source?: string;
  durationMinutes?: number | null;
}

export interface LearningPlanConfirmResult {
  created: ConfirmedPlanTask[];
  skipped: string[];
}

const ORDER: Record<PlanAgentName, number> = { diagnose: 0, plan: 1, review: 2 };

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isAgentName(value: unknown): value is PlanAgentName {
  return value === "diagnose" || value === "plan" || value === "review";
}

export function mapTaskDraft(raw: Wire): PlanTaskDraft | null {
  if (!raw || typeof raw.draft_task_id !== "string" || !raw.draft_task_id) return null;
  return {
    draftTaskId: raw.draft_task_id,
    title: String(raw.title ?? ""),
    memoryId: str(raw.memory_id),
    evidence: str(raw.evidence),
    durationMinutes: num(raw.duration_minutes),
    scheduledDate: str(raw.scheduled_date) ?? null,
    order: num(raw.order) ?? undefined,
  };
}

function mapWeakPoint(raw: Wire): PlanWeakPoint | null {
  if (!raw || typeof raw !== "object") return null;
  const point: PlanWeakPoint = {
    memoryId: str(raw.memory_id),
    topic: str(raw.topic),
    summary: str(raw.summary),
    due: str(raw.due),
    priority: typeof raw.priority === "number" ? raw.priority : undefined,
  };
  return point.topic || point.summary || point.memoryId ? point : null;
}

function mapRejected(raw: Wire): PlanRejectedTask | null {
  if (!raw || typeof raw !== "object") return null;
  const item: PlanRejectedTask = {
    draftTaskId: str(raw.draft_task_id),
    code: str(raw.code),
    message: str(raw.message),
  };
  return item.draftTaskId || item.code || item.message ? item : null;
}

function mapOutput(agent: PlanAgentName, raw: Wire): PlanAgentOutput {
  if (agent === "diagnose") {
    return {
      kind: "diagnose",
      weakPoints: (Array.isArray(raw?.weak_points) ? raw.weak_points : []).flatMap((item: Wire) => {
        const point = mapWeakPoint(item);
        return point ? [point] : [];
      }),
    };
  }
  if (agent === "plan") {
    return {
      kind: "plan",
      tasks: (Array.isArray(raw?.tasks) ? raw.tasks : []).flatMap((item: Wire) => {
        const task = mapTaskDraft(item);
        return task ? [task] : [];
      }),
    };
  }
  return {
    kind: "review",
    approved: (Array.isArray(raw?.approved) ? raw.approved : []).filter((id: unknown): id is string => typeof id === "string"),
    rejected: (Array.isArray(raw?.rejected) ? raw.rejected : []).flatMap((item: Wire) => {
      const rejected = mapRejected(item);
      return rejected ? [rejected] : [];
    }),
    totalMinutes: num(raw?.total_minutes),
  };
}

export function mapDraft(raw: Wire): LearningPlanDraft {
  const rawAgents: Wire[] = Array.isArray(raw?.agents) ? raw.agents : [];
  const agents: PlanAgent[] = rawAgents.flatMap((item: Wire): PlanAgent[] => {
    if (!item || !isAgentName(item.agent)) return [];
    return [{
      agent: item.agent,
      startedAt: str(item.started_at),
      finishedAt: str(item.finished_at),
      output: mapOutput(item.agent, item.output),
    }];
  });
  agents.sort((a, b) => ORDER[a.agent] - ORDER[b.agent]);
  const rawTasks: Wire[] = Array.isArray(raw?.tasks) ? raw.tasks : [];
  const tasks: PlanTaskDraft[] = rawTasks.flatMap((item: Wire) => {
    const task = mapTaskDraft(item);
    return task ? [task] : [];
  });
  tasks.sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER));
  return { draftId: String(raw?.draft_id ?? ""), agents, tasks };
}

function mapConfirm(raw: Wire): LearningPlanConfirmResult {
  return {
    created: (Array.isArray(raw?.created) ? raw.created : []).flatMap((item: Wire): ConfirmedPlanTask[] => {
      if (!item || typeof item.id !== "string" || !item.id) return [];
      return [{
        id: item.id,
        title: String(item.title ?? ""),
        source: str(item.source),
        durationMinutes: num(item.duration_minutes),
      }];
    }),
    skipped: (Array.isArray(raw?.skipped) ? raw.skipped : []).filter((id: unknown): id is string => typeof id === "string"),
  };
}

export const learningPlanApi = {
  async draft(input: { subjectId: string; budgetMinutes: number; deadline: string }): Promise<LearningPlanDraft> {
    const data = await request<Wire>(root, "/api/learning/plans/draft", {
      method: "POST",
      timeoutMs: 120_000,
      body: JSON.stringify({
        subject_id: input.subjectId,
        budget_minutes: input.budgetMinutes,
        deadline: input.deadline,
      }),
    });
    return mapDraft(data);
  },

  async confirm(draftId: string, taskIds: string[]): Promise<LearningPlanConfirmResult> {
    const data = await request<Wire>(root, `/api/learning/plans/${encodeURIComponent(draftId)}/confirm`, {
      method: "POST",
      body: JSON.stringify({ task_ids: taskIds }),
    });
    return mapConfirm(data);
  },
};
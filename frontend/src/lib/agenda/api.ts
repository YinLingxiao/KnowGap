/**
 * 知隙日程 API 封装。接口约定见 docs/contracts/agenda.md；snake_case 只在本文件内出现。
 */
import { authHeader, request } from "@/lib/api/http-client";
import { ApiError } from "@/lib/api/errors";
import { API_BASE_URL } from "@/lib/config";
import type {
  AgendaFeed, AgendaTask, AgendaThread, BreakdownDraft, BreakdownRequest, TaskDraft, TaskInput, TaskPatch,
  TaskPriority,
} from "./types";

/* eslint-disable @typescript-eslint/no-explicit-any -- wire payloads are mapped field by field below */
type Wire = any;

const root = API_BASE_URL;

function str(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function priority(value: unknown): TaskPriority {
  return value === 1 || value === 2 || value === 3 ? value : 4;
}

export function mapTask(data: Wire): AgendaTask {
  const step = data.review_step;
  return {
    id: String(data.id),
    title: String(data.title ?? ""),
    notes: typeof data.notes === "string" ? data.notes : "",
    parentId: str(data.parent_id),
    priority: priority(data.priority),
    labels: Array.isArray(data.labels) ? data.labels.filter((label: unknown) => typeof label === "string") : [],
    subjectId: str(data.subject_id),
    threadId: str(data.thread_id),
    scheduledDate: str(data.scheduled_date),
    scheduledStartAt: str(data.scheduled_start_at),
    durationMinutes: typeof data.duration_minutes === "number" ? data.duration_minutes : null,
    deadlineDate: str(data.deadline_date),
    reminderMinutes: typeof data.reminder_minutes === "number" ? data.reminder_minutes : null,
    status: data.status === "done" || data.status === "cancelled" ? data.status : "open",
    completedAt: str(data.completed_at),
    source: data.source === "ai_breakdown" || data.source === "review" ? data.source : "manual",
    memoryId: str(data.memory_id),
    reviewStep: step === 1 || step === 2 || step === 3 ? step : null,
    sortOrder: typeof data.sort_order === "number" ? data.sort_order : 0,
    createdAt: String(data.created_at ?? ""),
    updatedAt: String(data.updated_at ?? ""),
  };
}

function mapThread(data: Wire): AgendaThread {
  return {
    threadId: String(data.thread_id),
    title: String(data.title ?? ""),
    subjectId: String(data.subject_id ?? ""),
    subjectName: String(data.subject_name ?? ""),
    subjectColor: typeof data.subject_color === "string" ? data.subject_color : "#3d6fdb",
    deadlineDate: str(data.deadline_date),
    updatedAt: String(data.updated_at ?? ""),
  };
}

const FIELDS: Record<string, string> = {
  title: "title", notes: "notes", parentId: "parent_id", priority: "priority", labels: "labels",
  subjectId: "subject_id", threadId: "thread_id", scheduledDate: "scheduled_date",
  scheduledStartAt: "scheduled_start_at", durationMinutes: "duration_minutes", deadlineDate: "deadline_date",
  reminderMinutes: "reminder_minutes",
  source: "source", status: "status", sortOrder: "sort_order",
};

/** camelCase → snake_case；undefined 不发送，null 原样发送（表示清空） */
function toWire(input: TaskInput | TaskPatch | TaskDraft): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && FIELDS[key]) body[FIELDS[key]] = value;
  }
  return body;
}

function mapDraft(data: Wire): TaskDraft {
  const task = mapTask({ id: "", ...data });
  return {
    title: task.title, notes: task.notes, priority: task.priority, labels: task.labels,
    scheduledDate: task.scheduledDate, scheduledStartAt: task.scheduledStartAt,
    durationMinutes: task.durationMinutes, deadlineDate: task.deadlineDate,
  };
}

function query(params: Record<string, string | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) search.set(key, value);
  const text = search.toString();
  return text ? `?${text}` : "";
}

export const agendaApi = {
  async listTasks(options: { status?: "open" | "done" | "all"; subjectId?: string | null } = {}): Promise<AgendaTask[]> {
    const data = await request<Wire>(root, `/api/agenda/tasks${query({ status: options.status, subject_id: options.subjectId })}`,
      { cache: "no-store" });
    return Array.isArray(data?.tasks) ? data.tasks.map(mapTask) : [];
  },

  async feed(range: { from?: string; to?: string } = {}): Promise<AgendaFeed> {
    const data = await request<Wire>(root, `/api/agenda/feed${query({ from: range.from, to: range.to })}`, { cache: "no-store" });
    return {
      today: String(data?.today ?? ""),
      tasks: Array.isArray(data?.tasks) ? data.tasks.map(mapTask) : [],
      threads: Array.isArray(data?.threads) ? data.threads.map(mapThread) : [],
    };
  },

  async createTask(input: TaskInput): Promise<AgendaTask> {
    return mapTask(await request<Wire>(root, "/api/agenda/tasks", { method: "POST", body: JSON.stringify(toWire(input)) }));
  },

  async createBatch(parent: TaskInput | null, children: TaskInput[]): Promise<{ parent: AgendaTask | null; children: AgendaTask[] }> {
    const data = await request<Wire>(root, "/api/agenda/tasks/batch", {
      method: "POST",
      body: JSON.stringify({ parent: parent ? toWire(parent) : null, children: children.map(toWire) }),
    });
    return {
      parent: data?.parent ? mapTask(data.parent) : null,
      children: Array.isArray(data?.children) ? data.children.map(mapTask) : [],
    };
  },

  async updateTask(id: string, patch: TaskPatch): Promise<AgendaTask> {
    return mapTask(await request<Wire>(root, `/api/agenda/tasks/${encodeURIComponent(id)}`, {
      method: "PATCH", body: JSON.stringify(toWire(patch)),
    }));
  },

  async deleteTask(id: string): Promise<void> {
    await request<void>(root, `/api/agenda/tasks/${encodeURIComponent(id)}`, { method: "DELETE" });
  },

  async breakdown(input: BreakdownRequest): Promise<BreakdownDraft> {
    const data = await request<Wire>(root, "/api/agenda/breakdown", {
      method: "POST",
      timeoutMs: 60_000,
      body: JSON.stringify({
        goal: input.goal, subject_id: input.subjectId ?? null, deadline_date: input.deadlineDate ?? null, today: input.today,
      }),
    });
    return {
      parent: mapDraft(data?.parent ?? {}),
      children: Array.isArray(data?.children) ? data.children.map(mapDraft) : [],
    };
  },

  /** 需要鉴权头，所以用 fetch 取 Blob，再由调用方触发下载 */
  async exportIcs(options: { status?: "open" | "all"; subjectId?: string | null } = {}): Promise<Blob> {
    const response = await fetch(`${root}/api/agenda/export.ics${query({ status: options.status, subject_id: options.subjectId })}`, {
      headers: { ...authHeader() },
    });
    if (!response.ok) throw new ApiError("server", `导出失败（HTTP ${response.status}）`, response.status);
    return await response.blob();
  },
};

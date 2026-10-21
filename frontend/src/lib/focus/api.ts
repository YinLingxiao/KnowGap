import { request } from "@/lib/api/http-client";
import { API_BASE_URL } from "@/lib/config";
import type { FocusHeatmap, FocusSession, HeatmapDay } from "./types";

type Wire = Record<string, unknown>;

function str(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function mapSession(data: Wire): FocusSession {
  const status = data.status === "completed" || data.status === "abandoned" ? data.status : null;
  return {
    id: String(data.id),
    studentId: String(data.student_id ?? ""),
    taskId: str(data.task_id),
    subjectId: str(data.subject_id),
    title: String(data.title ?? ""),
    plannedMinutes: typeof data.planned_minutes === "number" ? data.planned_minutes : 0,
    startedAt: String(data.started_at ?? ""),
    endedAt: str(data.ended_at),
    actualSeconds: typeof data.actual_seconds === "number" ? data.actual_seconds : null,
    status,
    note: typeof data.note === "string" ? data.note : null,
  };
}

function mapDay(data: Wire): HeatmapDay {
  return {
    date: String(data.date ?? ""),
    focusMinutes: typeof data.focus_minutes === "number" ? data.focus_minutes : 0,
    misconceptionsResolved: typeof data.misconceptions_resolved === "number" ? data.misconceptions_resolved : 0,
    threadsResolved: typeof data.threads_resolved === "number" ? data.threads_resolved : 0,
  };
}

const root = API_BASE_URL;

export const focusApi = {
  async start(input: { title: string; plannedMinutes: number; taskId?: string | null; subjectId?: string | null }) {
    return mapSession(await request<Wire>(root, "/api/focus/sessions", {
      method: "POST",
      body: JSON.stringify({
        title: input.title,
        planned_minutes: input.plannedMinutes,
        task_id: input.taskId ?? null,
        subject_id: input.subjectId ?? null,
      }),
    }));
  },

  async end(id: string, input: { status: "completed" | "abandoned"; note: string; actualSeconds?: number }) {
    return mapSession(await request<Wire>(root, `/api/focus/sessions/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({
        status: input.status,
        note: input.note,
        ...(input.actualSeconds != null ? { actual_seconds: input.actualSeconds } : {}),
      }),
    }));
  },

  async heatmap(weeks = 12): Promise<FocusHeatmap> {
    const data = await request<Wire>(root, `/api/focus/heatmap?weeks=${weeks}`);
    const days = Array.isArray(data.days) ? data.days.map((item) => mapDay(item as Wire)) : [];
    return {
      weeks: typeof data.weeks === "number" ? data.weeks : weeks,
      start: String(data.start ?? ""),
      end: String(data.end ?? ""),
      days,
    };
  },
};

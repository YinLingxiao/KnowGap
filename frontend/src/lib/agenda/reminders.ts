import type { AgendaTask } from "./types";

export const REMINDER_HORIZON_MS = 24 * 60 * 60 * 1000;
export const REMINDER_CATCHUP_MS = 10 * 60 * 1000;
type ReminderTask = Pick<AgendaTask, "id" | "status" | "scheduledStartAt" | "reminderMinutes">;

/** Floating agenda timestamps are intentionally interpreted in the device's local timezone. */
export function reminderTime(task: ReminderTask): number | null {
  if (task.status !== "open" || task.reminderMinutes == null || !task.scheduledStartAt) return null;
  const start = new Date(task.scheduledStartAt).getTime();
  return Number.isFinite(start) ? start - task.reminderMinutes * 60_000 : null;
}

export function reminderKey(taskId: string, at: number): string {
  return `${taskId}:${at}`;
}

export function reminderDelay(task: ReminderTask, now: number, delivered: ReadonlySet<string>): number | null {
  const at = reminderTime(task);
  if (at === null || delivered.has(reminderKey(task.id, at))) return null;
  const delay = at - now;
  return delay < -REMINDER_CATCHUP_MS || delay > REMINDER_HORIZON_MS ? null : Math.max(0, delay);
}

export function reminderBody(task: Pick<AgendaTask, "scheduledStartAt" | "durationMinutes">, subjectName?: string): string {
  return [task.scheduledStartAt?.slice(11, 16) + " 开始",
    task.durationMinutes == null ? null : `${task.durationMinutes} 分钟`, subjectName || "未归入空间"]
    .filter(Boolean).join(" · ");
}

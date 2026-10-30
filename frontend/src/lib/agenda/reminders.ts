import type { AgendaTask } from "./types";
import type { TranslatePhrase } from "@/lib/i18n";

/** 没有传入翻译函数时按原文插值，保持既有调用方的行为不变。 */
const raw: TranslatePhrase = (text, vars) =>
  vars ? text.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match)) : text;

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

export function reminderBody(
  task: Pick<AgendaTask, "scheduledStartAt" | "durationMinutes">,
  subjectName?: string,
  tx: TranslatePhrase = raw,
): string {
  return [
    tx("{time} 开始", { time: task.scheduledStartAt?.slice(11, 16) ?? "" }),
    task.durationMinutes == null ? null : tx("{minutes} 分钟", { minutes: task.durationMinutes }),
    subjectName || tx("未归入空间"),
  ]
    .filter(Boolean).join(" · ");
}

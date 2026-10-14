import type { MemoryStatus } from "@/lib/types";

export interface StatusMeta {
  label: string;
  description: string;
}

export const STATUS_ORDER: MemoryStatus[] = ["suspected", "needs_review", "improving", "resolved"];

export const STATUS_META: Record<MemoryStatus, StatusMeta> = {
  suspected: { label: "待确认", description: "发现可疑误区，证据还不充分" },
  needs_review: { label: "需要巩固", description: "有较充分的证据，需要针对性练习" },
  improving: { label: "改善中", description: "近期表现改善，仍在观察" },
  resolved: { label: "已解决", description: "后续独立作答表明已基本掌握" },
};

export function statusMeta(status: string): StatusMeta {
  return STATUS_META[status as MemoryStatus] ?? { label: status, description: "" };
}

/** 后端未提供 topicLabel 时的兜底显示 */
const TOPIC_LABELS: Record<string, string> = {
  "stack.lifo": "栈 · 后进先出",
  "queue.fifo": "队列 · 先进先出",
};

export function topicLabel(topicKey: string, provided?: string): string {
  return provided ?? TOPIC_LABELS[topicKey] ?? topicKey;
}

export function formatConfidence(value: number | null | undefined): string {
  return value == null ? "—" : value.toFixed(2);
}

export function formatRelativeTime(iso: string, now: number = Date.now()): string {
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return "";
  const diff = Math.max(0, now - time);
  const minute = 60_000;
  if (diff < minute) return "刚刚";
  if (diff < 60 * minute) return `${Math.floor(diff / minute)} 分钟前`;
  const date = new Date(time);
  const sameDay = new Date(now).toDateString() === date.toDateString();
  const hhmm = date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  if (sameDay) return `今天 ${hhmm}`;
  return `${date.getMonth() + 1}月${date.getDate()}日 ${hhmm}`;
}

export function formatClock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
}

export function shortId(id: string): string {
  return id.length > 14 ? `${id.slice(0, 14)}…` : id;
}

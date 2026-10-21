/** 日程列表的分组、排序与日期展示（纯函数，不依赖 React）。 */
import { formatYmd } from "@/lib/agenda/quickAdd";
import {
  FOCUS_START_EVENT, type AgendaTask, type AgendaThread, type FocusStartDetail, type TaskPriority,
} from "@/lib/agenda/types";

/** 通知番茄钟模块开始专注（约定见 docs/contracts/agenda.md 第 5 节） */
export function dispatchFocusStart(detail: FocusStartDetail): void {
  window.dispatchEvent(new CustomEvent<FocusStartDetail>(FOCUS_START_EVENT, { detail }));
}

export type GroupKey = "overdue" | "today" | "tomorrow" | "week" | "later" | "unscheduled" | "done";

export const GROUP_LABELS: Record<GroupKey, string> = {
  overdue: "逾期",
  today: "今天",
  tomorrow: "明天",
  week: "未来 7 天",
  later: "以后",
  unscheduled: "未安排",
  done: "今日已完成",
};

export const GROUP_ORDER: GroupKey[] = ["overdue", "today", "tomorrow", "week", "later", "unscheduled", "done"];

export interface TaskNode {
  kind: "task" | "review";
  key: string;
  task: AgendaTask;
  /** 子任务（含已完成），按 sortOrder 排序 */
  children: AgendaTask[];
}

export interface ThreadNode {
  kind: "thread";
  key: string;
  thread: AgendaThread;
}

export type AgendaNode = TaskNode | ThreadNode;

export interface AgendaGroup {
  key: GroupKey;
  label: string;
  nodes: AgendaNode[];
}

/** 键盘导航用的扁平行：顶层节点或展开后的子任务 */
export interface FlatRow {
  key: string;
  node: AgendaNode;
  child: AgendaTask | null;
}

export const taskKey = (id: string) => `task:${id}`;
export const threadKey = (id: string) => `thread:${id}`;

const toUtcDay = (ymd: string) => {
  const [year, month, day] = ymd.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
};

/** from → to 相差的天数（to 晚于 from 为正） */
export function dayDiff(from: string, to: string): number {
  return Math.round((toUtcDay(to) - toUtcDay(from)) / 86_400_000);
}

export function localDateOf(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : formatYmd(date);
}

/**
 * 一个条目落在哪一组。
 * 逾期：计划日（没有计划日时看截止日）早于今天；只有截止日且未逾期的归「未安排」。
 */
export function bucketFor(scheduled: string | null, deadline: string | null, today: string): GroupKey {
  const anchor = scheduled ?? deadline;
  if (anchor && anchor < today) return "overdue";
  if (!scheduled) return "unscheduled";
  const diff = dayDiff(today, scheduled);
  if (diff === 0) return "today";
  if (diff === 1) return "tomorrow";
  return diff <= 7 ? "week" : "later";
}

const FAR = "9999-12-31T24:00";

function timeKey(task: AgendaTask): string {
  if (task.scheduledStartAt) return task.scheduledStartAt;
  const day = task.scheduledDate ?? task.deadlineDate;
  return day ? `${day}T24:00` : FAR;
}

function nodeTime(node: AgendaNode): string {
  if (node.kind === "thread") return node.thread.deadlineDate ? `${node.thread.deadlineDate}T24:00` : FAR;
  const keys = [timeKey(node.task), ...node.children.filter((c) => c.status === "open").map(timeKey)];
  return keys.sort()[0];
}

const nodePriority = (node: AgendaNode): number => (node.kind === "thread" ? 3 : node.task.priority);

function compareNodes(a: AgendaNode, b: AgendaNode): number {
  const byPriority = nodePriority(a) - nodePriority(b);
  if (byPriority) return byPriority;
  const byTime = nodeTime(a).localeCompare(nodeTime(b));
  if (byTime) return byTime;
  if (a.kind !== "thread" && b.kind !== "thread") {
    const byOrder = a.task.sortOrder - b.task.sortOrder;
    if (byOrder) return byOrder;
    return a.task.createdAt.localeCompare(b.task.createdAt);
  }
  return a.kind === "thread" ? 1 : -1;
}

export function compareSiblings(a: AgendaTask, b: AgendaTask): number {
  return a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt);
}

export function buildGroups(input: {
  tasks: AgendaTask[];
  threads: AgendaThread[];
  today: string;
  subjectId: string | null;
}): AgendaGroup[] {
  const { today, subjectId } = input;
  const live = input.tasks.filter(
    (task) => task.status !== "cancelled" && (!subjectId || task.subjectId === subjectId),
  );
  const ids = new Set(live.map((task) => task.id));
  const childrenOf = new Map<string, AgendaTask[]>();
  const tops: AgendaTask[] = [];
  for (const task of live) {
    if (task.parentId && ids.has(task.parentId)) {
      childrenOf.set(task.parentId, [...(childrenOf.get(task.parentId) ?? []), task]);
    } else {
      tops.push(task);
    }
  }

  const buckets = new Map<GroupKey, AgendaNode[]>(GROUP_ORDER.map((key) => [key, []]));
  for (const task of tops) {
    const children = (childrenOf.get(task.id) ?? []).sort(compareSiblings);
    const openChildren = children.filter((child) => child.status === "open");
    const node: TaskNode = { kind: task.source === "review" ? "review" : "task", key: taskKey(task.id), task, children };

    if (task.status === "done" && openChildren.length === 0) {
      if (localDateOf(task.completedAt) === today) buckets.get("done")!.push(node);
      continue;
    }
    const candidates = [task, ...openChildren].map((item) => bucketFor(item.scheduledDate, item.deadlineDate, today));
    const bucket = GROUP_ORDER.find((key) => candidates.includes(key)) ?? "unscheduled";
    buckets.get(bucket)!.push(node);
  }

  for (const thread of input.threads) {
    if (subjectId && thread.subjectId !== subjectId) continue;
    const bucket = bucketFor(thread.deadlineDate, null, today);
    buckets.get(bucket)!.push({ kind: "thread", key: threadKey(thread.threadId), thread });
  }

  const groups: AgendaGroup[] = [];
  for (const key of GROUP_ORDER) {
    const nodes = buckets.get(key)!;
    if (!nodes.length) continue;
    if (key === "done") {
      nodes.sort((a, b) => (b.kind === "thread" || a.kind === "thread" ? 0 : (b.task.completedAt ?? "").localeCompare(a.task.completedAt ?? "")));
    } else {
      nodes.sort(compareNodes);
    }
    groups.push({ key, label: GROUP_LABELS[key], nodes });
  }
  return groups;
}

export function flattenRows(
  groups: AgendaGroup[], collapsedGroups: ReadonlySet<GroupKey>, collapsedParents: ReadonlySet<string>,
): FlatRow[] {
  const rows: FlatRow[] = [];
  for (const group of groups) {
    if (collapsedGroups.has(group.key)) continue;
    for (const node of group.nodes) {
      rows.push({ key: node.key, node, child: null });
      if (node.kind !== "thread" && !collapsedParents.has(node.task.id)) {
        for (const child of node.children) rows.push({ key: taskKey(child.id), node, child });
      }
    }
  }
  return rows;
}

export function subtaskProgress(children: AgendaTask[]): { done: number; total: number } {
  return { done: children.filter((child) => child.status === "done").length, total: children.length };
}

/* ------------------------------------------------------------------ 展示用的日期文案 */

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

export function monthDay(ymd: string): string {
  const [, month, day] = ymd.split("-").map(Number);
  return `${month}月${day}日`;
}

export function weekdayOf(ymd: string): string {
  return `周${WEEKDAYS[new Date(toUtcDay(ymd)).getUTCDay()]}`;
}

export function dateWord(ymd: string, today: string): string {
  const diff = dayDiff(today, ymd);
  if (diff === 0) return "今天";
  if (diff === 1) return "明天";
  if (diff === -1) return "昨天";
  return `${monthDay(ymd)} ${weekdayOf(ymd)}`;
}

export function scheduleLabel(task: AgendaTask, today: string): string | null {
  if (!task.scheduledDate) return null;
  const parts: string[] = [];
  if (task.scheduledDate !== today) parts.push(dateWord(task.scheduledDate, today));
  if (task.scheduledStartAt) parts.push(task.scheduledStartAt.slice(11, 16));
  if (task.durationMinutes) parts.push(task.durationMinutes >= 60 && task.durationMinutes % 60 === 0
    ? `${task.durationMinutes / 60}h` : `${task.durationMinutes}分`);
  return parts.length ? parts.join(" ") : "今天";
}

/** 截止日文案；今天起 2 天内或已逾期视为临近（标红） */
export function deadlineInfo(deadline: string | null, today: string): { text: string; urgent: boolean } | null {
  if (!deadline) return null;
  const diff = dayDiff(today, deadline);
  if (diff < 0) return { text: `逾期 ${-diff} 天`, urgent: true };
  if (diff === 0) return { text: "今天截止", urgent: true };
  if (diff === 1) return { text: "明天截止", urgent: true };
  return { text: `${monthDay(deadline)}截止`, urgent: diff <= 2 };
}

export function priorityLabel(priority: TaskPriority): string {
  return `P${priority}`;
}

/** 日程各视图的分组、排序与日期展示（纯函数，不依赖 React）。 */
import { formatYmd } from "@/lib/agenda/quickAdd";
import {
  COMPOSE_TASK_EVENT,
  type AgendaTask, type AgendaThread, type ComposeTaskDetail, type TaskPatch, type TaskPriority,
} from "@/lib/agenda/types";

/** 打开全局「添加任务」弹窗（约定见第 6.2 节） */
export function dispatchCompose(detail: ComposeTaskDetail): void {
  window.dispatchEvent(new CustomEvent<ComposeTaskDetail>(COMPOSE_TASK_EVENT, { detail }));
}

export type GroupKey = string;

/** 日程页左侧导航的视图；学习空间视图为 `space:{id}` */
export type AgendaViewKey = "inbox" | "today" | "upcoming" | "week" | `space:${string}`;

export const VIEW_LABELS: Record<"inbox" | "today" | "upcoming" | "week", string> = {
  inbox: "待办",
  today: "今天",
  upcoming: "预览",
  week: "周历",
};

export const spaceView = (id: string): AgendaViewKey => `space:${id}`;
export const spaceIdOf = (view: AgendaViewKey): string | null => (view.startsWith("space:") ? view.slice(6) : null);

export function parseViewKey(raw: unknown): AgendaViewKey | null {
  if (typeof raw !== "string") return null;
  if (raw === "inbox" || raw === "today" || raw === "upcoming" || raw === "week") return raw;
  return raw.startsWith("space:") && raw.length > 6 ? (raw as AgendaViewKey) : null;
}

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
  /** 标题右侧的次要文字，如「明天 · 周四」 */
  sublabel?: string;
  tone?: "overdue" | "today";
  nodes: AgendaNode[];
  /** 节末「+ 添加任务」的默认值；缺省则不显示 */
  compose?: { scheduledDate?: string | null; subjectId?: string | null };
  /** 没有条目时仍显示该节（预览视图的每一天） */
  keepEmpty?: boolean;
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

/** YYYY-MM-DD 加减天数 */
export function addDays(ymd: string, days: number): string {
  const date = new Date(toUtcDay(ymd) + days * 86_400_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** 所在周的周一 */
export function mondayOf(ymd: string): string {
  return addDays(ymd, -((new Date(toUtcDay(ymd)).getUTCDay() + 6) % 7));
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

/**
 * 把任务组装成「顶层 + 子任务」节点。
 * 只保留「自己未完成，或还有未完成子任务」的顶层；子任务保留全部（含已完成），用于进度显示。
 */
export function buildNodes(tasks: AgendaTask[], options?: { includeDone?: boolean }): TaskNode[] {
  const live = tasks.filter((task) => task.status !== "cancelled");
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
  const nodes: TaskNode[] = [];
  for (const task of tops) {
    const children = (childrenOf.get(task.id) ?? []).sort(compareSiblings);
    if (task.status === "done" && !options?.includeDone && !children.some((child) => child.status === "open")) continue;
    nodes.push({ kind: task.source === "review" ? "review" : "task", key: taskKey(task.id), task, children });
  }
  return nodes;
}

const threadNode = (thread: AgendaThread): ThreadNode => ({ kind: "thread", key: threadKey(thread.threadId), thread });

/** 节点的计划日：自己有就用自己的，否则取未完成子任务里最早的 */
function nodeDay(node: TaskNode): string | null {
  if (node.task.scheduledDate) return node.task.scheduledDate;
  const days = node.children
    .filter((child) => child.status === "open" && child.scheduledDate)
    .map((child) => child.scheduledDate as string)
    .sort();
  return days[0] ?? null;
}

/** 逾期：计划日早于今天；没有计划日时看截止日 */
function isOverdue(node: TaskNode, today: string): boolean {
  const day = nodeDay(node) ?? node.task.deadlineDate;
  return Boolean(day && day < today);
}

const sorted = (nodes: AgendaNode[]) => nodes.sort(compareNodes);

/** 收件箱：没有日期（计划日、截止日都没有）且不属于任何空间 */
export function isInboxNode(node: TaskNode): boolean {
  return !node.task.subjectId && !nodeDay(node) && !node.task.deadlineDate;
}

export interface ViewCounts {
  inbox: number;
  today: number;
  upcoming: number;
  week: number;
  spaces: Map<string, number>;
}

/** 左侧导航各项的未完成数（支线计入今天/预览与所属空间） */
export function countViews(tasks: AgendaTask[], threads: AgendaThread[], today: string): ViewCounts {
  const nodes = buildNodes(tasks);
  const spaces = new Map<string, number>();
  const bump = (id: string | null) => { if (id) spaces.set(id, (spaces.get(id) ?? 0) + 1); };
  let inbox = 0;
  let todayCount = 0;
  let upcoming = 0;
  const weekEnd = addDays(mondayOf(today), 6);
  let week = 0;
  const horizon = addDays(today, 13);
  for (const node of nodes) {
    bump(node.task.subjectId);
    if (isInboxNode(node)) inbox += 1;
    const day = nodeDay(node);
    const overdue = isOverdue(node, today);
    if (overdue || day === today) todayCount += 1;
    if (overdue || (day && day <= horizon)) upcoming += 1;
    if (day && day >= mondayOf(today) && day <= weekEnd) week += 1;
  }
  for (const thread of threads) {
    bump(thread.subjectId);
    const day = thread.deadlineDate;
    if (day && day <= today) todayCount += 1;
    if (day && day <= horizon) upcoming += 1;
    if (day && day >= mondayOf(today) && day <= weekEnd) week += 1;
  }
  return { inbox, today: todayCount, upcoming, week, spaces };
}

/** 「今天」视图：逾期 + 今天 */
export function buildTodayGroups(
  tasks: AgendaTask[], threads: AgendaThread[], today: string, options?: { includeDone?: boolean },
): AgendaGroup[] {
  const overdue: AgendaNode[] = [];
  const todays: AgendaNode[] = [];
  for (const node of buildNodes(tasks, options)) {
    const doneToday = Boolean(options?.includeDone && node.task.status === "done" && localDateOf(node.task.completedAt) === today);
    if (isOverdue(node, today) && !doneToday) overdue.push(node);
    else if (nodeDay(node) === today || doneToday) todays.push(node);
  }
  for (const thread of threads) {
    if (!thread.deadlineDate) continue;
    if (thread.deadlineDate < today) overdue.push(threadNode(thread));
    else if (thread.deadlineDate === today) todays.push(threadNode(thread));
  }
  const groups: AgendaGroup[] = [];
  if (overdue.length) groups.push({ key: "overdue", label: "逾期", tone: "overdue", nodes: sorted(overdue) });
  groups.push({
    key: "today", label: "今天", sublabel: `${monthDay(today)} · ${weekdayOf(today)}`, tone: "today",
    nodes: sorted(todays), compose: { scheduledDate: today }, keepEmpty: true,
  });
  return groups;
}

/** 「收件箱」视图 */
export function buildInboxGroups(tasks: AgendaTask[], options?: { includeDone?: boolean }): AgendaGroup[] {
  const nodes = buildNodes(tasks, options).filter(isInboxNode);
  return [{ key: "inbox", label: "待办", nodes: sorted(nodes), compose: {}, keepEmpty: true }];
}

export const UPCOMING_DAYS = 14;

export const dayGroupKey = (day: string) => `day:${day}`;

/** 「预览」视图：逾期一节 + 从今天起连续 14 天，每天一节 */
export function buildUpcomingGroups(
  tasks: AgendaTask[], threads: AgendaThread[], today: string, options?: { includeDone?: boolean },
): AgendaGroup[] {
  const overdue: AgendaNode[] = [];
  const byDay = new Map<string, AgendaNode[]>();
  const push = (day: string, node: AgendaNode) => byDay.set(day, [...(byDay.get(day) ?? []), node]);
  for (const node of buildNodes(tasks, options)) {
    if (isOverdue(node, today)) overdue.push(node);
    else {
      const day = nodeDay(node);
      if (day) push(day, node);
    }
  }
  for (const thread of threads) {
    if (!thread.deadlineDate) continue;
    if (thread.deadlineDate < today) overdue.push(threadNode(thread));
    else push(thread.deadlineDate, threadNode(thread));
  }
  const groups: AgendaGroup[] = [];
  if (overdue.length) groups.push({ key: "overdue", label: "逾期", tone: "overdue", nodes: sorted(overdue) });
  for (let offset = 0; offset < UPCOMING_DAYS; offset += 1) {
    const day = addDays(today, offset);
    const relative = offset === 0 ? "今天" : offset === 1 ? "明天" : offset === 2 ? "后天" : null;
    groups.push({
      key: dayGroupKey(day),
      label: monthDay(day),
      sublabel: [relative, weekdayOf(day)].filter(Boolean).join(" · "),
      tone: offset === 0 ? "today" : undefined,
      nodes: sorted(byDay.get(day) ?? []),
      compose: { scheduledDate: day },
      keepEmpty: true,
    });
  }
  return groups;
}

/** 学习空间视图：进行中支线 / 闪回复习 / 任务 */
export function buildSpaceGroups(
  tasks: AgendaTask[], threads: AgendaThread[], subjectId: string, options?: { includeDone?: boolean },
): AgendaGroup[] {
  const nodes = buildNodes(tasks.filter((task) => task.subjectId === subjectId), options);
  const threadNodes = threads.filter((thread) => thread.subjectId === subjectId).map(threadNode);
  const reviews = nodes.filter((node) => node.kind === "review");
  const plain = nodes.filter((node) => node.kind === "task");
  const groups: AgendaGroup[] = [];
  if (threadNodes.length) groups.push({ key: "threads", label: "进行中支线", nodes: sorted(threadNodes) });
  if (reviews.length) groups.push({ key: "reviews", label: "闪回复习", nodes: sorted(reviews) });
  groups.push({ key: "tasks", label: "任务", nodes: sorted(plain), compose: { subjectId }, keepEmpty: true });
  return groups;
}

/** 空间进度：顶层与子任务一起算，已完成 / 全部（不含取消） */
export function spaceProgress(tasks: AgendaTask[], subjectId: string): { done: number; total: number } {
  const mine = tasks.filter((task) => task.subjectId === subjectId && task.status !== "cancelled");
  return { done: mine.filter((task) => task.status === "done").length, total: mine.length };
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

/** 本周六；今天已是周六则就是今天 */
export function weekendOf(today: string): string {
  const dow = new Date(toUtcDay(today)).getUTCDay();
  return addDays(today, (6 - dow + 7) % 7);
}

/** 下一个周一；今天是周一则取下周一 */
export function nextMondayOf(today: string): string {
  const dow = new Date(toUtcDay(today)).getUTCDay();
  if (dow === 0) return addDays(today, 1);
  return addDays(today, dow === 1 ? 7 : 8 - dow);
}

export function schedulePatch(task: AgendaTask, date: string | null): TaskPatch {
  if (!date) return { scheduledDate: null, scheduledStartAt: null };
  const time = task.scheduledStartAt?.slice(11, 16);
  return { scheduledDate: date, scheduledStartAt: time ? `${date}T${time}` : null };
}

/** 某一天完成的任务数（含子任务），按 completedAt 的本地日期 */
export function completedOn(tasks: AgendaTask[], day: string): number {
  return tasks.filter((task) => task.status === "done" && localDateOf(task.completedAt) === day).length;
}

export interface TodaySuggestion {
  id: string;
  kind: "inbox" | "pull" | "breakdown";
  title: string;
  detail: string;
  taskId: string | null;
  subjectId: string | null;
}

/** 今天没有安排时的建议，最多 3 条：收件箱未排期、7 天内可提前、临近截止但还没任务的空间 */
export function buildTodaySuggestions(
  tasks: AgendaTask[],
  subjects: { id: string; name: string; deadline: string | null }[],
  today: string,
): TodaySuggestion[] {
  const out: TodaySuggestion[] = [];
  const nodes = buildNodes(tasks);
  const inbox = [...nodes].filter(isInboxNode).sort(compareNodes)[0];
  if (inbox) {
    out.push({
      id: `inbox:${inbox.task.id}`,
      kind: "inbox",
      title: inbox.task.title,
      detail: "待办里还没排期",
      taskId: inbox.task.id,
      subjectId: null,
    });
  }
  const soon = addDays(today, 7);
  const future = nodes
    .map((node) => ({ node, day: nodeDay(node) }))
    .filter((item): item is { node: TaskNode; day: string } => Boolean(item.day && item.day > today && item.day <= soon))
    .sort((a, b) => a.day.localeCompare(b.day) || compareNodes(a.node, b.node));
  if (future[0] && out.length < 3) {
    out.push({
      id: `pull:${future[0].node.task.id}`,
      kind: "pull",
      title: future[0].node.task.title,
      detail: `${dateWord(future[0].day, today)}的安排`,
      taskId: future[0].node.task.id,
      subjectId: null,
    });
  }
  const horizon = addDays(today, 14);
  const busy = new Set(tasks.filter((task) => task.status !== "cancelled" && task.subjectId).map((task) => task.subjectId));
  for (const subject of subjects) {
    if (out.length >= 3) break;
    if (!subject.deadline || subject.deadline < today || subject.deadline > horizon) continue;
    if (busy.has(subject.id)) continue;
    out.push({
      id: `breakdown:${subject.id}`,
      kind: "breakdown",
      title: subject.name,
      detail: `${dateWord(subject.deadline, today)}截止，还没有任务`,
      taskId: null,
      subjectId: subject.id,
    });
  }
  return out;
}

export type AgendaGroupBy = "none" | "space" | "priority" | "date";
export type AgendaSortBy = "manual" | "date" | "priority";

export interface AgendaViewOptions {
  showCompleted: boolean;
  groupBy: AgendaGroupBy;
  sortBy: AgendaSortBy;
}

export const DEFAULT_VIEW_OPTIONS: AgendaViewOptions = {
  showCompleted: false,
  groupBy: "none",
  sortBy: "manual",
};

export function sortAgendaNodes(nodes: AgendaNode[], sortBy: AgendaSortBy): AgendaNode[] {
  const copy = [...nodes];
  if (sortBy === "date") return copy.sort((a, b) => nodeTime(a).localeCompare(nodeTime(b)) || compareNodes(a, b));
  if (sortBy === "priority") return copy.sort(compareNodes);
  return copy.sort((a, b) => {
    if (a.kind === "thread" || b.kind === "thread") return compareNodes(a, b);
    return a.task.sortOrder - b.task.sortOrder || a.task.createdAt.localeCompare(b.task.createdAt);
  });
}

const PRIORITY_GROUP: Record<number, string> = { 1: "P1 · 紧急", 2: "P2 · 高", 3: "P3 · 中", 4: "P4 · 无" };

/** 在各视图原有分组之外再套一层：分组为「无」时只改排序 */
export function applyViewOptions(
  groups: AgendaGroup[],
  options: AgendaViewOptions,
  subjects: Map<string, { id: string; name: string }>,
  today: string,
): AgendaGroup[] {
  if (options.groupBy === "none" && options.sortBy === "manual") return groups;
  const pack = (list: AgendaGroup[]) => list.map((group) => ({ ...group, nodes: sortAgendaNodes(group.nodes, options.sortBy) }));
  if (options.groupBy === "none") return pack(groups);

  const nodes = groups.flatMap((group) => group.nodes);
  const buckets = new Map<string, AgendaGroup>();
  const ensure = (key: string, label: string, extra?: Partial<AgendaGroup>) => {
    const existing = buckets.get(key);
    if (existing) return existing;
    const created: AgendaGroup = { key, label, nodes: [], ...extra };
    buckets.set(key, created);
    return created;
  };

  if (options.groupBy === "priority") {
    for (const node of nodes) {
      if (node.kind === "thread") {
        ensure("threads", "进行中支线").nodes.push(node);
        continue;
      }
      ensure(`p${node.task.priority}`, PRIORITY_GROUP[node.task.priority] ?? `P${node.task.priority}`).nodes.push(node);
    }
    return pack(["p1", "p2", "p3", "p4", "threads"]
      .map((key) => buckets.get(key))
      .filter((group): group is AgendaGroup => Boolean(group && group.nodes.length)));
  }

  if (options.groupBy === "space") {
    for (const node of nodes) {
      const subjectId = node.kind === "thread" ? node.thread.subjectId : node.task.subjectId;
      const name = subjectId
        ? subjects.get(subjectId)?.name ?? (node.kind === "thread" ? node.thread.subjectName : "未归入空间")
        : "未归入空间";
      ensure(subjectId ? `space:${subjectId}` : "none", name, subjectId ? { compose: { subjectId } } : { compose: {} }).nodes.push(node);
    }
    const ordered: AgendaGroup[] = [];
    for (const subject of subjects.values()) {
      const group = buckets.get(`space:${subject.id}`);
      if (group) ordered.push(group);
    }
    for (const group of buckets.values()) {
      if (!ordered.includes(group)) ordered.push(group);
    }
    return pack(ordered.filter((group) => group.nodes.length));
  }

  for (const node of nodes) {
    const day = node.kind === "thread" ? node.thread.deadlineDate : (nodeDay(node) ?? node.task.deadlineDate);
    if (!day) {
      ensure("undated", "无日期", { compose: {} }).nodes.push(node);
      continue;
    }
    ensure(dayGroupKey(day), monthDay(day), {
      sublabel: [day === today ? "今天" : day === addDays(today, 1) ? "明天" : null, weekdayOf(day)].filter(Boolean).join(" · "),
      tone: day < today ? "overdue" : day === today ? "today" : undefined,
      compose: { scheduledDate: day },
    }).nodes.push(node);
  }
  return pack([...buckets.values()].sort((a, b) => {
    if (a.key === "undated") return 1;
    if (b.key === "undated") return -1;
    return a.key.localeCompare(b.key);
  }));
}

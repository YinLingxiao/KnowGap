/** 知隙日程的前端数据类型。接口约定见 docs/contracts/agenda.md。 */

export type TaskPriority = 1 | 2 | 3 | 4;
export type TaskStatus = "open" | "done" | "cancelled";
export type TaskSource = "manual" | "ai_breakdown" | "review";

export interface AgendaTask {
  id: string;
  title: string;
  notes: string;
  parentId: string | null;
  priority: TaskPriority;
  labels: string[];
  subjectId: string | null;
  threadId: string | null;
  /** 计划哪天学（Schedule），YYYY-MM-DD */
  scheduledDate: string | null;
  /** 计划几点开始，本地时间 YYYY-MM-DDTHH:MM */
  scheduledStartAt: string | null;
  durationMinutes: number | null;
  /** 硬截止日（Deadline），YYYY-MM-DD，与 Schedule 独立 */
  deadlineDate: string | null;
  status: TaskStatus;
  completedAt: string | null;
  source: TaskSource;
  memoryId: string | null;
  reviewStep: 1 | 2 | 3 | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

/** 进行中的空间 Thread，日程里只读展示 */
export interface AgendaThread {
  threadId: string;
  title: string;
  subjectId: string;
  subjectName: string;
  subjectColor: string;
  deadlineDate: string | null;
  updatedAt: string;
}

export interface AgendaFeed {
  today: string;
  tasks: AgendaTask[];
  threads: AgendaThread[];
}

/** 新建任务可写的字段 */
export interface TaskInput {
  title: string;
  notes?: string;
  parentId?: string | null;
  priority?: TaskPriority;
  labels?: string[];
  subjectId?: string | null;
  threadId?: string | null;
  scheduledDate?: string | null;
  scheduledStartAt?: string | null;
  durationMinutes?: number | null;
  deadlineDate?: string | null;
  source?: "manual" | "ai_breakdown";
}

/** PATCH：传 null 表示清空 */
export type TaskPatch = Partial<Omit<TaskInput, "source">> & {
  status?: TaskStatus;
  sortOrder?: number;
};

/** AI 拆解返回的草稿，不入库 */
export type TaskDraft = Pick<
  TaskInput,
  "title" | "notes" | "priority" | "labels" | "scheduledDate" | "scheduledStartAt" | "durationMinutes" | "deadlineDate"
>;

export interface BreakdownRequest {
  goal: string;
  subjectId?: string | null;
  deadlineDate?: string | null;
  today: string;
}

export interface BreakdownDraft {
  parent: TaskDraft;
  children: TaskDraft[];
}

/** 番茄钟与日程之间的 window 事件 */
export const FOCUS_START_EVENT = "knowgap:focus-start";
export const AGENDA_CHANGED_EVENT = "knowgap:agenda-changed";

export interface FocusStartDetail {
  taskId: string | null;
  title: string;
  subjectId: string | null;
}

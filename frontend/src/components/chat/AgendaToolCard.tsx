"use client";

import { ArrowUpRight, CalendarCheck, CalendarClock, CheckCircle2, CircleAlert } from "lucide-react";
import type { ToolCallView } from "@/lib/chat/types";
import styles from "./AgendaToolCard.module.css";

/** AI 用日程工具写入或修改任务后，在回复里显示的结果卡片 */
export const AGENDA_TOOLS = new Set(["agenda_add", "agenda_update", "agenda_list"]);
export const OPEN_AGENDA_EVENT = "knowgap:open-agenda";

interface BriefTask {
  id?: string;
  title?: string;
  scheduled_date?: string;
  scheduled_start_at?: string;
  duration_minutes?: number;
  deadline_date?: string;
  priority?: number;
  status?: string;
}

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

function when(task: BriefTask): string {
  const day = task.scheduled_start_at?.slice(0, 10) ?? task.scheduled_date;
  const parts: string[] = [];
  if (day) {
    const date = new Date(`${day}T00:00:00`);
    parts.push(Number.isNaN(date.getTime()) ? day : `${date.getMonth() + 1}月${date.getDate()}日 周${WEEKDAYS[date.getDay()]}`);
  }
  if (task.scheduled_start_at) parts.push(task.scheduled_start_at.slice(11, 16));
  if (task.duration_minutes) parts.push(`${task.duration_minutes} 分钟`);
  return parts.join(" · ") || "未安排日期";
}

function parse(output: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(output);
    return value && typeof value === "object" ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function openAgenda() {
  window.dispatchEvent(new CustomEvent(OPEN_AGENDA_EVENT));
}

export function AgendaToolCard({ call }: { call: ToolCallView }) {
  if (call.name === "agenda_list") return null;
  if (!call.output) {
    return (
      <div className={styles.card} role="status">
        <div className={styles.head}><CalendarClock size={14} aria-hidden /><span>正在写入日程…</span></div>
      </div>
    );
  }
  const data = call.ok ? parse(call.output) : null;
  if (!data) {
    return (
      <div className={styles.card} role="status">
        <div className={styles.head}>
          <CircleAlert size={14} className={styles.warn} aria-hidden />
          <span>没能写入日程</span>
        </div>
        <p className={styles.error}>{call.output}</p>
      </div>
    );
  }

  if (call.name === "agenda_update") {
    const task = (data.updated ?? {}) as BriefTask;
    const done = task.status === "done";
    return (
      <div className={styles.card}>
        <div className={styles.head}>
          {done ? <CheckCircle2 size={14} className={styles.ok} aria-hidden /> : <CalendarClock size={14} aria-hidden />}
          <span>{done ? "已在日程中标记完成" : task.status === "cancelled" ? "已取消日程任务" : "已调整日程"}</span>
          <button type="button" className={styles.link} onClick={openAgenda}>查看日程<ArrowUpRight size={12} aria-hidden /></button>
        </div>
        <ul className={styles.list}>
          <li><span className={styles.title}>{task.title}</span><span className={styles.when}>{when(task)}</span></li>
        </ul>
      </div>
    );
  }

  const parent = data.parent as BriefTask | null | undefined;
  const tasks = Array.isArray(data.tasks) ? data.tasks as BriefTask[] : [];
  const count = typeof data.added === "number" ? data.added : tasks.length;
  return (
    <div className={styles.card}>
      <div className={styles.head}>
        <CalendarCheck size={14} className={styles.ok} aria-hidden />
        <span>已加入日程 · {count} 项</span>
        <button type="button" className={styles.link} onClick={openAgenda}>在日程中查看<ArrowUpRight size={12} aria-hidden /></button>
      </div>
      {parent?.title && (
        <p className={styles.parent}>
          {parent.title}
          {parent.deadline_date && <span className={styles.deadline}>截止 {parent.deadline_date.slice(5).replace("-", "/")}</span>}
        </p>
      )}
      <ul className={styles.list}>
        {tasks.map((task, index) => (
          <li key={task.id ?? index}>
            <span className={styles.dot} data-priority={task.priority ?? 4} aria-hidden />
            <span className={styles.title}>{task.title}</span>
            <span className={styles.when}>{when(task)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

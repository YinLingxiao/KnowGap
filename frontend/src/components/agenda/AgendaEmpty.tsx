"use client";

import { Plus, Sparkles } from "lucide-react";
import type { TodaySuggestion } from "./agendaModel";
import styles from "./AgendaEmpty.module.css";

const EXAMPLES = [
  "明天下午3点 复习戴维南定理 #电路原理 45分钟",
  "周五晚上 整理本章错题 p2",
  "下周一截止 预习下一章 30分钟",
];

export interface AgendaEmptyProps {
  variant: "inbox" | "today-done" | "today-empty" | "upcoming" | "week";
  completedCount?: number;
  suggestions?: TodaySuggestion[];
  hideAction?: boolean;
  onAdd?: () => void;
  onExample?: (text: string) => void;
  onSchedule?: (taskId: string) => void;
  onBreakdown?: (subjectId: string | null) => void;
}

export function AgendaEmpty(props: AgendaEmptyProps) {
  if (props.variant === "week") {
    return <p className={styles.weekHint}>在时间格里点击或拖动来创建任务</p>;
  }

  const copy = COPY[props.variant];
  return (
    <div className={props.variant === "upcoming" ? styles.banner : styles.empty}>
      {props.variant !== "upcoming" && <Illustration variant={props.variant} />}
      <h2 className={styles.title}>{copy.title(props.completedCount ?? 0)}</h2>
      <p className={styles.text}>{copy.text(props.completedCount ?? 0)}</p>
      {!props.hideAction && copy.action && props.variant !== "today-done" && (
        <button
          type="button"
          className={styles.primary}
          onClick={() => (props.variant === "upcoming" ? props.onBreakdown?.(null) : props.onAdd?.())}
        >
          {props.variant === "upcoming" ? <Sparkles size={14} aria-hidden /> : <Plus size={14} aria-hidden />}
          {copy.action}
        </button>
      )}
      {props.variant === "inbox" && props.onExample && !props.hideAction && (
        <div className={styles.examples}>
          <span>也可以直接这样写</span>
          {EXAMPLES.map((example) => (
            <button key={example} type="button" className={styles.example} onClick={() => props.onExample?.(example)}>
              {example}
            </button>
          ))}
        </div>
      )}
      {props.variant === "today-empty" && props.suggestions && props.suggestions.length > 0 && (
        <ul className={styles.suggest}>
          {props.suggestions.map((item) => (
            <li key={item.id}>
              <span className={styles.suggestText}>
                <strong>{item.title}</strong>
                <span>{item.detail}</span>
              </span>
              <button
                type="button"
                className={styles.suggestBtn}
                onClick={() => (item.kind === "breakdown" ? props.onBreakdown?.(item.subjectId) : item.taskId && props.onSchedule?.(item.taskId))}
              >
                {item.kind === "breakdown" ? "AI 拆解排期" : item.kind === "inbox" ? "安排到今天" : "提前到今天"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const COPY: Record<Exclude<AgendaEmptyProps["variant"], "week">, {
  title: (count: number) => string;
  text: (count: number) => string;
  action?: string;
}> = {
  inbox: {
    title: () => "先记下，稍后再排",
    text: () => "脑子里冒出的事先丢进来，有空再分到日期或学习空间。",
    action: "添加任务",
  },
  "today-done": {
    title: () => "今天的任务都完成了",
    text: (count) => (count > 0 ? `已完成 ${count} 项` : "今天没有未完成的安排"),
  },
  "today-empty": {
    title: () => "今天还没有安排",
    text: () => "可以从待办拉一条过来，或让 AI 按截止日拆开。",
    action: "添加任务",
  },
  upcoming: {
    title: () => "接下来两周还没有安排",
    text: () => "把一个目标交给 AI，按截止日拆成可以排进去的任务。",
    action: "AI 拆解排期",
  },
};

function Illustration({ variant }: { variant: "inbox" | "today-done" | "today-empty" }) {
  return (
    <svg className={styles.art} viewBox="0 0 96 80" aria-hidden>
      {variant === "inbox" && <InboxArt />}
      {variant === "today-done" && <DoneArt />}
      {variant === "today-empty" && <TodayArt />}
    </svg>
  );
}

function InboxArt() {
  return (
    <>
      <rect x="16" y="26" width="64" height="38" rx="8" className={styles.stroke} />
      <path d="M16 46h16l6 8h20l6-8h16" className={styles.stroke} />
      <path d="M38 18h20M48 12v12" className={styles.accent} />
    </>
  );
}

function DoneArt() {
  return (
    <>
      <circle cx="48" cy="40" r="18" className={styles.stroke} />
      <path d="M39 41l6 6 12-14" className={styles.accent} />
    </>
  );
}

function TodayArt() {
  return (
    <>
      <rect x="22" y="18" width="52" height="46" rx="8" className={styles.stroke} />
      <path d="M22 32h52M34 14v8M62 14v8" className={styles.stroke} />
      <path d="M48 42v12M42 48h12" className={styles.accent} />
    </>
  );
}

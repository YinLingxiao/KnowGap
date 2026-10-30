"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, BookOpen, ChevronRight, RotateCcw } from "lucide-react";
import { agendaApi } from "@/lib/agenda/api";
import {
  AGENDA_CHANGED_EVENT,
  type AgendaFeed, type AgendaTask,
} from "@/lib/agenda/types";
import type { ConversationSummary, LearnerMemory, Subject } from "@/lib/chat/types";
import { useI18n } from "@/components/LanguageProvider";
import styles from "./TodayPanel.module.css";

interface TodayPanelProps {
  conversations: ConversationSummary[];
  recentTopics: ConversationSummary[];
  recentSpaces: Subject[];
  reviewTarget: LearnerMemory | null;
  showReview: boolean;
  onReview: () => void;
  onPlanReview: () => void;
  onOpenConversation: (id: string) => void;
  onOpenSpace: (id: string) => void;
  onOpenSpaces: () => void;
}

function localDay() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** A task becomes actionable at either its scheduled date or its deadline. */
function dueDay(task: AgendaTask) {
  return [task.scheduledDate, task.scheduledStartAt?.slice(0, 10), task.deadlineDate]
    .filter((day): day is string => Boolean(day)).sort()[0] ?? null;
}

export function TodayPanel(props: TodayPanelProps) {
  const { tx } = useI18n();
  const [feed, setFeed] = useState<AgendaFeed | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [completionError, setCompletionError] = useState("");
  const pendingIds = useRef(new Set<string>());
  const requestId = useRef(0);

  useEffect(() => {
    let live = true;
    const refresh = async () => {
      const id = ++requestId.current;
      try {
        const next = await agendaApi.feed();
        if (!live || id !== requestId.current) return;
        setFeed(next);
        setFailed(false);
      } catch {
        if (live && id === requestId.current) setFailed(true);
      } finally {
        if (live && id === requestId.current) setLoading(false);
      }
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    void refresh();
    window.addEventListener(AGENDA_CHANGED_EVENT, refresh);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisible);
    // Also roll today's list over when the home screen is left open overnight.
    const timer = window.setInterval(onVisible, 60_000);
    return () => {
      live = false;
      window.clearInterval(timer);
      window.removeEventListener(AGENDA_CHANGED_EVENT, refresh);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  const today = feed?.today || localDay();
  const tasks = useMemo(() => (feed?.tasks ?? [])
    .filter((task) => task.status === "open" && dueDay(task) !== null && dueDay(task)! <= today)
    .sort((a, b) => dueDay(a)!.localeCompare(dueDay(b)!) || a.priority - b.priority
      || (a.scheduledStartAt ?? "").localeCompare(b.scheduledStartAt ?? "") || a.sortOrder - b.sortOrder),
  [feed, today]);

  const continuing = useMemo(() => {
    const items = new Map<string, { id: string; title: string; context: string; updatedAt: string }>();
    for (const conversation of props.conversations) {
      if (conversation.title === "初识引导 · 定制你的学习画像") continue;
      if (conversation.kind !== "chat" && !(conversation.kind === "thread" && conversation.threadStatus === "open")) continue;
      items.set(conversation.id, {
        id: conversation.id, title: conversation.title, updatedAt: conversation.updatedAt,
        context: conversation.kind === "thread" ? tx("进行中支线") : tx("最近对话"),
      });
    }
    if (!failed) for (const thread of feed?.threads ?? []) {
      items.set(thread.threadId, {
        id: thread.threadId, title: thread.title, context: thread.subjectName, updatedAt: thread.updatedAt,
      });
    }
    return [...items.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 2);
  }, [props.conversations, feed, failed, tx]);

  const complete = async (task: AgendaTask) => {
    if (pendingIds.current.has(task.id)) return;
    pendingIds.current.add(task.id);
    setPending(new Set(pendingIds.current));
    setCompletionError("");
    try {
      await agendaApi.updateTask(task.id, { status: "done" });
      // Invalidate any older feed response before removing the completed row.
      ++requestId.current;
      setFeed((current) => current && { ...current, tasks: current.tasks.filter((item) => item.id !== task.id) });
      window.dispatchEvent(new CustomEvent(AGENDA_CHANGED_EVENT));
    } catch {
      setCompletionError("没能完成这项任务，请再试一次。");
    } finally {
      pendingIds.current.delete(task.id);
      setPending(new Set(pendingIds.current));
    }
  };

  const openAgenda = () => window.dispatchEvent(new CustomEvent("knowgap:open-agenda"));

  return (
    <section className={styles.panel} aria-labelledby="today-title">
      <header className={styles.header}>
        <h2 id="today-title">{tx("今天")}</h2>
        <span className={styles.date}>{today.slice(5).replace("-", " / ")}</span>
        <span className={styles.flow}>{tx("记住薄弱点，留给今天巩固")}</span>
      </header>

      {!failed && (
        <>
          <section className={styles.section} aria-labelledby="today-tasks-title" aria-busy={loading}>
            <div className={styles.sectionHead}>
              <h3 id="today-tasks-title">{tx("今日待办")} {!loading && tasks.length > 0 && <span className={styles.count}>{tasks.length}</span>}</h3>
              <button type="button" className={styles.link} onClick={openAgenda}>{tx("查看全部")} <ChevronRight size={13} aria-hidden /></button>
            </div>
            {loading ? <div className={styles.loading} role="status">{tx("正在整理今天的安排…")}</div> : tasks.length > 0 ? (
              <ul className={styles.tasks}>
                {tasks.slice(0, 5).map((task) => (
                  <li key={task.id} className={styles.task}>
                    <input
                      type="checkbox"
                      className={styles.checkbox}
                      checked={pending.has(task.id)}
                      disabled={pending.has(task.id)}
                      aria-label={tx("完成：{title}", { title: task.title })}
                      onChange={() => void complete(task)}
                    />
                    <div className={styles.taskBody}>
                      <span className={styles.taskTitle}>{task.title}</span>
                      <span className={styles.taskMeta}>
                        {task.source === "review" && <span className={styles.reviewTag}>{tx("闪回复习")}</span>}
                        {dueDay(task)! < today ? <span className={styles.overdue}>{tx("逾期 · {date}", { date: dueDay(task)?.slice(5) ?? "" })}</span>
                          : <span>{task.scheduledStartAt?.slice(11, 16) || tx("今天")}</span>}
                        {task.durationMinutes != null && <span>{tx("{minutes} 分钟", { minutes: task.durationMinutes })}</span>}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            ) : props.reviewTarget ? <p className={styles.hint}>{tx("今天没有待办，先巩固一个易错点。")}</p> : null}
            {completionError && <p role="alert" className={styles.error}>{tx(completionError)}</p>}
          </section>

          {props.reviewTarget && props.showReview && (
            <section className={styles.review} aria-label={tx("到期复习")}>
              <RotateCcw size={15} aria-hidden />
              <div className={styles.reviewBody}>
                <span className={styles.reviewLabel}>{tx("到期复习 · 待巩固闪回")}</span>
                <p title={props.reviewTarget.summary}><strong>{tx("{topic}：", { topic: props.reviewTarget.topic })}</strong>{props.reviewTarget.summary}</p>
              </div>
              <button type="button" className={styles.reviewAction} onClick={props.onReview}>{tx("1 分钟靶向自测")} <ArrowRight size={13} aria-hidden /></button>
            </section>
          )}

          {!loading && tasks.length === 0 && !props.reviewTarget && (
            <div className={styles.empty}>
              <p>{tx("今天还没有待办或到期复习，把薄弱点安排进这周吧。")}</p>
              <button type="button" className={styles.plan} onClick={props.onPlanReview}>{tx("让 AI 帮我排这周的复习")} <ArrowRight size={14} aria-hidden /></button>
            </div>
          )}
        </>
      )}

      <section className={styles.section} aria-labelledby="today-continue-title">
        <div className={styles.sectionHead}><h3 id="today-continue-title">{tx("继续学习")}</h3></div>
        {continuing.length > 0 ? (
          <ul className={styles.continuing}>
            {continuing.map((item) => (
              <li key={item.id}>
                <button type="button" className={styles.continueButton} onClick={() => props.onOpenConversation(item.id)}>
                  <BookOpen size={15} aria-hidden />
                  <span className={styles.continueTitle}>{item.title}</span>
                  <span className={styles.context}>{item.context}</span>
                  <ChevronRight size={14} aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        ) : <button type="button" className={styles.link} onClick={props.onOpenSpaces}>{tx("从学习空间开始")} <ChevronRight size={13} aria-hidden /></button>}
      </section>

      <footer className={styles.resume} aria-label={tx("继续上次")}>
        <span>{tx("继续上次")}</span>
        {props.recentTopics[0] && <button type="button" onClick={() => props.onOpenConversation(props.recentTopics[0].id)} title={props.recentTopics[0].title}>{tx("最近话题")} <ChevronRight size={12} aria-hidden /></button>}
        {props.recentSpaces[0] && <button type="button" onClick={() => props.onOpenSpace(props.recentSpaces[0].id)} title={props.recentSpaces[0].name}>{props.recentSpaces[0].name} <ChevronRight size={12} aria-hidden /></button>}
        <button type="button" onClick={props.onOpenSpaces}>{tx("全部学习空间")} <ChevronRight size={12} aria-hidden /></button>
      </footer>
    </section>
  );
}

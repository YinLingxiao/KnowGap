"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CalendarDays, CircleAlert, Download, Inbox, List, LoaderCircle, PanelLeftOpen, RotateCcw, Sparkles,
} from "lucide-react";
import { describeError } from "@/lib/api/errors";
import { agendaApi } from "@/lib/agenda/api";
import type { AgendaTask, AgendaThread, TaskInput } from "@/lib/agenda/types";
import type { Subject } from "@/lib/chat/types";
import { cx } from "@/lib/cx";
import { FocusHeatmap } from "../focus/FocusHeatmap";
import AiBreakdownDialog from "./AiBreakdownDialog";
import { AgendaList, type SubjectInfo } from "./AgendaList";
import {
  buildGroups, compareSiblings, dispatchFocusStart, taskKey, threadKey, type GroupKey,
} from "./agendaModel";
import { QuickAdd } from "./QuickAdd";
import { TaskInspector } from "./TaskInspector";
import { useAgenda } from "./useAgenda";
import WeekCalendar from "./WeekCalendar";
import styles from "./AgendaPage.module.css";

type ViewMode = "list" | "week";

interface AgendaPageProps {
  subjects: Subject[];
  sidebarOpen: boolean;
  onOpenSidebar: () => void;
  /** 打开某个 Thread（对话 id 与所属空间） */
  onOpenThread: (threadId: string, subjectId: string | null) => void;
  onNotify: (toast: { tone: "success" | "error" | "info"; title: string; description?: string }) => void;
}

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function AgendaPage(props: AgendaPageProps) {
  const { onNotify } = props;
  const notifyError = useCallback((title: string) => onNotify({ tone: "error", title }), [onNotify]);
  const agenda = useAgenda(notifyError);
  const { tasks, threads, today, update, create, remove } = agenda;

  const [mode, setMode] = useState<ViewMode>("list");
  const [subjectFilter, setSubjectFilter] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [inspectedId, setInspectedId] = useState<string | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<GroupKey>>(new Set());
  const [collapsedParents, setCollapsedParents] = useState<ReadonlySet<string>>(new Set());
  const [exporting, setExporting] = useState(false);
  const [breakdownOpen, setBreakdownOpen] = useState(false);
  const [weekStart, setWeekStart] = useState<string | null>(null);
  const quickRef = useRef<HTMLInputElement>(null);

  const subjectInfos = useMemo<SubjectInfo[]>(
    () => props.subjects.map((subject) => ({ id: subject.id, name: subject.name, color: subject.color })),
    [props.subjects],
  );
  const subjectMap = useMemo(() => new Map(subjectInfos.map((item) => [item.id, item])), [subjectInfos]);

  // 筛选的空间被删除后，回到「全部空间」
  useEffect(() => {
    if (subjectFilter && !subjectMap.has(subjectFilter)) setSubjectFilter(null);
  }, [subjectFilter, subjectMap]);

  const groups = useMemo(
    () => buildGroups({ tasks, threads, today, subjectId: subjectFilter }),
    [tasks, threads, today, subjectFilter],
  );

  const inspected = inspectedId ? tasks.find((task) => task.id === inspectedId) ?? null : null;
  useEffect(() => {
    if (inspectedId && agenda.status === "ready" && !inspected) setInspectedId(null);
  }, [agenda.status, inspected, inspectedId]);

  const toggleGroup = useCallback((key: GroupKey) => {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }, []);
  const toggleParent = useCallback((id: string) => {
    setCollapsedParents((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);

  const openTask = useCallback((task: AgendaTask) => {
    setSelectedKey(taskKey(task.id));
    setInspectedId(task.id);
  }, []);
  const toggleDone = useCallback((task: AgendaTask) => {
    void update(task.id, { status: task.status === "done" ? "open" : "done" });
  }, [update]);
  const focusTask = useCallback((task: AgendaTask) => {
    dispatchFocusStart({ taskId: task.id, title: task.title, subjectId: task.subjectId });
  }, []);
  const focusThread = useCallback((thread: AgendaThread) => {
    dispatchFocusStart({ taskId: null, title: thread.title, subjectId: thread.subjectId });
  }, []);

  const createTask = useCallback(async (input: TaskInput) => {
    const task = await create({ ...input, source: "manual" });
    if (task) setSelectedKey(taskKey(task.id));
    return Boolean(task);
  }, [create]);

  const addSubtask = useCallback(async (parent: AgendaTask, title: string) => {
    const child = await create({
      title, parentId: parent.id, subjectId: parent.subjectId, source: "manual",
    });
    if (child) setCollapsedParents((current) => {
      if (!current.has(parent.id)) return current;
      const next = new Set(current);
      next.delete(parent.id);
      return next;
    });
    return child;
  }, [create]);

  const deleteTask = useCallback(async (id: string) => {
    const ok = await remove(id);
    if (ok) {
      setInspectedId((current) => (current === id ? null : current));
      setSelectedKey((current) => (current === taskKey(id) ? null : current));
    }
    return ok;
  }, [remove]);

  const exportIcs = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const blob = await agendaApi.exportIcs({ status: "open", subjectId: subjectFilter });
      download(blob, "knowgap-agenda.ics");
      onNotify({ tone: "success", title: "已导出 knowgap-agenda.ics" });
    } catch (cause) {
      onNotify({ tone: "error", title: cause instanceof Error ? cause.message : "导出失败" });
    } finally {
      setExporting(false);
    }
  };

  // 页面级快捷键：n 聚焦快录；焦点在输入控件里时不拦截
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "n" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      event.preventDefault();
      quickRef.current?.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const subtasks = useMemo(
    () => (inspected ? tasks.filter((task) => task.parentId === inspected.id).sort(compareSiblings) : []),
    [inspected, tasks],
  );
  const parentTitle = inspected?.parentId ? tasks.find((task) => task.id === inspected.parentId)?.title ?? null : null;
  const openCount = useMemo(
    () => groups.filter((group) => group.key !== "done").reduce((sum, group) => sum + group.nodes.length, 0),
    [groups],
  );

  const failure = agenda.error ? describeError(agenda.error) : null;
  const showInspector = Boolean(inspected);
  const currentWeek = weekStart ?? mondayOf(today);

  return (
    <div className={styles.page}>
      <header className={styles.top}>
        {!props.sidebarOpen && (
          <button type="button" className={styles.iconBtn} onClick={props.onOpenSidebar} aria-label="展开侧栏" title="展开侧栏">
            <PanelLeftOpen size={16} />
          </button>
        )}
        <h1 className={styles.heading}>日程</h1>
        {agenda.status === "ready" && <span className={styles.badge}>{openCount} 项待办</span>}

        <div className={styles.switch} role="group" aria-label="视图切换">
          <button type="button" className={cx(styles.switchBtn, mode === "list" && styles.switchOn)} aria-pressed={mode === "list"} onClick={() => setMode("list")}>
            <List size={13} aria-hidden />列表
          </button>
          <button type="button" className={cx(styles.switchBtn, mode === "week" && styles.switchOn)} aria-pressed={mode === "week"} onClick={() => setMode("week")}>
            <CalendarDays size={13} aria-hidden />周历
          </button>
        </div>

        <span className={styles.spacer} />

        <label className={styles.filter}>
          <span className="sr-only">按空间筛选</span>
          <select
            value={subjectFilter ?? ""}
            aria-label="按空间筛选"
            onChange={(event) => setSubjectFilter(event.target.value || null)}
          >
            <option value="">全部空间</option>
            {subjectInfos.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>

        <button type="button" className={styles.btn} onClick={() => setBreakdownOpen(true)}>
          <Sparkles size={13} aria-hidden />AI 拆解排期
        </button>
        <button type="button" className={styles.btn} onClick={() => void exportIcs()} disabled={exporting}>
          {exporting ? <LoaderCircle size={13} className={styles.spin} aria-hidden /> : <Download size={13} aria-hidden />}导出 .ics
        </button>
      </header>

      <div className={cx(styles.content, showInspector && styles.withInspector)}>
        <div className={styles.mainCol}>
          {mode === "list" ? (
            <>
              <div className={styles.quick}>
                <QuickAdd ref={quickRef} subjects={subjectInfos} defaultSubjectId={subjectFilter} onCreate={createTask} />
              </div>
              <div className={styles.scroll}>
                {agenda.status === "loading" ? (
                  <div className={styles.skeleton} role="status" aria-label="正在加载日程">
                    {Array.from({ length: 7 }, (_, index) => <span key={index} style={{ width: `${88 - index * 6}%` }} />)}
                  </div>
                ) : agenda.status === "error" ? (
                  <div className={styles.state} role="alert">
                    <CircleAlert size={20} aria-hidden />
                    <h2>{failure?.title ?? "日程加载失败"}</h2>
                    <p>{agenda.error?.message && agenda.error.message !== failure?.title ? agenda.error.message : failure?.hint}</p>
                    <button type="button" className={styles.btn} onClick={() => void agenda.reload()}>
                      <RotateCcw size={13} aria-hidden />重新加载
                    </button>
                  </div>
                ) : groups.length === 0 ? (
                  <div className={styles.state}>
                    <Inbox size={20} aria-hidden />
                    <h2>{subjectFilter ? "这个空间还没有日程" : "还没有日程"}</h2>
                    <p>在上面的输入框里写一句话就能添加，比如「明天下午3点 复习戴维南定理 p1 45分钟」。艾宾浩斯闪回和进行中的 Thread 也会出现在这里。</p>
                    <button type="button" className={styles.btn} onClick={() => quickRef.current?.focus()}>开始添加</button>
                  </div>
                ) : (
                  <AgendaList
                    groups={groups}
                    today={today}
                    subjects={subjectMap}
                    selectedKey={selectedKey}
                    collapsedGroups={collapsedGroups}
                    collapsedParents={collapsedParents}
                    onSelect={setSelectedKey}
                    onOpenTask={openTask}
                    onOpenThread={(thread) => { setSelectedKey(threadKey(thread.threadId)); props.onOpenThread(thread.threadId, thread.subjectId); }}
                    onToggleDone={toggleDone}
                    onFocusTask={focusTask}
                    onFocusThread={focusThread}
                    onToggleGroup={toggleGroup}
                    onToggleParent={toggleParent}
                  />
                )}
                {agenda.status === "ready" && (
                  <section className={styles.heatmap} aria-label="12 周专注热力图">
                    <FocusHeatmap />
                  </section>
                )}
              </div>
            </>
          ) : (
            <WeekCalendar
              weekStart={currentWeek}
              tasks={subjectFilter ? tasks.filter((task) => task.subjectId === subjectFilter) : tasks}
              threads={subjectFilter ? threads.filter((thread) => thread.subjectId === subjectFilter) : threads}
              today={today}
              onWeekChange={setWeekStart}
              onSelectTask={(id) => { setSelectedKey(taskKey(id)); setInspectedId(id); }}
              onSelectThread={(id) => props.onOpenThread(id, threads.find((thread) => thread.threadId === id)?.subjectId ?? null)}
              onReschedule={(taskId, patch) => void update(taskId, patch)}
              onCreateAt={(slot) => void create({
                title: "新任务", scheduledDate: slot.scheduledDate, scheduledStartAt: slot.scheduledStartAt,
                durationMinutes: slot.scheduledStartAt ? 30 : null, subjectId: subjectFilter, source: "manual",
              }).then((task) => { if (task) openTask(task); })}
            />
          )}
        </div>

        {showInspector && inspected && (
          <div className={styles.inspector}>
            <TaskInspector
              key={inspected.id}
              task={inspected}
              parentTitle={parentTitle}
              subtasks={subtasks}
              subjects={subjectInfos}
              onClose={() => setInspectedId(null)}
              onUpdate={update}
              onDelete={deleteTask}
              onAddSubtask={addSubtask}
              onSelectTask={(id) => { setInspectedId(id); setSelectedKey(taskKey(id)); }}
            />
          </div>
        )}
      </div>

      <AiBreakdownDialog
        open={breakdownOpen}
        subjects={props.subjects.map((subject) => ({
          id: subject.id, name: subject.name, color: subject.color, deadline: subject.deadline,
        }))}
        defaultSubjectId={subjectFilter}
        onClose={() => setBreakdownOpen(false)}
        onCreated={(created) => {
          setBreakdownOpen(false);
          void agenda.reload();
          onNotify({ tone: "success", title: `已加入 ${created.children.length + (created.parent ? 1 : 0)} 项任务` });
        }}
      />
    </div>
  );
}

/** 本地日期所在周的周一（YYYY-MM-DD） */
function mondayOf(day: string): string {
  const base = day ? new Date(`${day}T00:00:00`) : new Date();
  const offset = (base.getDay() + 6) % 7;
  base.setDate(base.getDate() - offset);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${base.getFullYear()}-${pad(base.getMonth() + 1)}-${pad(base.getDate())}`;
}

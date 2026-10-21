"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CircleAlert, Download, LoaderCircle, PanelLeftOpen, RotateCcw, Sparkles } from "lucide-react";
import { describeError } from "@/lib/api/errors";
import { agendaApi } from "@/lib/agenda/api";
import type { AgendaTask, AgendaThread, TaskInput } from "@/lib/agenda/types";
import type { Subject } from "@/lib/chat/types";
import { cx } from "@/lib/cx";
import AiBreakdownDialog from "./AiBreakdownDialog";
import { AgendaList, useListState, type AgendaListProps, type SubjectInfo } from "./AgendaList";
import {
  VIEW_LABELS, buildInboxGroups, buildTodayGroups, buildUpcomingGroups, compareSiblings, countViews,
  dispatchCompose, dispatchFocusStart, mondayOf, parseViewKey, spaceIdOf, taskKey, threadKey,
  type AgendaGroup, type AgendaViewKey,
} from "./agendaModel";
import { AgendaRail } from "./AgendaRail";
import { QuickAdd } from "./QuickAdd";
import { SpaceTaskList } from "./SpaceTasks";
import { TaskInspector } from "./TaskInspector";
import { UpcomingView } from "./UpcomingView";
import { useAgenda } from "./useAgenda";
import WeekCalendar from "./WeekCalendar";
import styles from "./AgendaPage.module.css";

const VIEW_KEY = "knowgap.agenda.view.v1";

function readView(): AgendaViewKey {
  try {
    return parseViewKey(localStorage.getItem(VIEW_KEY)) ?? "upcoming";
  } catch {
    return "upcoming";
  }
}

interface AgendaPageProps {
  subjects: Subject[];
  sidebarOpen: boolean;
  onOpenSidebar: () => void;
  /** 打开某个 Thread（对话 id 与所属空间） */
  onOpenThread: (threadId: string, subjectId: string | null) => void;
  onOpenSpace: (subjectId: string) => void;
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

  const [view, setViewState] = useState<AgendaViewKey>("upcoming");
  const list = useListState();
  const { selectedKey, setSelectedKey, collapsedGroups, collapsedParents, toggleGroup, toggleParent, expandParent } = list;
  const [inspectedId, setInspectedId] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [breakdownOpen, setBreakdownOpen] = useState(false);
  const [weekStart, setWeekStart] = useState<string | null>(null);
  const quickRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setViewState(readView()); }, []);
  const setView = useCallback((next: AgendaViewKey) => {
    setViewState(next);
    setSelectedKey(null);
    try { localStorage.setItem(VIEW_KEY, next); } catch { /* 存储不可用时只影响下次打开 */ }
  }, [setSelectedKey]);

  const subjectInfos = useMemo<SubjectInfo[]>(
    () => props.subjects.map((subject) => ({ id: subject.id, name: subject.name, color: subject.color })),
    [props.subjects],
  );
  const subjectMap = useMemo(() => new Map(subjectInfos.map((item) => [item.id, item])), [subjectInfos]);

  const spaceId = spaceIdOf(view);
  const space = spaceId ? props.subjects.find((subject) => subject.id === spaceId) ?? null : null;
  // 选中的空间被删除后回到「预览」
  useEffect(() => {
    if (spaceId && props.subjects.length > 0 && !space) setView("upcoming");
  }, [spaceId, space, props.subjects.length, setView]);

  const counts = useMemo(() => countViews(tasks, threads, today), [tasks, threads, today]);
  const groups = useMemo<AgendaGroup[]>(() => {
    if (view === "today") return buildTodayGroups(tasks, threads, today);
    if (view === "inbox") return buildInboxGroups(tasks);
    if (view === "upcoming") return buildUpcomingGroups(tasks, threads, today);
    return [];
  }, [view, tasks, threads, today]);

  const inspected = inspectedId ? tasks.find((task) => task.id === inspectedId) ?? null : null;
  useEffect(() => {
    if (inspectedId && agenda.status === "ready" && !inspected) setInspectedId(null);
  }, [agenda.status, inspected, inspectedId]);

  const openTask = useCallback((task: AgendaTask) => {
    setSelectedKey(taskKey(task.id));
    setInspectedId(task.id);
  }, [setSelectedKey]);
  const toggleDone = useCallback((task: AgendaTask) => {
    void update(task.id, { status: task.status === "done" ? "open" : "done" });
  }, [update]);
  const focusTask = useCallback((task: AgendaTask) => {
    dispatchFocusStart({ taskId: task.id, title: task.title, subjectId: task.subjectId });
  }, []);
  const focusThread = useCallback((thread: AgendaThread) => {
    dispatchFocusStart({ taskId: null, title: thread.title, subjectId: thread.subjectId });
  }, []);
  const openThread = useCallback((thread: AgendaThread) => {
    setSelectedKey(threadKey(thread.threadId));
    props.onOpenThread(thread.threadId, thread.subjectId);
  }, [props, setSelectedKey]);

  const createTask = useCallback(async (input: TaskInput) => {
    // 「今天」视图里快录的任务默认排在今天
    const dated = view === "today" && !input.scheduledDate && !input.scheduledStartAt
      ? { ...input, scheduledDate: today } : input;
    const task = await create({ ...dated, source: "manual" });
    if (task) setSelectedKey(taskKey(task.id));
    return Boolean(task);
  }, [create, view, today, setSelectedKey]);

  const addSubtask = useCallback(async (parent: AgendaTask, title: string) => {
    const child = await create({ title, parentId: parent.id, subjectId: parent.subjectId, source: "manual" });
    if (child) expandParent(parent.id);
    return child;
  }, [create, expandParent]);

  const deleteTask = useCallback(async (id: string) => {
    const ok = await remove(id);
    if (ok) {
      setInspectedId((current) => (current === id ? null : current));
      setSelectedKey((current) => (current === taskKey(id) ? null : current));
    }
    return ok;
  }, [remove, setSelectedKey]);

  const exportIcs = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const blob = await agendaApi.exportIcs({ status: "open", subjectId: spaceId });
      download(blob, "knowgap-agenda.ics");
      onNotify({ tone: "success", title: "已导出 knowgap-agenda.ics" });
    } catch (cause) {
      onNotify({ tone: "error", title: cause instanceof Error ? cause.message : "导出失败" });
    } finally {
      setExporting(false);
    }
  };

  const subtasks = useMemo(
    () => (inspected ? tasks.filter((task) => task.parentId === inspected.id).sort(compareSiblings) : []),
    [inspected, tasks],
  );
  const parentTitle = inspected?.parentId ? tasks.find((task) => task.id === inspected.parentId)?.title ?? null : null;

  const failure = agenda.error ? describeError(agenda.error) : null;
  const showInspector = Boolean(inspected);
  const currentWeek = weekStart ?? mondayOf(today);
  const heading = space ? space.name : (VIEW_LABELS as Record<string, string>)[view] ?? "日程";
  const listProps: Omit<AgendaListProps, "groups" | "today"> = {
    subjects: subjectMap,
    selectedKey,
    collapsedGroups,
    collapsedParents,
    onSelect: setSelectedKey,
    onOpenTask: openTask,
    onOpenThread: openThread,
    onToggleDone: toggleDone,
    onFocusTask: focusTask,
    onFocusThread: focusThread,
    onToggleGroup: toggleGroup,
    onToggleParent: toggleParent,
    onCompose: (defaults) => dispatchCompose(defaults),
  };

  let main: React.ReactNode;
  if (agenda.status === "loading") {
    main = (
      <div className={styles.skeleton} role="status" aria-label="正在加载日程">
        {Array.from({ length: 7 }, (_, index) => <span key={index} style={{ width: `${88 - index * 6}%` }} />)}
      </div>
    );
  } else if (agenda.status === "error") {
    main = (
      <div className={styles.state} role="alert">
        <CircleAlert size={20} aria-hidden />
        <h2>{failure?.title ?? "日程加载失败"}</h2>
        <p>{agenda.error?.message && agenda.error.message !== failure?.title ? agenda.error.message : failure?.hint}</p>
        <button type="button" className={styles.btn} onClick={() => void agenda.reload()}>
          <RotateCcw size={13} aria-hidden />重新加载
        </button>
      </div>
    );
  } else if (view === "week") {
    main = (
      <WeekCalendar
        weekStart={currentWeek}
        tasks={tasks}
        threads={threads}
        today={today}
        onWeekChange={setWeekStart}
        onSelectTask={(id) => { setSelectedKey(taskKey(id)); setInspectedId(id); }}
        onSelectThread={(id) => props.onOpenThread(id, threads.find((thread) => thread.threadId === id)?.subjectId ?? null)}
        onReschedule={(taskId, patch) => void update(taskId, patch)}
        onCreateAt={(slot) => void create({
          title: "新任务", scheduledDate: slot.scheduledDate, scheduledStartAt: slot.scheduledStartAt,
          durationMinutes: slot.scheduledStartAt ? 30 : null, source: "manual",
        }).then((task) => { if (task) openTask(task); })}
      />
    );
  } else if (space) {
    main = (
      <SpaceTaskList
        subject={{ id: space.id, name: space.name, color: space.color, deadline: space.deadline }}
        tasks={tasks}
        threads={threads}
        today={today}
        onOpenTask={openTask}
        onOpenThread={openThread}
        onToggleDone={toggleDone}
        onOpenSpace={() => props.onOpenSpace(space.id)}
      />
    );
  } else if (view === "upcoming") {
    main = <UpcomingView groups={groups} today={today} listProps={listProps} />;
  } else {
    main = (
      <>
        <div className={styles.quick}>
          <QuickAdd ref={quickRef} subjects={subjectInfos} defaultSubjectId={null} onCreate={createTask} />
        </div>
        <div className={styles.scroll}>
          {groups.every((group) => group.nodes.length === 0) ? (
            <div className={styles.emptyLine}>
              <p>完成的任务和复习会出现在这里。</p>
              <button type="button" className={styles.btn} onClick={() => dispatchCompose({})}>记一个任务</button>
            </div>
          ) : (
            <AgendaList groups={groups} today={today} {...listProps} />
          )}
        </div>
      </>
    );
  }

  return (
    <div className={styles.page} data-coachmark="agenda">
      <header className={styles.top}>
        {!props.sidebarOpen && (
          <button type="button" className={styles.iconBtn} onClick={props.onOpenSidebar} aria-label="展开侧栏" title="展开侧栏">
            <PanelLeftOpen size={16} />
          </button>
        )}
        <h1 className={styles.heading}>{heading}</h1>
        <span className={styles.spacer} />
        <button type="button" className={styles.btn} onClick={() => setBreakdownOpen(true)} aria-label="AI 拆解排期" title="AI 拆解排期">
          <Sparkles size={13} aria-hidden />AI 拆解排期
        </button>
        <button type="button" className={styles.btn} onClick={() => void exportIcs()} disabled={exporting} aria-label="导出 .ics" title="导出 .ics 日历文件">
          {exporting ? <LoaderCircle size={13} className={styles.spin} aria-hidden /> : <Download size={13} aria-hidden />}导出 .ics
        </button>
      </header>

      <div className={styles.body}>
        <AgendaRail view={view} counts={counts} subjects={subjectInfos} onChange={setView} />
        <div className={cx(styles.content, showInspector && styles.withInspector)}>
          <div className={styles.mainCol}>{main}</div>
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
      </div>

      <AiBreakdownDialog
        open={breakdownOpen}
        subjects={props.subjects.map((subject) => ({
          id: subject.id, name: subject.name, color: subject.color, deadline: subject.deadline,
        }))}
        defaultSubjectId={spaceId}
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

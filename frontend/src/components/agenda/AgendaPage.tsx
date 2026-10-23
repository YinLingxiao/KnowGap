"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CircleAlert, Download, Ellipsis, LoaderCircle, PanelLeftOpen, Plus, RotateCcw, Sparkles } from "lucide-react";
import { describeError } from "@/lib/api/errors";
import { agendaApi } from "@/lib/agenda/api";
import type { AgendaTask, AgendaThread, TaskInput, TaskPatch, TaskPriority } from "@/lib/agenda/types";
import type { Subject } from "@/lib/chat/types";
import { cx } from "@/lib/cx";
import { AgendaEmpty } from "./AgendaEmpty";
import AiBreakdownDialog from "./AiBreakdownDialog";
import { AgendaList, useListState, type AgendaListProps, type SubjectInfo, type TaskActions } from "./AgendaList";
import {
  DEFAULT_VIEW_OPTIONS, VIEW_LABELS, applyViewOptions, buildInboxGroups, buildTodayGroups, buildTodaySuggestions,
  buildUpcomingGroups, compareSiblings, completedOn, countViews, dayGroupKey, dispatchCompose, mondayOf,
  parseViewKey, schedulePatch, spaceIdOf, taskKey, threadKey,
  type AgendaGroup, type AgendaViewKey, type AgendaViewOptions,
} from "./agendaModel";
import { loadViewOptions, saveViewOptions, ViewOptions } from "./ViewOptions";
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
  /** 打开某个支线（对话 id 与所属空间） */
  onOpenThread: (threadId: string, subjectId: string | null) => void;
  onOpenSpace: (subjectId: string) => void;
  onNotify: (toast: {
    tone: "success" | "error" | "info";
    title: string;
    description?: string;
    action?: { label: string; onClick: () => void };
  }) => void;
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
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!moreOpen) return;
    const close = (event: MouseEvent) => {
      if (!moreRef.current?.contains(event.target as Node)) setMoreOpen(false);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setMoreOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [moreOpen]);
  const [weekStart, setWeekStart] = useState<string | null>(null);
  const [leavingIds, setLeavingIds] = useState<ReadonlySet<string>>(new Set());
  const [composer, setComposer] = useState<{ groupKey: string; defaults: NonNullable<AgendaGroup["compose"]>; seed?: string } | null>(null);
  const [options, setOptions] = useState<AgendaViewOptions>(DEFAULT_VIEW_OPTIONS);
  const [breakdownSubject, setBreakdownSubject] = useState<string | null>(null);
  const quickRef = useRef<HTMLInputElement>(null);
  const pendingDone = useRef<Map<string, number>>(new Map());

  useEffect(() => { setViewState(readView()); }, []);
  useEffect(() => {
    setOptions(loadViewOptions(view));
    setComposer(null);
  }, [view]);
  const updateRef = useRef(update);
  updateRef.current = update;
  useEffect(() => {
    const pending = pendingDone.current;
    return () => {
      for (const [id, timer] of pending) {
        window.clearTimeout(timer);
        void updateRef.current(id, { status: "done" });
      }
      pending.clear();
    };
  }, []);
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
    const build = { includeDone: options.showCompleted };
    let built: AgendaGroup[] = [];
    if (view === "today") built = buildTodayGroups(tasks, threads, today, build);
    else if (view === "inbox") built = buildInboxGroups(tasks, build);
    else if (view === "upcoming") built = buildUpcomingGroups(tasks, threads, today, build);
    const effective = view === "upcoming" && options.groupBy === "date" ? { ...options, groupBy: "none" as const } : options;
    return applyViewOptions(built, effective, subjectMap, today);
  }, [view, tasks, threads, today, options, subjectMap]);
  const suggestions = useMemo(
    () => buildTodaySuggestions(tasks, props.subjects.map((subject) => ({ id: subject.id, name: subject.name, deadline: subject.deadline })), today),
    [tasks, props.subjects, today],
  );
  const doneToday = useMemo(() => completedOn(tasks, today), [tasks, today]);

  const inspected = inspectedId ? tasks.find((task) => task.id === inspectedId) ?? null : null;
  useEffect(() => {
    if (inspectedId && agenda.status === "ready" && !inspected) setInspectedId(null);
  }, [agenda.status, inspected, inspectedId]);

  const openTask = useCallback((task: AgendaTask) => {
    setSelectedKey(taskKey(task.id));
    setInspectedId(task.id);
  }, [setSelectedKey]);
  const markLeaving = useCallback((id: string, on: boolean) => {
    setLeavingIds((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  const cancelComplete = useCallback((id: string) => {
    const timer = pendingDone.current.get(id);
    if (!timer) return false;
    window.clearTimeout(timer);
    pendingDone.current.delete(id);
    markLeaving(id, false);
    return true;
  }, [markLeaving]);
  const completeTask = useCallback((task: AgendaTask) => {
    if (task.status === "done" || pendingDone.current.has(task.id)) return;
    markLeaving(task.id, true);
    const timer = window.setTimeout(() => {
      pendingDone.current.delete(task.id);
      void update(task.id, { status: "done" });
      markLeaving(task.id, false);
    }, 300);
    pendingDone.current.set(task.id, timer);
    onNotify({
      tone: "success",
      title: "1 个任务已完成",
      action: { label: "撤销", onClick: () => { if (!cancelComplete(task.id)) void update(task.id, { status: "open" }); } },
    });
  }, [cancelComplete, markLeaving, onNotify, update]);
  const toggleDone = useCallback((task: AgendaTask) => {
    if (task.status === "done") void update(task.id, { status: "open" });
    else completeTask(task);
  }, [completeTask, update]);
  const updateTask = useCallback(async (id: string, patch: TaskPatch) => {
    const current = tasks.find((task) => task.id === id);
    if (patch.status === "done" && current && current.status !== "done") {
      completeTask(current);
      return current;
    }
    if (patch.status === "open" && cancelComplete(id)) return current ?? null;
    return update(id, patch);
  }, [tasks, completeTask, cancelComplete, update]);
  const insertBeside = useCallback(async (task: AgendaTask, where: "above" | "below") => {
    const created = await create({
      title: "新任务", parentId: task.parentId, subjectId: task.subjectId, scheduledDate: task.scheduledDate,
      scheduledStartAt: task.scheduledStartAt, priority: task.priority, source: "manual",
    });
    if (!created) return;
    const siblings = tasks.filter((item) => item.parentId === task.parentId && item.id !== created.id);
    if (where === "above") {
      await update(created.id, { sortOrder: task.sortOrder });
      for (const sibling of siblings) {
        if (sibling.sortOrder >= task.sortOrder) await update(sibling.id, { sortOrder: sibling.sortOrder + 1 });
      }
    } else {
      await update(created.id, { sortOrder: task.sortOrder + 1 });
      for (const sibling of siblings) {
        if (sibling.sortOrder > task.sortOrder) await update(sibling.id, { sortOrder: sibling.sortOrder + 1 });
      }
    }
    openTask(created);
  }, [create, tasks, update, openTask]);
  const duplicateTask = useCallback(async (task: AgendaTask) => {
    const created = await create({
      title: task.title, notes: task.notes, parentId: task.parentId, priority: task.priority, labels: [...task.labels],
      subjectId: task.subjectId, scheduledDate: task.scheduledDate, scheduledStartAt: task.scheduledStartAt,
      durationMinutes: task.durationMinutes, deadlineDate: task.deadlineDate, reminderMinutes: task.reminderMinutes,
      source: "manual",
    });
    if (created) openTask(created);
  }, [create, openTask]);
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
  const groupKeyFor = (defaults: NonNullable<AgendaGroup["compose"]>) => {
    if (view === "inbox") return "inbox";
    if (view === "today" && (!defaults.scheduledDate || defaults.scheduledDate === today)) return "today";
    if (defaults.scheduledDate) return dayGroupKey(defaults.scheduledDate);
    return defaults.subjectId ? "tasks" : "inbox";
  };
  const startCompose = (defaults: NonNullable<AgendaGroup["compose"]>, seed?: string, groupKey?: string) => {
    setComposer({ groupKey: groupKey ?? groupKeyFor(defaults), defaults, seed });
  };
  const composerNode = composer ? (
    <QuickAdd
      key={`${composer.groupKey}:${composer.seed ?? ""}`}
      ref={quickRef}
      subjects={subjectInfos}
      defaultSubjectId={composer.defaults.subjectId ?? spaceId}
      initialText={composer.seed}
      autoFocus
      onCancel={() => setComposer(null)}
      onCreate={async (input) => {
        const merged: TaskInput = {
          ...input,
          scheduledDate: input.scheduledDate ?? composer.defaults.scheduledDate ?? (view === "today" ? today : null),
          subjectId: input.subjectId ?? composer.defaults.subjectId ?? null,
        };
        return createTask(merged).then((ok) => { if (ok) setComposer(null); return ok; });
      }}
    />
  ) : null;
  const taskActions: TaskActions = {
    onSchedule: (task, date) => { void update(task.id, schedulePatch(task, date)); },
    onPriority: (task, priority: TaskPriority) => { void update(task.id, { priority }); },
    onMove: (task, subjectId) => { void update(task.id, { subjectId }); },
    onInsert: (task, where) => { void insertBeside(task, where); },
    onDuplicate: (task) => { void duplicateTask(task); },
    onDelete: (task) => { void deleteTask(task.id); },
  };
  const rescheduleOverdue = () => {
    for (const task of tasks) {
      if (task.status !== "open") continue;
      const day = task.scheduledDate ?? task.deadlineDate;
      if (!day || day >= today) continue;
      void update(task.id, schedulePatch(task, today));
    }
  };
  const openBreakdown = (subjectId: string | null) => {
    setBreakdownSubject(subjectId);
    setBreakdownOpen(true);
  };
  const listProps: Omit<AgendaListProps, "groups" | "today"> = {
    subjects: subjectMap,
    selectedKey,
    collapsedGroups,
    collapsedParents,
    onSelect: setSelectedKey,
    onOpenTask: openTask,
    onOpenThread: openThread,
    onToggleDone: toggleDone,
    onToggleGroup: toggleGroup,
    onToggleParent: toggleParent,
    onCompose: (defaults, groupKey) => startCompose(defaults, undefined, groupKey),
    leavingIds,
    onRescheduleOverdue: rescheduleOverdue,
    composingKey: composer?.groupKey ?? null,
    composer: composerNode,
    taskActions,
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
        showCompleted={options.showCompleted}
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
        viewOptions={options}
        leavingIds={leavingIds}
        taskActions={taskActions}
        onRescheduleOverdue={rescheduleOverdue}
        composingKey={composer?.groupKey ?? null}
        composer={composerNode}
        onCompose={(defaults, groupKey) => startCompose(defaults, undefined, groupKey)}
      />
    );
  } else if (view === "upcoming") {
    main = <UpcomingView groups={groups} today={today} listProps={listProps} onBreakdown={() => openBreakdown(spaceId)} />;
  } else {
    const empty = groups.every((group) => group.nodes.length === 0);
    const todayDone = view === "today" && doneToday > 0;
    main = (
      <div className={styles.scroll}>
        {empty ? (
          <>
            {composerNode}
            <AgendaEmpty
              variant={view === "today" ? (todayDone ? "today-done" : "today-empty") : "inbox"}
              completedCount={doneToday}
              suggestions={suggestions}
              hideAction={Boolean(composer)}
              onAdd={() => startCompose(view === "today" ? { scheduledDate: today } : {})}
              onExample={(text) => startCompose({}, text)}
              onSchedule={(id) => {
                const task = tasks.find((item) => item.id === id);
                if (task) void update(id, schedulePatch(task, today));
              }}
              onBreakdown={openBreakdown}
            />
          </>
        ) : (
          <AgendaList groups={groups} today={today} {...listProps} />
        )}
      </div>
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
        <span className={styles.spacer} />
        <div className={styles.addAction}>
          <button type="button" className={styles.addTask} onClick={() => dispatchCompose({ subjectId: spaceId })}>
            <Plus size={15} aria-hidden />添加任务
          </button>
        </div>
        <ViewOptions
          value={options}
          week={view === "week"}
          onChange={(next) => { setOptions(next); saveViewOptions(view, next); }}
        />
        <button type="button" className={styles.btn} onClick={() => openBreakdown(spaceId)} aria-label="AI 拆解排期" title="AI 拆解排期">
          <Sparkles size={13} aria-hidden />AI 拆解排期
        </button>
        {/* 低频操作收进「…」菜单 */}
        <div className={styles.moreAnchor} ref={moreRef}>
          <button
            type="button"
            className={styles.iconBtn}
            onClick={() => setMoreOpen((open) => !open)}
            aria-haspopup="menu"
            aria-expanded={moreOpen}
            aria-label="更多操作"
            title="更多操作"
          >
            {exporting ? <LoaderCircle size={15} className={styles.spin} aria-hidden /> : <Ellipsis size={16} aria-hidden />}
          </button>
          {moreOpen && (
            <div className={styles.moreMenu} role="menu">
              <button
                type="button"
                role="menuitem"
                className={styles.moreItem}
                disabled={exporting}
                onClick={() => { setMoreOpen(false); void exportIcs(); }}
              >
                <Download size={14} aria-hidden />
                <span>导出到日历（.ics）</span>
              </button>
            </div>
          )}
        </div>
      </header>

      <div className={styles.body}>
        <AgendaRail view={view} counts={counts} subjects={subjectInfos} onChange={setView} onAdd={() => dispatchCompose({ subjectId: spaceId })} />
        <div className={cx(styles.content, showInspector && styles.withInspector)}>
          <div className={cx(styles.mainCol, view !== "week" && styles.sheet)}>
            {view !== "week" && !space && agenda.status === "ready" && <h1 className={styles.pageTitle}>{heading}</h1>}
            {main}
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
                onUpdate={updateTask}
                today={today}
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
        defaultSubjectId={breakdownSubject ?? spaceId}
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

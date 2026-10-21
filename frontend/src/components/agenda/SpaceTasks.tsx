"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowUpRight, CalendarClock, CircleAlert, RotateCcw } from "lucide-react";
import { describeError } from "@/lib/api/errors";
import { agendaApi } from "@/lib/agenda/api";
import { AGENDA_CHANGED_EVENT, type AgendaTask, type AgendaThread } from "@/lib/agenda/types";
import { cx } from "@/lib/cx";
import { AgendaList, useListState, type SubjectInfo } from "./AgendaList";
import {
  buildSpaceGroups, compareSiblings, deadlineInfo, dispatchCompose, dispatchFocusStart, monthDay, taskKey,
  type AgendaGroup,
} from "./agendaModel";
import { TaskInspector } from "./TaskInspector";
import { useAgenda } from "./useAgenda";
import styles from "./SpaceTasks.module.css";

export interface SpaceSubject {
  id: string;
  name: string;
  color: string;
  deadline: string | null;
}

const NO_SUBJECT_TAGS = new Map<string, SubjectInfo>();

/** 空间进度（已完成 / 全部）：feed 只带今天完成的任务，这里单独拉 status=all；任务变动后重新拉取 */
function useSpaceProgress(subjectId: string) {
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  useEffect(() => {
    let alive = true;
    let sequence = 0;
    const load = () => {
      const mine = ++sequence;
      agendaApi.listTasks({ status: "all", subjectId })
        .then((tasks) => {
          if (!alive || mine !== sequence) return;
          setProgress({ done: tasks.filter((task) => task.status === "done").length, total: tasks.length });
        })
        .catch(() => { if (alive && mine === sequence) setProgress(null); });
    };
    setProgress(null);
    load();
    window.addEventListener(AGENDA_CHANGED_EVENT, load);
    return () => {
      alive = false;
      window.removeEventListener(AGENDA_CHANGED_EVENT, load);
    };
  }, [subjectId]);
  return progress;
}

const emptyHint = (group: AgendaGroup) => (group.key === "tasks" ? "这个空间还没有待办任务。" : null);

interface SpaceTaskListProps {
  subject: SpaceSubject;
  tasks: AgendaTask[];
  threads: AgendaThread[];
  today: string;
  onOpenTask: (task: AgendaTask) => void;
  onOpenThread: (thread: AgendaThread) => void;
  onToggleDone: (task: AgendaTask) => void;
  /** 日程页里显示「打开学习空间」；学习空间页内不传 */
  onOpenSpace?: () => void;
}

/** 某个学习空间的未完成任务：进行中 Thread / 闪回复习 / 任务（日程页与学习空间页共用） */
export function SpaceTaskList(props: SpaceTaskListProps) {
  const { subject, tasks, threads, today } = props;
  const list = useListState();
  const progress = useSpaceProgress(subject.id);
  const groups = useMemo(() => buildSpaceGroups(tasks, threads, subject.id), [tasks, threads, subject.id]);
  const deadline = deadlineInfo(subject.deadline, today);

  const focusTask = useCallback((task: AgendaTask) => {
    dispatchFocusStart({ taskId: task.id, title: task.title, subjectId: task.subjectId });
  }, []);
  const focusThread = useCallback((thread: AgendaThread) => {
    dispatchFocusStart({ taskId: null, title: thread.title, subjectId: thread.subjectId });
  }, []);

  return (
    <div className={styles.view}>
      <header className={styles.head}>
        <span className={styles.dot} style={{ background: subject.color }} aria-hidden />
        <h2 className={styles.name} title={subject.name}>{subject.name}</h2>
        {subject.deadline && (
          <span className={cx(styles.meta, deadline?.urgent && styles.urgent)} title={`截止日 ${subject.deadline}`}>
            <CalendarClock size={12} aria-hidden />
            {monthDay(subject.deadline)}截止
          </span>
        )}
        {progress && progress.total > 0 && (
          <span className={styles.meta} title={`已完成 ${progress.done} / 全部 ${progress.total}`}>
            <span className={styles.bar} aria-hidden>
              <span style={{ width: `${(progress.done / progress.total) * 100}%` }} />
            </span>
            <span className={styles.num}>{progress.done}/{progress.total}</span>
          </span>
        )}
        <span className={styles.spacer} />
        {props.onOpenSpace && (
          <button type="button" className={styles.openBtn} onClick={props.onOpenSpace}>
            打开学习空间
            <ArrowUpRight size={13} aria-hidden />
          </button>
        )}
      </header>

      <div className={styles.scroll}>
        <AgendaList
          groups={groups}
          today={today}
          subjects={NO_SUBJECT_TAGS}
          selectedKey={list.selectedKey}
          collapsedGroups={list.collapsedGroups}
          collapsedParents={list.collapsedParents}
          onSelect={list.setSelectedKey}
          onOpenTask={props.onOpenTask}
          onOpenThread={props.onOpenThread}
          onToggleDone={props.onToggleDone}
          onFocusTask={focusTask}
          onFocusThread={focusThread}
          onToggleGroup={list.toggleGroup}
          onToggleParent={list.toggleParent}
          onCompose={(defaults) => dispatchCompose(defaults)}
          emptyHint={emptyHint}
          ariaLabel={`「${subject.name}」的任务`}
        />
      </div>
    </div>
  );
}

interface SpaceTasksProps {
  subject: SpaceSubject;
  /** 详情抽屉里切换所属空间用 */
  subjects: SubjectInfo[];
  onOpenThread: (threadId: string) => void;
}

/** 独立版：自己拉数据并在原地打开任务详情，挂在学习空间页右侧面板「任务」标签 */
export function SpaceTasks({ subject, subjects, onOpenThread }: SpaceTasksProps) {
  const [notice, setNotice] = useState<string | null>(null);
  const agenda = useAgenda(setNotice);
  const { tasks, threads, today, update, create, remove } = agenda;
  const [inspectedId, setInspectedId] = useState<string | null>(null);
  const inspected = inspectedId ? tasks.find((task) => task.id === inspectedId) ?? null : null;

  useEffect(() => {
    if (inspectedId && agenda.status === "ready" && !inspected) setInspectedId(null);
  }, [agenda.status, inspected, inspectedId]);
  useEffect(() => setInspectedId(null), [subject.id]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const subtasks = useMemo(
    () => (inspected ? tasks.filter((task) => task.parentId === inspected.id).sort(compareSiblings) : []),
    [inspected, tasks],
  );
  const parentTitle = inspected?.parentId ? tasks.find((task) => task.id === inspected.parentId)?.title ?? null : null;
  const failure = agenda.error ? describeError(agenda.error) : null;

  if (inspected) {
    return (
      <div className={styles.standalone}>
        <TaskInspector
          key={inspected.id}
          task={inspected}
          parentTitle={parentTitle}
          subtasks={subtasks}
          subjects={subjects}
          onClose={() => setInspectedId(null)}
          onUpdate={update}
          onDelete={async (id) => {
            const ok = await remove(id);
            if (ok) setInspectedId((current) => (current === id ? null : current));
            return ok;
          }}
          onAddSubtask={(parent, title) => create({ title, parentId: parent.id, subjectId: parent.subjectId, source: "manual" })}
          onSelectTask={setInspectedId}
        />
      </div>
    );
  }

  return (
    <div className={styles.standalone}>
      {notice && <p className={styles.notice} role="alert">{notice}</p>}
      {agenda.status === "loading" ? (
        <div className={styles.skeleton} role="status" aria-label="正在加载任务">
          {Array.from({ length: 5 }, (_, index) => <span key={index} style={{ width: `${86 - index * 9}%` }} />)}
        </div>
      ) : agenda.status === "error" ? (
        <div className={styles.state} role="alert">
          <CircleAlert size={18} aria-hidden />
          <p>{failure?.title ?? "任务加载失败"}</p>
          <button type="button" className={styles.openBtn} onClick={() => void agenda.reload()}>
            <RotateCcw size={13} aria-hidden />重新加载
          </button>
        </div>
      ) : (
        <SpaceTaskList
          subject={subject}
          tasks={tasks}
          threads={threads}
          today={today}
          onOpenTask={(task) => setInspectedId(task.id)}
          onOpenThread={(thread) => onOpenThread(thread.threadId)}
          onToggleDone={(task) => void update(task.id, { status: task.status === "done" ? "open" : "done" })}
        />
      )}
    </div>
  );
}

export { taskKey as spaceTaskKey };

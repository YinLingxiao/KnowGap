"use client";

import { useEffect, useMemo, useRef, type KeyboardEvent } from "react";
import { Check, ChevronRight, MessagesSquare, Play, Repeat } from "lucide-react";
import type { AgendaTask, AgendaThread } from "@/lib/agenda/types";
import { cx } from "@/lib/cx";
import {
  deadlineInfo, flattenRows, scheduleLabel, subtaskProgress, taskKey, threadKey,
  type AgendaGroup, type AgendaNode, type FlatRow, type GroupKey, type TaskNode,
} from "./agendaModel";
import styles from "./AgendaList.module.css";

export interface SubjectInfo {
  id: string;
  name: string;
  color: string;
}

interface AgendaListProps {
  groups: AgendaGroup[];
  today: string;
  subjects: Map<string, SubjectInfo>;
  selectedKey: string | null;
  collapsedGroups: ReadonlySet<GroupKey>;
  collapsedParents: ReadonlySet<string>;
  onSelect: (key: string | null) => void;
  onOpenTask: (task: AgendaTask) => void;
  onOpenThread: (thread: AgendaThread) => void;
  onToggleDone: (task: AgendaTask) => void;
  onFocusTask: (task: AgendaTask) => void;
  onFocusThread: (thread: AgendaThread) => void;
  onToggleGroup: (key: GroupKey) => void;
  onToggleParent: (taskId: string) => void;
}

const PRIORITY_CLASS = [styles.p1, styles.p1, styles.p2, styles.p3, styles.p4];

export function AgendaList(props: AgendaListProps) {
  const { groups, collapsedGroups, collapsedParents, selectedKey } = props;
  const listRef = useRef<HTMLDivElement>(null);
  const rows = useMemo(
    () => flattenRows(groups, collapsedGroups, collapsedParents),
    [groups, collapsedGroups, collapsedParents],
  );

  useEffect(() => {
    if (!selectedKey) return;
    const element = listRef.current?.querySelector<HTMLElement>(`[data-row-key="${CSS.escape(selectedKey)}"]`);
    element?.scrollIntoView({ block: "nearest" });
  }, [selectedKey]);

  const selectedRow = rows.find((row) => row.key === selectedKey) ?? null;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    // 焦点在行内按钮上时，空格/回车交给按钮本身
    const onButton = target !== event.currentTarget && target.tagName === "BUTTON";

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!rows.length) return;
      const index = selectedRow ? rows.indexOf(selectedRow) : -1;
      const next = event.key === "ArrowDown" ? Math.min(rows.length - 1, index + 1) : Math.max(0, index < 0 ? 0 : index - 1);
      props.onSelect(rows[next].key);
      return;
    }
    if (!selectedRow || onButton) return;

    const task = taskOf(selectedRow);
    if (event.key === " " && task) {
      event.preventDefault();
      props.onToggleDone(task);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (task) props.onOpenTask(task);
      else if (selectedRow.node.kind === "thread") props.onOpenThread(selectedRow.node.thread);
    } else if (event.key === "ArrowRight" && !selectedRow.child && selectedRow.node.kind !== "thread") {
      if (collapsedParents.has(selectedRow.node.task.id)) props.onToggleParent(selectedRow.node.task.id);
    } else if (event.key === "ArrowLeft" && !selectedRow.child && selectedRow.node.kind !== "thread") {
      if (selectedRow.node.children.length && !collapsedParents.has(selectedRow.node.task.id)) {
        props.onToggleParent(selectedRow.node.task.id);
      }
    }
  };

  return (
    <div
      ref={listRef}
      className={styles.list}
      role="listbox"
      tabIndex={0}
      aria-label="日程列表，上下键选择，空格完成，回车打开详情"
      aria-activedescendant={selectedKey ? `agenda-row-${selectedKey}` : undefined}
      onKeyDown={onKeyDown}
    >
      {groups.map((group) => {
        const collapsed = collapsedGroups.has(group.key);
        return (
          <section key={group.key} className={styles.group} aria-label={group.label}>
            <h2 className={styles.groupHead}>
              <button
                type="button"
                className={cx(styles.groupToggle, group.key === "overdue" && styles.groupOverdue)}
                aria-expanded={!collapsed}
                onClick={() => props.onToggleGroup(group.key)}
              >
                <ChevronRight size={12} className={cx(styles.chev, !collapsed && styles.chevOpen)} aria-hidden />
                <span>{group.label}</span>
                <span className={styles.groupCount}>{group.nodes.length}</span>
              </button>
            </h2>
            {!collapsed && group.nodes.map((node) => (
              <NodeRows key={node.key} node={node} {...props} collapsedParent={node.kind !== "thread" && collapsedParents.has(node.task.id)} />
            ))}
          </section>
        );
      })}
    </div>
  );
}

function taskOf(row: FlatRow): AgendaTask | null {
  if (row.child) return row.child;
  return row.node.kind === "thread" ? null : row.node.task;
}

function NodeRows(props: AgendaListProps & { node: AgendaNode; collapsedParent: boolean }) {
  const { node } = props;
  if (node.kind === "thread") {
    return <ThreadRow {...props} node={node} />;
  }
  return (
    <>
      <TaskRow {...props} node={node} task={node.task} child={false} />
      {!props.collapsedParent && node.children.map((child) => (
        <TaskRow key={child.id} {...props} node={node} task={child} child />
      ))}
    </>
  );
}

function SubjectTag({ info }: { info: SubjectInfo | undefined }) {
  if (!info) return null;
  return (
    <span className={styles.subject} title={`空间：${info.name}`}>
      <span className={styles.subjectDot} style={{ background: info.color }} aria-hidden />
      <span className={styles.subjectName}>{info.name}</span>
    </span>
  );
}

function DeadlineTag({ deadline, today }: { deadline: string | null; today: string }) {
  const info = deadlineInfo(deadline, today);
  if (!info) return null;
  return (
    <span className={cx(styles.deadline, info.urgent && styles.urgent)} title={`截止日 ${deadline}`}>
      截止 · {info.text.replace("截止", "").trim() || info.text}
    </span>
  );
}

function TaskRow(props: AgendaListProps & { node: TaskNode; task: AgendaTask; child: boolean; collapsedParent?: boolean }) {
  const { task, node, child, today } = props;
  const key = taskKey(task.id);
  const done = task.status === "done";
  const review = node.kind === "review" && !child;
  const progress = !child && node.children.length ? subtaskProgress(node.children) : null;
  const schedule = scheduleLabel(task, today);
  const overdueSchedule = Boolean(task.scheduledDate && task.scheduledDate < today && !done);
  const selected = props.selectedKey === key;

  return (
    <div
      id={`agenda-row-${key}`}
      data-row-key={key}
      role="option"
      aria-selected={selected}
      className={cx(styles.row, PRIORITY_CLASS[task.priority], child && styles.child, selected && styles.selected, done && styles.done)}
      onClick={() => props.onSelect(key)}
      onDoubleClick={() => props.onOpenTask(task)}
    >
      <span className={styles.expand}>
        {progress && (
          <button
            type="button"
            className={styles.expandBtn}
            aria-label={props.collapsedParent ? "展开子任务" : "折叠子任务"}
            aria-expanded={!props.collapsedParent}
            onClick={(event) => { event.stopPropagation(); props.onToggleParent(task.id); }}
          >
            <ChevronRight size={13} className={cx(styles.chev, !props.collapsedParent && styles.chevOpen)} aria-hidden />
          </button>
        )}
      </span>

      <button
        type="button"
        role="checkbox"
        aria-checked={done}
        aria-label={done ? `标记「${task.title}」为未完成` : `完成「${task.title}」`}
        className={cx(styles.check, done && styles.checked)}
        onClick={(event) => { event.stopPropagation(); props.onToggleDone(task); }}
      >
        {done && <Check size={11} strokeWidth={3} aria-hidden />}
      </button>

      <button type="button" className={styles.main} tabIndex={-1} onClick={() => { props.onSelect(key); props.onOpenTask(task); }}>
        {review && (
          <span className={cx(styles.badge, styles.badgeReview)} title="艾宾浩斯闪回">
            <Repeat size={11} aria-hidden />
            闪回{task.reviewStep ? ` · 第 ${task.reviewStep} 轮` : ""}
          </span>
        )}
        <span className={styles.title}>{task.title}</span>
        {task.labels.map((label) => <span key={label} className={styles.label}>#{label}</span>)}
      </button>

      <span className={styles.meta}>
        {progress && (
          <span className={styles.progress} title={`子任务 ${progress.done}/${progress.total}`}>
            <span className={styles.bar} aria-hidden>
              <span style={{ width: `${(progress.done / progress.total) * 100}%` }} />
            </span>
            {progress.done}/{progress.total}
          </span>
        )}
        {!child && <SubjectTag info={task.subjectId ? props.subjects.get(task.subjectId) : undefined} />}
        {schedule && (
          <span className={cx(styles.schedule, overdueSchedule && styles.urgent)} title={`计划 ${task.scheduledStartAt ?? task.scheduledDate}`}>
            计划 · {schedule}
          </span>
        )}
        {!done && <DeadlineTag deadline={task.deadlineDate} today={today} />}
      </span>

      {!done ? (
        <button
          type="button"
          className={styles.focusBtn}
          aria-label={`专注：${task.title}`}
          onClick={(event) => { event.stopPropagation(); props.onFocusTask(task); }}
        >
          <Play size={10} fill="currentColor" aria-hidden />
          专注
        </button>
      ) : <span className={styles.focusSlot} />}
    </div>
  );
}

function ThreadRow(props: AgendaListProps & { node: Extract<AgendaNode, { kind: "thread" }> }) {
  const { thread } = props.node;
  const key = threadKey(thread.threadId);
  const selected = props.selectedKey === key;

  return (
    <div
      id={`agenda-row-${key}`}
      data-row-key={key}
      role="option"
      aria-selected={selected}
      className={cx(styles.row, styles.thread, selected && styles.selected)}
      onClick={() => props.onSelect(key)}
      onDoubleClick={() => props.onOpenThread(thread)}
    >
      <span className={styles.expand} />
      <span className={styles.threadIcon} aria-hidden><MessagesSquare size={13} /></span>
      <button type="button" className={styles.main} tabIndex={-1} onClick={() => { props.onSelect(key); props.onOpenThread(thread); }}>
        <span className={cx(styles.badge, styles.badgeThread)} title="空间里进行中的 Thread，点击打开">
          进行中 Thread
        </span>
        <span className={styles.title}>{thread.title}</span>
      </button>
      <span className={styles.meta}>
        <span className={styles.subject} title={`空间：${thread.subjectName}`}>
          <span className={styles.subjectDot} style={{ background: thread.subjectColor }} aria-hidden />
          <span className={styles.subjectName}>{thread.subjectName}</span>
        </span>
        <DeadlineTag deadline={thread.deadlineDate} today={props.today} />
      </span>
      <button
        type="button"
        className={styles.focusBtn}
        aria-label={`专注：${thread.title}`}
        onClick={(event) => { event.stopPropagation(); props.onFocusThread(thread); }}
      >
        <Play size={10} fill="currentColor" aria-hidden />
        专注
      </button>
    </div>
  );
}

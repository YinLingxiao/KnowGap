"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Plus, Repeat, Trash2, X } from "lucide-react";
import type { AgendaTask, TaskPatch, TaskPriority } from "@/lib/agenda/types";
import { cx } from "@/lib/cx";
import { Markdown } from "../chat/Markdown";
import type { SubjectInfo } from "./AgendaList";
import styles from "./TaskInspector.module.css";

interface TaskInspectorProps {
  task: AgendaTask;
  parentTitle: string | null;
  subtasks: AgendaTask[];
  subjects: SubjectInfo[];
  onClose: () => void;
  onUpdate: (id: string, patch: TaskPatch) => Promise<unknown>;
  onDelete: (id: string) => Promise<boolean>;
  onAddSubtask: (parent: AgendaTask, title: string) => Promise<unknown>;
  onSelectTask: (id: string) => void;
}

const PRIORITIES: { value: TaskPriority; label: string; name: string }[] = [
  { value: 1, label: "P1", name: "紧急" },
  { value: 2, label: "P2", name: "高" },
  { value: 3, label: "P3", name: "中" },
  { value: 4, label: "P4", name: "无" },
];
const PRIORITY_CLASS: Record<TaskPriority, string> = { 1: styles.pr1, 2: styles.pr2, 3: styles.pr3, 4: styles.pr4 };
const DURATIONS = [15, 25, 30, 45, 60, 90, 120];

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className={styles.field}>
      <span className={styles.fieldLabel}>{label}</span>
      <div className={styles.fieldBody}>{children}</div>
    </div>
  );
}

export function TaskInspector(props: TaskInspectorProps) {
  const { task, subtasks } = props;
  const [title, setTitle] = useState(task.title);
  const [notes, setNotes] = useState(task.notes);
  const [preview, setPreview] = useState(Boolean(task.notes) && task.source === "review");
  const [labelDraft, setLabelDraft] = useState("");
  const [subtaskDraft, setSubtaskDraft] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [adding, setAdding] = useState(false);
  const panelRef = useRef<HTMLElement>(null);

  useEffect(() => setTitle(task.title), [task.title]);
  useEffect(() => setNotes(task.notes), [task.notes]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const target = event.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) target.blur();
      else props.onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [props]);

  const patch = (value: TaskPatch) => void props.onUpdate(task.id, value);
  const isReview = task.source === "review";
  const done = task.status === "done";

  const commitTitle = () => {
    const next = title.trim().slice(0, 200);
    if (!next) setTitle(task.title);
    else if (next !== task.title) patch({ title: next });
  };

  const commitNotes = () => {
    if (notes !== task.notes) patch({ notes });
  };

  const setScheduledDate = (value: string) => {
    if (!value) {
      patch({ scheduledDate: null, scheduledStartAt: null });
      return;
    }
    const time = task.scheduledStartAt?.slice(11, 16);
    patch({ scheduledDate: value, scheduledStartAt: time ? `${value}T${time}` : null });
  };

  const setStartTime = (value: string) => {
    if (!value) {
      patch({ scheduledStartAt: null });
      return;
    }
    const day = task.scheduledDate;
    if (!day) return;
    patch({ scheduledStartAt: `${day}T${value}` });
  };

  const addLabel = () => {
    const next = labelDraft.trim().replace(/^#/, "").slice(0, 20);
    setLabelDraft("");
    if (!next || task.labels.includes(next) || task.labels.length >= 10) return;
    patch({ labels: [...task.labels, next] });
  };

  const addSubtask = async () => {
    const next = subtaskDraft.trim();
    if (!next || adding) return;
    setAdding(true);
    await props.onAddSubtask(task, next);
    setAdding(false);
    setSubtaskDraft("");
  };

  return (
    <aside ref={panelRef} className={styles.panel} aria-label="任务详情">
      <header className={styles.head}>
        <button
          type="button"
          role="checkbox"
          aria-checked={done}
          aria-label={done ? "标记为未完成" : "标记为完成"}
          className={cx(styles.check, done && styles.checked, PRIORITY_CLASS[task.priority])}
          onClick={() => patch({ status: done ? "open" : "done" })}
        >
          {done && <Check size={12} strokeWidth={3} aria-hidden />}
        </button>
        <span className={styles.headTitle}>
          {isReview ? (
            <span className={styles.reviewTag}>
              <Repeat size={11} aria-hidden />
              闪回{task.reviewStep ? ` · 第 ${task.reviewStep} 轮` : ""}
            </span>
          ) : task.source === "ai_breakdown" ? "AI 拆解的任务" : "任务"}
        </span>
        <button type="button" className={styles.iconBtn} onClick={props.onClose} aria-label="关闭详情" title="关闭（Esc）">
          <X size={15} />
        </button>
      </header>

      <div className={styles.body}>
        {props.parentTitle && (
          <p className={styles.parent}>
            子任务 · 属于
            <button type="button" onClick={() => task.parentId && props.onSelectTask(task.parentId)}>{props.parentTitle}</button>
          </p>
        )}

        <input
          className={styles.titleInput}
          value={title}
          maxLength={200}
          aria-label="任务标题"
          onChange={(event) => setTitle(event.target.value)}
          onBlur={commitTitle}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) event.currentTarget.blur();
          }}
        />

        {isReview && (
          <section className={styles.memory} aria-label="对应的学习记忆">
            <h3>对应的学习记忆</h3>
            {task.notes ? <Markdown text={task.notes} /> : <p className={styles.muted}>这条闪回没有附带记忆说明。</p>}
            <p className={styles.memoryHint}>
              完成本轮后会自动安排下一轮复习（第 2 轮 3 天后，第 3 轮 7 天后）。
            </p>
          </section>
        )}

        <Field label="优先级">
          <div className={styles.segment} role="radiogroup" aria-label="优先级">
            {PRIORITIES.map((item) => (
              <button
                key={item.value}
                type="button"
                role="radio"
                aria-checked={task.priority === item.value}
                title={item.name}
                className={cx(styles.segBtn, PRIORITY_CLASS[item.value], task.priority === item.value && styles.segOn)}
                onClick={() => patch({ priority: item.value })}
              >
                <span className={styles.segDot} aria-hidden />
                {item.label}
              </button>
            ))}
          </div>
        </Field>

        <Field label="所属空间">
          <select
            className={styles.control}
            value={task.subjectId ?? ""}
            aria-label="所属空间"
            onChange={(event) => patch({ subjectId: event.target.value || null })}
          >
            <option value="">未归入空间</option>
            {props.subjects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </Field>

        <Field label="计划">
          <div className={styles.row}>
            <input
              type="date"
              className={styles.control}
              value={task.scheduledDate ?? ""}
              aria-label="计划日期"
              onChange={(event) => setScheduledDate(event.target.value)}
            />
            <input
              type="time"
              className={styles.control}
              value={task.scheduledStartAt?.slice(11, 16) ?? ""}
              disabled={!task.scheduledDate}
              aria-label="开始时间"
              title={task.scheduledDate ? "开始时间" : "先选择计划日期"}
              onChange={(event) => setStartTime(event.target.value)}
            />
          </div>
        </Field>

        <Field label="时长">
          <div className={styles.row}>
            <select
              className={styles.control}
              value={task.durationMinutes !== null && DURATIONS.includes(task.durationMinutes) ? String(task.durationMinutes) : task.durationMinutes === null ? "" : "custom"}
              aria-label="时长"
              onChange={(event) => patch({ durationMinutes: event.target.value && event.target.value !== "custom" ? Number(event.target.value) : null })}
            >
              <option value="">未设置</option>
              {DURATIONS.map((minutes) => <option key={minutes} value={minutes}>{minutes} 分钟</option>)}
              {task.durationMinutes !== null && !DURATIONS.includes(task.durationMinutes) && (
                <option value="custom">{task.durationMinutes} 分钟</option>
              )}
            </select>
          </div>
        </Field>

        <Field label="截止日">
          <div className={styles.row}>
            <input
              type="date"
              className={styles.control}
              value={task.deadlineDate ?? ""}
              aria-label="截止日"
              onChange={(event) => patch({ deadlineDate: event.target.value || null })}
            />
            {task.deadlineDate && (
              <button type="button" className={styles.textBtn} onClick={() => patch({ deadlineDate: null })}>清除</button>
            )}
          </div>
        </Field>

        <Field label="标签">
          <div className={styles.tags}>
            {task.labels.map((label) => (
              <span key={label} className={styles.tag}>
                #{label}
                <button type="button" aria-label={`移除标签 ${label}`} onClick={() => patch({ labels: task.labels.filter((item) => item !== label) })}>
                  <X size={10} />
                </button>
              </span>
            ))}
            {task.labels.length < 10 && (
              <input
                className={styles.tagInput}
                value={labelDraft}
                maxLength={20}
                placeholder="添加标签"
                aria-label="添加标签"
                onChange={(event) => setLabelDraft(event.target.value)}
                onBlur={addLabel}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    addLabel();
                  }
                }}
              />
            )}
          </div>
        </Field>

        {!isReview && (
          <section className={styles.notes} aria-label="备注">
            <div className={styles.notesHead}>
              <h3>备注</h3>
              <div className={styles.segment} role="group" aria-label="备注模式">
                <button type="button" className={cx(styles.segBtn, !preview && styles.segOn)} onClick={() => setPreview(false)}>编辑</button>
                <button type="button" className={cx(styles.segBtn, preview && styles.segOn)} onClick={() => { commitNotes(); setPreview(true); }}>预览</button>
              </div>
            </div>
            {preview ? (
              notes.trim() ? <div className={styles.preview}><Markdown text={notes} /></div> : <p className={styles.muted}>还没有备注。</p>
            ) : (
              <textarea
                className={styles.textarea}
                value={notes}
                rows={5}
                placeholder="支持 Markdown：**加粗**、- 列表、`代码`、$公式$"
                aria-label="备注（Markdown）"
                onChange={(event) => setNotes(event.target.value)}
                onBlur={commitNotes}
              />
            )}
          </section>
        )}

        {!task.parentId && (
          <section className={styles.subtasks} aria-label="子任务">
            <h3>
              子任务
              {subtasks.length > 0 && (
                <span className={styles.count}>{subtasks.filter((item) => item.status === "done").length}/{subtasks.length}</span>
              )}
            </h3>
            <ul>
              {subtasks.map((child) => (
                <li key={child.id} className={cx(styles.sub, child.status === "done" && styles.subDone)}>
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={child.status === "done"}
                    aria-label={`${child.status === "done" ? "取消完成" : "完成"}子任务「${child.title}」`}
                    className={cx(styles.check, styles.pr4, child.status === "done" && styles.checked)}
                    onClick={() => void props.onUpdate(child.id, { status: child.status === "done" ? "open" : "done" })}
                  >
                    {child.status === "done" && <Check size={11} strokeWidth={3} aria-hidden />}
                  </button>
                  <button type="button" className={styles.subTitle} onClick={() => props.onSelectTask(child.id)}>{child.title}</button>
                  <button
                    type="button"
                    className={styles.subDelete}
                    aria-label={`删除子任务「${child.title}」`}
                    onClick={() => void props.onDelete(child.id)}
                  >
                    <X size={13} />
                  </button>
                </li>
              ))}
            </ul>
            <div className={styles.addSub}>
              <Plus size={14} aria-hidden />
              <input
                value={subtaskDraft}
                maxLength={200}
                disabled={adding}
                placeholder="添加子任务，回车确认"
                aria-label="添加子任务"
                onChange={(event) => setSubtaskDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    void addSubtask();
                  }
                }}
              />
            </div>
          </section>
        )}
      </div>

      <footer className={styles.foot}>
        {confirmDelete ? (
          <div className={styles.confirm} role="group" aria-label="确认删除">
            <span>
              {isReview ? "删除后不再生成后续轮次。" : subtasks.length ? `连同 ${subtasks.length} 个子任务一起删除？` : "确认删除这个任务？"}
            </span>
            <button type="button" onClick={() => setConfirmDelete(false)}>取消</button>
            <button type="button" className={styles.danger} onClick={() => void props.onDelete(task.id)}>删除</button>
          </div>
        ) : (
          <button type="button" className={styles.deleteBtn} onClick={() => setConfirmDelete(true)}>
            <Trash2 size={13} aria-hidden />
            删除任务
          </button>
        )}
      </footer>
    </aside>
  );
}

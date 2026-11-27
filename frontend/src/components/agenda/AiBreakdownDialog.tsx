"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Plus, Sparkles, Trash2, X } from "lucide-react";
import { useI18n } from "@/components/LanguageProvider";
import { agendaApi } from "@/lib/agenda/api";
import { AGENDA_CHANGED_EVENT, type AgendaTask, type TaskDraft, type TaskInput, type TaskPriority } from "@/lib/agenda/types";
import styles from "./AiBreakdownDialog.module.css";

export interface AiBreakdownDialogProps {
  open: boolean;
  subjects: { id: string; name: string; color: string }[];
  defaultSubjectId?: string | null;
  initialGoal?: string;
  onClose: () => void;
  onCreated: (created: { parent: AgendaTask | null; children: AgendaTask[] }) => void;
}

type DraftRow = { key: string; value: TaskDraft };
function localToday() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function row(value: TaskDraft): DraftRow { return { key: crypto.randomUUID(), value }; }

function DraftEditor({ draft, label, onChange, onDelete }: { draft: TaskDraft; label: string; onChange: (value: TaskDraft) => void; onDelete: () => void }) {
  const { tx } = useI18n();
  function patch(value: Partial<TaskDraft>) { onChange({ ...draft, ...value }); }
  return <fieldset className={styles.draftRow}>
    <legend>{label}</legend>
    <div className={styles.titleRow}>
      <input aria-label={tx("{label}标题", { label })} required maxLength={200} value={draft.title} placeholder={tx("任务标题")} onChange={event => patch({ title: event.target.value })} />
      <button type="button" className={styles.iconButton} aria-label={tx("删除{label}", { label })} onClick={onDelete}><Trash2 size={15} /></button>
    </div>
    <div className={styles.fields}>
      <label>{tx("计划日期")}<input aria-label={tx("{label}日期", { label })} type="date" value={draft.scheduledDate ?? ""} onChange={event => {
        const day = event.target.value || null;
        patch({ scheduledDate: day, scheduledStartAt: day && draft.scheduledStartAt ? `${day}T${draft.scheduledStartAt.slice(11, 16)}` : null });
      }} /></label>
      <label>{tx("开始时间")}<input aria-label={tx("{label}开始时间", { label })} type="time" step={900} value={draft.scheduledStartAt?.slice(11, 16) ?? ""} onChange={event => {
        const day = draft.scheduledDate || localToday();
        patch({ scheduledDate: day, scheduledStartAt: event.target.value ? `${day}T${event.target.value}` : null });
      }} /></label>
      <label>{tx("时长 / 分钟")}<input aria-label={tx("{label}时长", { label })} type="number" min={5} max={720} step={1} placeholder="30" value={draft.durationMinutes ?? ""} onChange={event => patch({ durationMinutes: event.target.value ? Number(event.target.value) : null })} /></label>
      <label>{tx("优先级")}<select aria-label={tx("{label}优先级", { label })} value={draft.priority ?? 4} onChange={event => patch({ priority: Number(event.target.value) as TaskPriority })}>
        <option value={1}>{tx("P1 · 最高")}</option><option value={2}>{tx("P2 · 高")}</option><option value={3}>{tx("P3 · 中")}</option><option value={4}>{tx("P4 · 普通")}</option>
      </select></label>
    </div>
  </fieldset>;
}

export default function AiBreakdownDialog({ open, subjects, defaultSubjectId, initialGoal = "", onClose, onCreated }: AiBreakdownDialogProps) {
  const { tx } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const requestId = useRef(0);
  const busyRef = useRef(false);
  const [goal, setGoal] = useState(initialGoal);
  const [subjectId, setSubjectId] = useState(defaultSubjectId ?? "");
  const [deadline, setDeadline] = useState("");
  const [stage, setStage] = useState<"input" | "generating" | "preview">("input");
  const [parent, setParent] = useState<DraftRow | null>(null);
  const [children, setChildren] = useState<DraftRow[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  // Opening takes a snapshot of defaults; changes to subjects while editing never erase a draft.
  const defaults = useRef({ subjects, defaultSubjectId, initialGoal });
  defaults.current = { subjects, defaultSubjectId, initialGoal };
  useEffect(() => {
    if (open) {
      const value = defaults.current;
      setGoal(value.initialGoal);
      setSubjectId(value.defaultSubjectId ?? "");
      setDeadline("");
      setStage("input"); setParent(null); setChildren([]); setError(""); setSaving(false); busyRef.current = false;
      dialogRef.current?.showModal();
    } else dialogRef.current?.close();
    return () => { requestId.current += 1; };
  }, [open]);

  function close() {
    if (busyRef.current) return;
    requestId.current += 1;
    dialogRef.current?.close();
    onClose();
  }
  function cancelGeneration() { requestId.current += 1; setStage("input"); setError(""); }
  function manual() {
    requestId.current += 1;
    setParent(row({ title: goal.trim(), deadlineDate: deadline || null, priority: 4 }));
    setChildren([row({ title: "", scheduledDate: localToday(), durationMinutes: 30, priority: 4 })]);
    setStage("preview"); setError("");
  }
  async function generate() {
    const id = ++requestId.current;
    setError(""); setStage("generating");
    try {
      const draft = await agendaApi.breakdown({ goal: goal.trim(), subjectId: subjectId || null, deadlineDate: deadline || null, today: localToday() });
      if (id !== requestId.current) return;
      setParent(row(draft.parent)); setChildren(draft.children.map(row)); setStage("preview");
    } catch (cause) {
      if (id !== requestId.current) return;
      setError(cause instanceof Error ? cause.message : tx("生成失败，请稍后重试或手动添加。")); setStage("input");
    }
  }
  async function save() {
    if (busyRef.current) return;
    const drafts = [...(parent ? [parent] : []), ...children];
    if (!drafts.length) { setError(tx("请至少保留一条任务。")); return; }
    if (drafts.some(item => !item.value.title.trim())) { setError(tx("请填写每条任务的标题。")); return; }
    if (drafts.some(item => item.value.durationMinutes != null && (!Number.isInteger(item.value.durationMinutes) || item.value.durationMinutes < 5 || item.value.durationMinutes > 720))) {
      setError(tx("任务时长需为 5–720 分钟的整数。")); return;
    }
    const input = ({ value }: DraftRow): TaskInput => ({ ...value, title: value.title.trim(), subjectId: subjectId || null, source: "ai_breakdown" });
    busyRef.current = true; setSaving(true); setError("");
    try {
      const created = await agendaApi.createBatch(parent ? input(parent) : null, children.map(input));
      window.dispatchEvent(new Event(AGENDA_CHANGED_EVENT));
      busyRef.current = false; setSaving(false);
      dialogRef.current?.close();
      onCreated(created);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : tx("入列失败，草稿已保留，请重试。"));
      busyRef.current = false; setSaving(false);
    }
  }

  return <dialog ref={dialogRef} className={styles.dialog} aria-labelledby="agenda-breakdown-title" onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === event.currentTarget && event.clientX !== 0 && event.clientY !== 0) {
    const rect = event.currentTarget.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close();
  } }}>
    <header className={styles.header}>
      <Sparkles size={18} className={styles.accent} />
      <h2 id="agenda-breakdown-title">{stage === "preview" ? tx("检查你的学习计划") : tx("把大目标，变成下一步")}</h2>
      <button type="button" className={styles.iconButton} aria-label={tx("关闭拆解")} disabled={saving} onClick={close}><X size={18} /></button>
    </header>
    <form className={styles.form} onSubmit={event => { event.preventDefault(); if (stage === "preview") void save(); else if (stage === "input") void generate(); }}>
      <div className={styles.body}>
        <p className={styles.description}>{stage === "preview" ? tx("调整标题和排期，确认后才会写入日程。清空开始时间即为全天任务。") : tx("描述你想完成的事，AI 会拆成可执行的小任务。生成的草稿不会自动入库。")}</p>
        {error && <div className={styles.error} role="alert">{error}</div>}
        {stage !== "preview" ? <fieldset className={styles.inputGroup} disabled={stage === "generating"}>
          <label>{tx("学习目标")}<textarea autoFocus required maxLength={4000} rows={4} placeholder={tx("例如：下周五前掌握电路原理的戴维南定理，完成一套练习题。")} value={goal} onChange={event => setGoal(event.target.value)} /></label>
          <div className={styles.inputOptions}>
            <label>{tx("关联空间")} <span>{tx("可选")}</span><select value={subjectId} onChange={event => setSubjectId(event.target.value)}>
              <option value="">{tx("不关联空间")}</option>{subjects.map(subject => <option key={subject.id} value={subject.id}>{subject.name}</option>)}
            </select></label>
            <label>{tx("截止日期")} <span>{tx("可选")}</span><input type="date" min={localToday()} value={deadline} onChange={event => setDeadline(event.target.value)} /></label>
          </div>
        </fieldset> : <fieldset className={styles.preview} disabled={saving}>
          {parent && <DraftEditor label={tx("父任务")} draft={parent.value} onChange={value => setParent({ ...parent, value })} onDelete={() => setParent(null)} />}
          {children.map((child, index) => <DraftEditor key={child.key} label={tx("子任务 {index}", { index: index + 1 })} draft={child.value} onChange={value => setChildren(current => current.map(item => item.key === child.key ? { ...item, value } : item))} onDelete={() => setChildren(current => current.filter(item => item.key !== child.key))} />)}
          <button type="button" className={styles.add} disabled={children.length >= 30} onClick={() => setChildren(current => [...current, row({ title: "", scheduledDate: localToday(), durationMinutes: 30, priority: 4 })])}><Plus size={15} />{tx("新增一条 {count}/30", { count: children.length })}</button>
        </fieldset>}
        {stage === "generating" && <p className={styles.loading} role="status"><span />{tx("正在拆解目标与安排时间…")}</p>}
      </div>
      <footer className={styles.footer}>
        {stage === "generating" ? <><span className={styles.description}>{tx("取消后不会保存生成结果")}</span><button key="cancel-generation" type="button" onClick={event => { event.preventDefault(); cancelGeneration(); }}>{tx("取消生成")}</button></> : stage === "preview" ? <>
          <button type="button" disabled={saving} onClick={() => { setStage("input"); setError(""); }}><ArrowLeft size={14} />{tx("返回输入")}</button>
          <button type="submit" className={styles.primary} disabled={saving || (!parent && children.length === 0)}>{saving ? tx("正在入列…") : tx("确认入列")}</button>
        </> : <><button type="button" onClick={manual} disabled={!goal.trim()}>{tx("手动添加")}</button><button type="submit" className={styles.primary} disabled={!goal.trim()}><Sparkles size={14} />{tx("生成拆解")}</button></>}
      </footer>
    </form>
  </dialog>;
}

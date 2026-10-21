"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Bell, CalendarDays, Check, ChevronDown, Flag, Folder, Inbox, Loader, Plus, Sparkles, Tag, X } from "lucide-react";
import { agendaApi } from "@/lib/agenda/api";
import { formatYmd, parseQuickAdd, type QuickAddFields, type QuickAddToken } from "@/lib/agenda/quickAdd";
import { AGENDA_CHANGED_EVENT, COMPOSE_TASK_EVENT, type ComposeTaskDetail, type TaskPriority } from "@/lib/agenda/types";
import AiBreakdownDialog from "./AiBreakdownDialog";
import styles from "./TaskComposer.module.css";

type Subject = { id: string; name: string; color: string; deadline: string | null };
type Field = "date" | "deadline" | "priority" | "reminder" | "labels" | "subject";
const REMINDERS = [0, 5, 10, 15, 30, 60, 120, 1440];
const reminderLabel = (value: number) => value === 0 ? "准时" : value === 1440 ? "1 天前" : `${value} 分钟前`;
const dateLabel = (value: string) => `${Number(value.slice(5, 7))}月${Number(value.slice(8, 10))}日`;
// 空间色只映射到主题令牌，不把后端任意色值（含紫色）写进样式。
function subjectTone(color: string) {
  const hex = /^#([0-9a-f]{6})$/i.exec(color)?.[1];
  if (!hex) return "var(--accent)";
  const [r, g, b] = [0, 2, 4].map(offset => parseInt(hex.slice(offset, offset + 2), 16));
  if (g > r && g > b) return "var(--green)";
  if (r > b * 1.3 && g > b * 1.3) return "var(--orange)";
  if (r > g * 1.5 && r > b * 1.5) return "var(--red)";
  return "var(--accent)";
}
const tokenField = (token: QuickAddToken): Field => token.field ? "reminder" : ({
  date: "date", time: "date", duration: "date", deadline: "deadline", priority: "priority", label: "labels", subject: "subject",
} as const)[token.kind];

export function TaskComposer({ subjects }: { subjects: Subject[] }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const mirror = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const submitting = useRef(false);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [notes, setNotes] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [ignored, setIgnored] = useState<string[]>([]);
  const [manual, setManual] = useState<Partial<QuickAddFields>>({});
  const [prioritySet, setPrioritySet] = useState(false);
  const [defaults, setDefaults] = useState<ComposeTaskDetail>({});
  const [panel, setPanel] = useState<Field | null>(null);
  const [labelDraft, setLabelDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmClose, setConfirmClose] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [toast, setToast] = useState("");
  const parsed = useMemo(() => parseQuickAdd(text, new Date(), subjects, ignored), [text, subjects, ignored]);
  const fields = { ...parsed.fields,
    scheduledDate: parsed.tokens.some(token => token.kind === "date")
      ? parsed.fields.scheduledDate : defaults.scheduledDate ?? parsed.fields.scheduledDate,
    subjectId: parsed.fields.subjectId ?? defaults.subjectId ?? null,
    ...manual,
  };
  // 日期和时钟独立覆盖，再合成一致的本地时间，避免手动改日期后仍发送旧日期。
  const clock = fields.scheduledStartAt?.slice(11, 16);
  fields.scheduledStartAt = fields.scheduledDate && clock ? `${fields.scheduledDate}T${clock}` : null;
  const subject = subjects.find(item => item.id === fields.subjectId);
  const validTitle = parsed.title.length > 0 && parsed.title.length <= 200;

  useEffect(() => {
    const show = (event: Event) => {
      if (dialog.current?.open || submitting.current) return;
      const detail = (event as CustomEvent<ComposeTaskDetail>).detail ?? {};
      trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setDefaults(detail); setText(detail.title ?? ""); setNotes(""); setExpanded(false);
      setManual({}); setPrioritySet(false); setIgnored([]); setPanel(null); setLabelDraft(""); setError(""); setConfirmClose(false); setOpen(true);
    };
    const shortcut = (event: KeyboardEvent) => {
      const target = event.target;
      if (event.defaultPrevented || event.isComposing || event.repeat || event.ctrlKey || event.metaKey || event.altKey ||
        event.key.toLowerCase() !== "q" || document.querySelector("dialog[open]")) return;
      if (target instanceof HTMLElement && (target.isContentEditable || target.closest("input,textarea,select,[role='textbox']"))) return;
      event.preventDefault(); show(new CustomEvent(COMPOSE_TASK_EVENT));
    };
    window.addEventListener(COMPOSE_TASK_EVENT, show);
    window.addEventListener("keydown", shortcut);
    return () => { window.removeEventListener(COMPOSE_TASK_EVENT, show); window.removeEventListener("keydown", shortcut); };
  }, []);

  useEffect(() => {
    if (open) { dialog.current?.showModal(); input.current?.focus(); }
    else { dialog.current?.close(); trigger.current?.focus(); }
  }, [open]);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 6000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  function close() {
    if (submitting.current) return;
    if (text.trim() || notes.trim() || Object.keys(manual).length) { setConfirmClose(true); setPanel(null); }
    else setOpen(false);
  }
  function patch(value: Partial<QuickAddFields>) { setManual(previous => ({ ...previous, ...value })); setConfirmClose(false); }
  function cancelToken(token: QuickAddToken) { setIgnored(previous => [...previous, token.key]); input.current?.focus(); }
  function clear(field: Field) {
    if (field === "priority") setPrioritySet(false);
    const values: Record<Field, Partial<QuickAddFields>> = {
      date: { scheduledDate: null, scheduledStartAt: null, durationMinutes: null, reminderMinutes: null },
      deadline: { deadlineDate: null }, priority: { priority: 4 }, reminder: { reminderMinutes: null },
      labels: { labels: [] }, subject: { subjectId: null },
    };
    patch(values[field]);
    setIgnored(previous => [...previous, ...parsed.tokens.filter(token => tokenField(token) === field).map(token => token.key)]);
    setPanel(null);
  }
  function addLabel() {
    const next = labelDraft.trim().replace(/^#/, "");
    if (!next) return;
    if (next.length > 20 || fields.labels.length >= 10) { setError("标签最多 10 个，每个不超过 20 字。"); return; }
    patch({ labels: [...new Set([...fields.labels, next])] }); setLabelDraft(""); setError("");
  }
  async function submit(keepOpen = false) {
    if (submitting.current || !validTitle) return;
    if (fields.reminderMinutes != null && !fields.scheduledStartAt) {
      setError("请先设置开始时间，或清除提醒后添加任务。"); setPanel("date"); return;
    }
    if (fields.durationMinutes != null && (!Number.isInteger(fields.durationMinutes) || fields.durationMinutes < 5 || fields.durationMinutes > 720)) {
      setError("时长需为 5–720 分钟的整数。"); setPanel("date"); return;
    }
    if (labelDraft.trim()) { setError("请先按标签旁的 + 保存新标签。"); setPanel("labels"); return; }
    submitting.current = true; setBusy(true); setError("");
    try {
      const created = await agendaApi.createTask({
        title: parsed.title, notes, source: "manual", parentId: defaults.parentId ?? undefined,
        priority: fields.priority, labels: fields.labels, subjectId: fields.subjectId,
        scheduledDate: fields.scheduledDate, scheduledStartAt: fields.scheduledStartAt,
        durationMinutes: fields.durationMinutes, deadlineDate: fields.deadlineDate,
        // 不设置提醒时不发字段，兼容尚未集成提醒支持的后端。
        ...(fields.scheduledStartAt && fields.reminderMinutes != null ? { reminderMinutes: fields.reminderMinutes } : {}),
      });
      window.dispatchEvent(new Event(AGENDA_CHANGED_EVENT));
      setToast(`已添加到${created.scheduledDate ? ` ${dateLabel(created.scheduledDate)}` : subject?.name ? `「${subject.name}」` : "收件箱"}`);
      if (keepOpen) {
        setText(""); setNotes(""); setIgnored([]); setExpanded(false); setPanel(null); setLabelDraft("");
        setDefaults({ scheduledDate: fields.scheduledDate, subjectId: fields.subjectId });
        setManual({}); setPrioritySet(false); setConfirmClose(false);
        requestAnimationFrame(() => { input.current?.focus(); if (mirror.current) mirror.current.scrollLeft = 0; });
      } else setOpen(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "添加失败，请稍后重试。输入内容已保留。"); }
    finally { submitting.current = false; setBusy(false); }
  }
  function fieldButton(field: Field, label: string, icon: ReactNode, active: boolean, disabled = false) {
    return <div className={styles.fieldButton} data-active={active} key={field} title={disabled ? "先在日期中设置开始时间，才能添加提醒" : undefined}>
      <button type="button" disabled={disabled || busy} aria-expanded={panel === field} aria-controls={`task-composer-${field}`} onClick={() => setPanel(panel === field ? null : field)}>
        {icon}<span>{label}</span>{!active && <ChevronDown size={11} aria-hidden />}
      </button>
      {active && <button type="button" disabled={busy} className={styles.clear} aria-label={`清除${({ date: "日期", deadline: "截止期限", priority: "优先级", reminder: "提醒", labels: "标签", subject: "学习空间" })[field]}`} onClick={() => clear(field)}><X size={12} /></button>}
    </div>;
  }
  const pieces: ReactNode[] = [];
  let cursor = 0;
  for (const token of parsed.tokens) {
    pieces.push(text.slice(cursor, token.start));
    pieces.push(<mark key={`${token.key}:${token.start}`}>{token.raw}</mark>);
    cursor = token.end;
  }
  pieces.push(text.slice(cursor));

  return <>
    <dialog ref={dialog} className={styles.dialog} aria-labelledby="task-composer-heading" onCancel={event => { event.preventDefault(); close(); }} onClick={event => {
      if (event.target === dialog.current) {
        const rect = dialog.current.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close();
      }
    }} onKeyDown={event => {
      // 对话框内快捷键不泄漏给 ChatApp；焦点只在可见、可用控件间循环。
      event.stopPropagation();
      if (event.nativeEvent.isComposing) return;
      if (event.key === "Tab") {
        const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex='0']"))
          .filter(element => element.getClientRects().length > 0);
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (!first || (event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last)) {
          event.preventDefault();
          (event.shiftKey ? last : first)?.focus();
        }
      }
      if (event.key === "Escape") { event.preventDefault(); if (panel) setPanel(null); else if (confirmClose) setConfirmClose(false); else close(); }
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey || event.target instanceof HTMLInputElement)) {
        event.preventDefault(); if (!confirmClose) void submit(event.ctrlKey || event.metaKey);
      }
    }}>
      <div className={styles.header}><h2 id="task-composer-heading">添加任务</h2><button type="button" disabled={busy} aria-label="关闭添加任务" onClick={close}><X size={16} /></button></div>
      <fieldset className={styles.body} disabled={busy}>
        <div className={styles.titleField}>
          <div className={styles.mirror} ref={mirror} aria-hidden>{pieces}</div>
          <input ref={input} className={styles.title} aria-label="任务名称" placeholder="任务名称，如：明天下午3点 复习电路 p1" value={text} maxLength={500}
            onChange={event => { setText(event.target.value); setConfirmClose(false); if (!event.target.value) setIgnored([]); }}
            onScroll={event => { if (mirror.current) mirror.current.scrollLeft = event.currentTarget.scrollLeft; }}
            onClick={event => {
              const position = event.currentTarget.selectionStart ?? -1;
              if (event.currentTarget.selectionStart !== event.currentTarget.selectionEnd) return;
              const token = parsed.tokens.find(item => position > item.start && position <= item.end);
              if (token) cancelToken(token);
            }} />
        </div>
        {expanded ? <label className={styles.notes}>描述 · 支持 Markdown<textarea autoFocus rows={3} aria-label="任务描述（Markdown）" value={notes} onChange={event => setNotes(event.target.value)} placeholder="添加笔记、链接或检查清单…" /></label>
          : <button className={styles.expand} type="button" onClick={() => setExpanded(true)}><Plus size={13} aria-hidden />添加描述</button>}
        <div className={styles.fields} aria-label="任务字段">
          {fieldButton("date", fields.scheduledDate ? `${dateLabel(fields.scheduledDate)}${clock ? ` ${clock}` : ""}${fields.durationMinutes ? ` · ${fields.durationMinutes}分钟` : ""}` : fields.durationMinutes ? `${fields.durationMinutes}分钟` : "日期", <CalendarDays size={14} />, !!fields.scheduledDate || fields.durationMinutes != null)}
          {fieldButton("deadline", fields.deadlineDate ? `截止 ${dateLabel(fields.deadlineDate)}` : "截止期限", <Flag size={14} />, !!fields.deadlineDate)}
          {fieldButton("priority", `P${fields.priority}`, <Flag size={14} />, fields.priority !== 4 || prioritySet || parsed.tokens.some(token => token.kind === "priority"))}
          {fieldButton("reminder", fields.reminderMinutes != null ? reminderLabel(fields.reminderMinutes) : "提醒", <Bell size={14} />, fields.reminderMinutes != null, !fields.scheduledStartAt)}
          {fieldButton("labels", fields.labels.length ? fields.labels.map(label => `#${label}`).join(" ") : "标签", <Tag size={14} />, fields.labels.length > 0)}
          {fieldButton("subject", subject?.name ?? "学习空间", <Folder size={14} />, !!subject)}
        </div>
        {!fields.scheduledStartAt && <p className={styles.hint}>设置开始时间后可添加提醒</p>}
        {panel && <div className={styles.panel} id={`task-composer-${panel}`} role="group" aria-label={`${({ date: "日期和时间", deadline: "截止期限", priority: "优先级", reminder: "提醒", labels: "标签", subject: "学习空间" })[panel]}设置`}>
          <div className={styles.panelHead}><span>{({ date: "计划日期与时间", deadline: "截止期限", priority: "优先级", reminder: "开始前提醒", labels: "标签", subject: "学习空间" })[panel]}</span><button type="button" aria-label="收起字段设置" onClick={() => setPanel(null)}><X size={14} /></button></div>
          {panel === "date" && <>
            <div className={styles.presets}>{["今天", "明天", "本周末", "下周一"].map(day => <button key={day} type="button" onClick={() => patch({ scheduledDate: parseQuickAdd(day, new Date()).fields.scheduledDate })}>{day}</button>)}</div>
            <div className={styles.dateFields}>
              <label>选择日期<input type="date" value={fields.scheduledDate ?? ""} onChange={event => patch({ scheduledDate: event.target.value || null, ...(!event.target.value ? { scheduledStartAt: null, reminderMinutes: null } : {}) })} /></label>
              <label>开始时间 · 可选<input type="time" value={clock ?? ""} onChange={event => { const day = fields.scheduledDate ?? formatYmd(new Date()); patch({ scheduledDate: day, scheduledStartAt: event.target.value ? `${day}T${event.target.value}` : null, ...(!event.target.value ? { reminderMinutes: null } : {}) }); }} /></label>
              <label>时长 / 分钟<input type="number" min={5} max={720} step={1} placeholder="可选" value={fields.durationMinutes ?? ""} onChange={event => patch({ durationMinutes: event.target.value ? Number(event.target.value) : null })} /></label>
            </div>
          </>}
          {panel === "deadline" && <label className={styles.notes}>与计划日期独立<input type="date" aria-label="截止期限" value={fields.deadlineDate ?? ""} onChange={event => patch({ deadlineDate: event.target.value || null })} /></label>}
          {panel === "priority" && <div className={styles.options}>{([1, 2, 3, 4] as TaskPriority[]).map(value => <button type="button" key={value} aria-pressed={fields.priority === value} onClick={() => { patch({ priority: value }); setPrioritySet(true); setPanel(null); }}>P{value} · {(["最高", "高", "中", "普通"])[value - 1]}{fields.priority === value && <Check size={14} />}</button>)}</div>}
          {panel === "reminder" && <div className={styles.options}>{REMINDERS.map(value => <button type="button" key={value} disabled={!fields.scheduledStartAt} aria-pressed={fields.reminderMinutes === value} onClick={() => { patch({ reminderMinutes: value }); setPanel(null); }}>{reminderLabel(value)}{fields.reminderMinutes === value && <Check size={14} />}</button>)}</div>}
          {panel === "labels" && <>
            <div className={styles.labelEntry}><input aria-label="新标签" placeholder="输入新标签" maxLength={20} value={labelDraft} onChange={event => setLabelDraft(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.ctrlKey && !event.metaKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); addLabel(); } }} /><button type="button" aria-label="保存标签" onClick={addLabel}><Plus size={16} /></button></div>
            <div className={styles.presets}>{fields.labels.map(label => <button type="button" key={label} aria-label={`移除标签 ${label}`} onClick={() => patch({ labels: fields.labels.filter(item => item !== label) })}>#{label}<X size={12} /></button>)}</div>
          </>}
          {panel === "subject" && <div className={styles.options}>
            <button type="button" aria-pressed={!fields.subjectId} onClick={() => { patch({ subjectId: null }); setPanel(null); }}><Inbox size={14} />收件箱</button>
            {subjects.map(item => <button type="button" key={item.id} aria-pressed={fields.subjectId === item.id} onClick={() => { patch({ subjectId: item.id }); setPanel(null); }}><span className={styles.dot} style={{ background: subjectTone(item.color) }} aria-hidden />{item.name}{fields.subjectId === item.id && <Check size={14} />}</button>)}
            {!subjects.length && <p className={styles.hint}>暂无学习空间，任务将放入收件箱。</p>}
          </div>}
        </div>}
        {parsed.tokens.length > 0 && <div className={styles.recognized} aria-label="已识别的片段，点击取消识别"><span>已识别</span>{parsed.tokens.map(token => <button type="button" key={`${token.key}:${token.start}`} title={`取消识别「${token.raw}」，文字保留在标题中`} onClick={() => cancelToken(token)}>{token.raw}<X size={10} /></button>)}</div>}
        {text && <p className={styles.hint}>将添加：{parsed.title || "请补充任务名称"}{parsed.title.length > 200 ? "（任务名称最多 200 字）" : ""}</p>}
        <button type="button" className={styles.ai} disabled={!validTitle} onClick={() => setAiOpen(true)}><Sparkles size={14} aria-hidden />让 AI 拆解</button>
      </fieldset>
      {error && <p className={styles.error} role="alert">{error}</p>}
      {open && toast && <div className={styles.inlineSuccess} role="status"><Check size={14} /><span>{toast}</span><button type="button" onClick={() => { window.dispatchEvent(new Event("knowgap:open-agenda")); setToast(""); close(); }}>查看日程</button></div>}
      {confirmClose && <div className={styles.confirm} role="alert"><span>放弃尚未添加的任务？</span><button type="button" onClick={() => { setConfirmClose(false); input.current?.focus(); }}>继续编辑</button><button type="button" onClick={() => setOpen(false)}>放弃</button></div>}
      <footer className={styles.footer}>
        <span className={styles.destination}>{subject ? <><span className={styles.dot} style={{ background: subjectTone(subject.color) }} />{subject.name}</> : <><Inbox size={14} />收件箱</>}</span>
        <button type="button" disabled={busy} className={styles.cancel} onClick={close}>取消</button>
        <button type="button" className={styles.submit} disabled={busy || !validTitle || confirmClose} onClick={() => void submit()}>{busy ? <Loader size={14} className={styles.spin} /> : <Plus size={14} />}添加任务</button>
      </footer>
      <p className={styles.shortcuts}>Enter 添加 · Ctrl / ⌘ + Enter 连续添加 · Esc 关闭</p>
    </dialog>
    <AiBreakdownDialog open={aiOpen} subjects={subjects} initialGoal={parsed.title} defaultSubjectId={fields.subjectId} onClose={() => { setAiOpen(false); input.current?.focus(); }} onCreated={() => { setAiOpen(false); setOpen(false); setToast("已添加 AI 拆解任务"); }} />
    {!open && toast && <div className={styles.toast} role="status"><Check size={16} /><span>{toast}</span><button type="button" onClick={() => { window.dispatchEvent(new Event("knowgap:open-agenda")); setToast(""); }}>查看日程</button><button type="button" aria-label="关闭添加成功提示" onClick={() => setToast("")}><X size={14} /></button></div>}
  </>;
}

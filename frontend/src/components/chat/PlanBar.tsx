"use client";

import { useCallback, useEffect, useId, useReducer, useRef, useState, type KeyboardEvent } from "react";
import {
  CalendarClock, Check, ChevronDown, Ellipsis, GitBranch, ListChecks, MessageCircleQuestion, Minus,
  NotebookPen, Pencil, Plus, SkipForward, Undo2, X,
} from "lucide-react";
import { toApiError } from "@/lib/api/errors";
import { chatApi } from "@/lib/chat/api";
import {
  PLAN_EVENT, planApi, type LearningPlan, type PlanEventDetail, type PlanStep, type PlanStepStatus,
} from "@/lib/chat/plan";
import { cx } from "@/lib/cx";
import {
  acceptPlanEvent, AGENDA_PROMPT, applyStepPatch, changedSteps, currentLabel, currentStep, dismissKey, QUIZ_PROMPT,
  progressOf, summaryMarkdown, summaryTitle,
} from "./PlanBarModel";
import { SEND_TO_COMPOSER_EVENT, type ComposerTextDetail } from "./SelectionToolbar";
import styles from "./PlanBar.module.css";

const SAVE_TO_PAGE_EVENT = "knowgap:save-to-page";
const TITLE_MAX = 60;

const STATUS_LABEL: Record<PlanStepStatus, string> = {
  pending: "待开始", in_progress: "进行中", awaiting_learner: "等你回答", done: "已完成", skipped: "已跳过",
};

interface PlanBarProps {
  conversationId?: string | null;
  /** 输入框正忙（生成中）时，小结卡片里需要发送消息的动作暂时不可用 */
  busy?: boolean;
  /** 当前对话是否属于学习空间；不传时由 PlanBar 自己查询对话所属的学习空间 */
  canSaveToPage?: boolean;
}

export function PlanBar({ conversationId, busy, canSaveToPage }: PlanBarProps) {
  if (!conversationId) return null;
  return <PlanBarInner key={conversationId} conversationId={conversationId} busy={busy} canSaveToPage={canSaveToPage} />;
}

function readDismissed(key: string): boolean {
  try { return localStorage.getItem(key) === "1"; } catch { return false; }
}

function StatusIcon({ status, fresh }: { status: PlanStepStatus; fresh: boolean }) {
  return (
    <span className={styles.iconSlot}>
      {status === "pending" && <span className={cx(styles.ico, styles.icoPending)} aria-hidden />}
      {status === "in_progress" && <span className={cx(styles.ico, styles.icoActive)} aria-hidden />}
      {status === "awaiting_learner" && (
        <MessageCircleQuestion size={15} className={cx(styles.icoAwait, fresh && styles.pop)} aria-hidden />
      )}
      {status === "done" && (
        <span className={cx(styles.ico, styles.icoDone, fresh && styles.pop)} aria-hidden>
          <Check size={10} strokeWidth={3} />
        </span>
      )}
      {status === "skipped" && <Minus size={13} className={styles.icoSkipped} aria-hidden />}
      <span className="sr-only">{STATUS_LABEL[status]}：</span>
    </span>
  );
}

interface StepRowProps {
  step: PlanStep;
  fresh: boolean;
  editing: boolean;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onRename: (title: string) => void;
  onStatus: (status: "done" | "skipped" | "pending") => void;
}

function StepRow({ step, fresh, editing, onStartEdit, onCancelEdit, onRename, onStatus }: StepRowProps) {
  const [draft, setDraft] = useState(step.title);
  const settled = useRef(false);
  const finished = step.status === "done" || step.status === "skipped";

  useEffect(() => {
    if (editing) {
      settled.current = false;
      setDraft(step.title);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在进入编辑态时取一次标题
  }, [editing]);

  const commit = () => {
    if (settled.current) return;
    settled.current = true;
    onRename(draft);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      commit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      settled.current = true;
      onCancelEdit();
    }
  };

  return (
    <li
      className={cx(styles.row, fresh && styles.rowFresh, step.status === "awaiting_learner" && styles.rowAwait)}
      data-status={step.status}
    >
      <StatusIcon status={step.status} fresh={fresh} />
      <div className={styles.body}>
        {editing ? (
          <input
            className={styles.edit}
            value={draft}
            maxLength={TITLE_MAX}
            aria-label="步骤标题"
            autoFocus
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            onBlur={commit}
          />
        ) : (
          <span
            className={cx(styles.title, step.status === "done" && styles.titleDone, step.status === "skipped" && styles.titleSkipped)}
            onDoubleClick={onStartEdit}
            title="双击重命名"
          >
            {step.title}
            {step.threadId && (
              <span className={styles.thread} title="这一步交给了 Thread 执行">
                <GitBranch size={10} aria-hidden />Thread
              </span>
            )}
          </span>
        )}
        {step.status === "awaiting_learner" && step.note && <span className={styles.note}>{step.note}</span>}
        {!editing && (
          <div className={styles.actions} role="group" aria-label={`操作：${step.title}`}>
            {finished ? (
              <button type="button" className={styles.act} onClick={() => onStatus("pending")}>
                <Undo2 size={12} aria-hidden />恢复
              </button>
            ) : (
              <>
                <button type="button" className={cx(styles.act, styles.actPrimary)} onClick={() => onStatus("done")}>
                  <Check size={12} aria-hidden />完成
                </button>
                <button type="button" className={styles.act} onClick={() => onStatus("skipped")}>
                  <SkipForward size={12} aria-hidden />跳过
                </button>
              </>
            )}
            <button type="button" className={cx(styles.act, styles.actIcon)} onClick={onStartEdit} aria-label="重命名" title="重命名（也可双击标题）">
              <Pencil size={12} aria-hidden />
            </button>
          </div>
        )}
      </div>
    </li>
  );
}

function PlanBarInner({ conversationId, busy = false, canSaveToPage }: PlanBarProps & { conversationId: string }) {
  const listId = useId();
  const [plan, setPlan] = useState<LearningPlan | null>(null);
  const planRef = useRef<LearningPlan | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [fresh, setFresh] = useState<Record<string, true>>({});
  const [notice, setNotice] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [addDraft, setAddDraft] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [subjectId, setSubjectId] = useState<string | null>(null);
  const [sent, setSent] = useState<"" | "page" | "quiz" | "agenda">("");
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const menuRef = useRef<HTMLDivElement>(null);
  const timers = useRef<{ fresh?: number; notice?: number; sent?: number }>({});

  const commit = useCallback((next: LearningPlan | null) => {
    const previous = planRef.current;
    planRef.current = next;
    setPlan(next);
    const changed = changedSteps(previous, next);
    if (changed.length === 0) return;
    setFresh(Object.fromEntries(changed.map((step) => [step.id, true as const])));
    window.clearTimeout(timers.current.fresh);
    timers.current.fresh = window.setTimeout(() => setFresh({}), 900);
    const done = changed.filter((step) => step.status === "done").map((step) => step.title);
    const awaiting = changed.find((step) => step.status === "awaiting_learner");
    const parts = [
      done.length ? `已完成：${done.join("、")}` : "",
      awaiting ? `等你回答：${awaiting.note || awaiting.title}` : "",
    ].filter(Boolean);
    if (parts.length) setAnnouncement(parts.join("；"));
  }, []);

  useEffect(() => {
    let cancelled = false;
    const timerBag = timers.current;
    planApi.get(conversationId).then((loaded) => {
      if (cancelled) return;
      const next = acceptPlanEvent(planRef.current, { conversationId, plan: loaded }, conversationId);
      if (next) commit(next);
    }).catch(() => { /* 没有计划条也不影响对话 */ });
    const onPlan = (event: Event) => {
      const next = acceptPlanEvent(planRef.current, (event as CustomEvent<PlanEventDetail>).detail, conversationId);
      if (next) commit(next);
    };
    window.addEventListener(PLAN_EVENT, onPlan);
    return () => {
      cancelled = true;
      window.removeEventListener(PLAN_EVENT, onPlan);
      window.clearTimeout(timerBag.fresh);
      window.clearTimeout(timerBag.notice);
      window.clearTimeout(timerBag.sent);
    };
  }, [conversationId, commit]);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
        setConfirmClear(false);
      }
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
        setConfirmClear(false);
      }
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const dismissStorageKey = plan ? dismissKey(conversationId, plan.version) : "";
  const showSummary = Boolean(plan && plan.steps.length > 0 && plan.completedAt && !readDismissed(dismissStorageKey));

  useEffect(() => {
    if (!showSummary || canSaveToPage !== undefined) return;
    let cancelled = false;
    chatApi.getConversation(conversationId)
      .then((conversation) => { if (!cancelled) setSubjectId(conversation.subjectId); })
      .catch(() => { /* 查不到就不显示「存进 Pages」 */ });
    return () => { cancelled = true; };
  }, [showSummary, canSaveToPage, conversationId]);

  const flashNotice = (message: string) => {
    setNotice(message);
    window.clearTimeout(timers.current.notice);
    timers.current.notice = window.setTimeout(() => setNotice(""), 4500);
  };

  /** 先乐观更新，再调用接口；失败时恢复原样并提示 */
  const mutate = async (optimistic: LearningPlan | null, call: () => Promise<LearningPlan | void>, failure: string) => {
    const snapshot = planRef.current;
    commit(optimistic);
    try {
      const result = await call();
      if (result) {
        const current = planRef.current;
        if (!current || result.version >= current.version) commit({ ...result, conversationId });
      }
    } catch (error) {
      if (planRef.current === optimistic) commit(snapshot);
      flashNotice(`${failure}，已恢复：${toApiError(error).message}`);
    }
  };

  const setStatus = (step: PlanStep, status: "done" | "skipped" | "pending") => {
    const current = planRef.current;
    if (!current) return;
    void mutate(
      applyStepPatch(current, step.id, { status }),
      () => planApi.updateStep(conversationId, step.id, { status }),
      "更新步骤失败",
    );
  };

  const rename = (step: PlanStep, raw: string) => {
    setEditingId(null);
    const title = raw.trim().slice(0, TITLE_MAX);
    const current = planRef.current;
    if (!current || !title || title === step.title) return;
    void mutate(
      applyStepPatch(current, step.id, { title }),
      () => planApi.updateStep(conversationId, step.id, { title }),
      "重命名失败",
    );
  };

  const addStep = (raw: string) => {
    const title = raw.trim().slice(0, TITLE_MAX);
    setAdding(false);
    setAddDraft("");
    const current = planRef.current;
    if (!current || !title) return;
    const temp: PlanStep = {
      id: `pending-${Date.now()}`, title, status: "pending", note: "", threadId: null, completedMessageId: null, updatedAt: null,
    };
    void mutate(
      { ...current, steps: [...current.steps, temp], completedAt: null },
      () => planApi.addStep(conversationId, title),
      "添加步骤失败",
    );
  };

  const clearPlan = () => {
    setMenuOpen(false);
    setConfirmClear(false);
    setExpanded(false);
    void mutate(null, async () => { await planApi.clear(conversationId); }, "清空计划失败");
  };

  const markSent = (kind: "page" | "quiz" | "agenda") => {
    setSent(kind);
    window.clearTimeout(timers.current.sent);
    timers.current.sent = window.setTimeout(() => setSent(""), 1800);
  };
  const sendToComposer = (text: string, kind: "quiz" | "agenda") => {
    window.dispatchEvent(new CustomEvent<ComposerTextDetail>(SEND_TO_COMPOSER_EVENT, { detail: { conversationId, text } }));
    markSent(kind);
  };
  const saveToPage = () => {
    if (!plan) return;
    window.dispatchEvent(new CustomEvent(SAVE_TO_PAGE_EVENT, { detail: { content: summaryMarkdown(plan) } }));
    markSent("page");
  };
  const dismissSummary = () => {
    try { localStorage.setItem(dismissStorageKey, "1"); } catch { /* 只是不再记住 */ }
    rerender();
  };

  const live = <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</div>;

  if (!plan || plan.steps.length === 0) return live;

  const { label, ratio } = progressOf(plan);
  const current = currentStep(plan);
  const currentText = current ? currentLabel(current) : "所有步骤都处理完了";
  const canSave = canSaveToPage ?? Boolean(subjectId);

  if (showSummary) {
    return (
      <section className={styles.summary} aria-label="学习小结">
        {live}
        <header className={styles.summaryHead}>
          <span className={styles.summaryMark} aria-hidden><Check size={12} strokeWidth={3} /></span>
          <strong className={styles.summaryTitle}>{summaryTitle(plan)}</strong>
          <button type="button" className={styles.iconBtn} onClick={dismissSummary} aria-label="关闭小结" title="关闭">
            <X size={14} aria-hidden />
          </button>
        </header>
        <div className={styles.summaryActions}>
          {canSave && (
            <button type="button" className={styles.sumBtn} onClick={saveToPage}>
              <NotebookPen size={13} aria-hidden />{sent === "page" ? "已存入 Pages" : "存进 Pages"}
            </button>
          )}
          <button type="button" className={styles.sumBtn} disabled={busy} onClick={() => sendToComposer(QUIZ_PROMPT, "quiz")}>
            <ListChecks size={13} aria-hidden />{sent === "quiz" ? "已发送" : "生成随堂测验"}
          </button>
          <button type="button" className={styles.sumBtn} disabled={busy} onClick={() => sendToComposer(AGENDA_PROMPT, "agenda")}>
            <CalendarClock size={13} aria-hidden />{sent === "agenda" ? "已发送" : "把复习排进日程"}
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className={cx(styles.bar, expanded && styles.barOpen)} aria-label="学习计划">
      {live}
      <div className={styles.head}>
        <button
          type="button"
          className={styles.toggle}
          aria-expanded={expanded}
          aria-controls={listId}
          onClick={() => setExpanded((open) => !open)}
          title={currentText}
        >
          <span className={styles.count}>{label}</span>
          <span className={styles.track} aria-hidden>
            <span className={styles.fill} style={{ transform: `scaleX(${ratio})` }} />
          </span>
          <span
            key={`${current?.step.id ?? "none"}:${current?.kind ?? ""}`}
            className={cx(
              styles.current,
              current?.kind === "active" && styles.currentActive,
              current?.kind === "awaiting" && styles.currentAwait,
            )}
          >
            {currentText}
          </span>
          <ChevronDown size={14} className={cx(styles.chevron, expanded && styles.chevronOpen)} aria-hidden />
        </button>
        <div className={styles.menuAnchor} ref={menuRef}>
          <button
            type="button"
            className={styles.iconBtn}
            onClick={() => { setMenuOpen((open) => !open); setConfirmClear(false); }}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label="计划菜单"
            title="计划菜单"
          >
            <Ellipsis size={15} aria-hidden />
          </button>
          {menuOpen && (
            <div className={styles.menu} role="menu">
              <button
                type="button"
                role="menuitem"
                className={cx(styles.menuItem, confirmClear && styles.menuDanger)}
                onClick={() => (confirmClear ? clearPlan() : setConfirmClear(true))}
              >
                {confirmClear ? "再点一次确认清空" : "清空计划"}
              </button>
            </div>
          )}
        </div>
      </div>

      {notice && <p className={styles.notice} role="alert">{notice}</p>}

      {expanded && (
        <div id={listId} className={styles.panel}>
          <ol className={styles.list}>
            {plan.steps.map((step) => (
              <StepRow
                key={step.id}
                step={step}
                fresh={Boolean(fresh[step.id])}
                editing={editingId === step.id}
                onStartEdit={() => setEditingId(step.id)}
                onCancelEdit={() => setEditingId(null)}
                onRename={(title) => rename(step, title)}
                onStatus={(status) => setStatus(step, status)}
              />
            ))}
          </ol>
          {adding ? (
            <input
              className={cx(styles.edit, styles.addInput)}
              value={addDraft}
              maxLength={TITLE_MAX}
              placeholder="新步骤，回车添加"
              aria-label="新步骤标题"
              autoFocus
              onChange={(event) => setAddDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                if (event.key === "Enter") {
                  event.preventDefault();
                  addStep(addDraft);
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  setAdding(false);
                  setAddDraft("");
                }
              }}
              onBlur={() => addStep(addDraft)}
            />
          ) : (
            <button type="button" className={styles.addBtn} onClick={() => setAdding(true)}>
              <Plus size={13} aria-hidden />添加一步
            </button>
          )}
        </div>
      )}
    </section>
  );
}

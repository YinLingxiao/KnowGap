"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Maximize2, Minimize2, Pause, Play, Timer, X } from "lucide-react";
import { FOCUS_START_EVENT, type FocusStartDetail } from "@/lib/agenda/types";
import { cx } from "@/lib/cx";
import { FOCUS_PRESETS } from "@/lib/focus/types";
import {
  abandonFocus, completeFocus, getFocusServerSnapshot, getFocusSnapshot, hydrateFocus, pauseFocus,
  remainingMs, resumeFocus, selectPreset, setWrapupDraft, startFocus, subscribeFocus,
} from "@/lib/focus/store";
import styles from "./FocusCapsule.module.css";

function portal(node: ReactNode) {
  return typeof document === "undefined" ? null : createPortal(node, document.body);
}

function formatClock(ms: number) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/**
 * 侧栏里的专注入口：空闲时是一个普通导航项，点开弹层选时长；计时中这一行显示倒计时和任务名。
 * 结项卡浮在右下角；禅定模式下侧栏收起，改为顶部居中的极简计时胶囊。
 */
export function FocusCapsule({
  zen, onZenChange, contextSubjectId,
}: {
  zen: boolean;
  onZenChange: (next: boolean) => void;
  contextSubjectId: string | null;
}) {
  const state = useSyncExternalStore(subscribeFocus, getFocusSnapshot, getFocusServerSnapshot);
  const [, setTick] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => { hydrateFocus(); }, []);

  useEffect(() => {
    if (state.phase === "idle" && zen) onZenChange(false);
  }, [state.phase, zen, onZenChange]);

  useEffect(() => {
    if (state.phase !== "running" && state.phase !== "wrapup") return;
    const tick = () => {
      if (document.visibilityState === "hidden") return;
      setTick((value) => value + 1);
    };
    const id = window.setInterval(tick, 250);
    const onVis = () => {
      if (document.visibilityState === "visible") setTick((value) => value + 1);
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [state.phase]);

  useEffect(() => {
    const onStart = (event: Event) => {
      const detail = (event as CustomEvent<FocusStartDetail>).detail;
      if (!detail || typeof detail.title !== "string") return;
      setError(null);
      void startFocus({
        title: detail.title,
        subjectId: detail.subjectId ?? null,
        taskId: detail.taskId ?? null,
      }).catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : "没能开始专注");
      });
    };
    window.addEventListener(FOCUS_START_EVENT, onStart);
    return () => window.removeEventListener(FOCUS_START_EVENT, onStart);
  }, []);

  useEffect(() => {
    if (state.phase !== "wrapup" || state.wrapupUntil == null) return;
    const delay = state.wrapupUntil - Date.now();
    const id = window.setTimeout(() => {
      void abandonFocus().catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : "结项没有保存");
      });
    }, Math.max(0, delay));
    return () => window.clearTimeout(id);
  }, [state.phase, state.wrapupUntil]);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const now = Date.now();
  const remain = remainingMs(state, now);
  const active = state.phase === "running" || state.phase === "paused";
  const total = state.plannedSeconds ? state.plannedSeconds * 1000 : 0;
  const progress = active && total > 0 ? Math.min(1, Math.max(0, 1 - remain / total)) : 0;
  const wrapLeft = state.wrapupUntil == null ? null : Math.max(0, Math.ceil((state.wrapupUntil - now) / 1000));

  const begin = () => {
    setError(null);
    setBusy(true);
    void startFocus({ title: "自由专注", subjectId: contextSubjectId, taskId: null })
      .then(() => setOpen(false))
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "没能开始专注"))
      .finally(() => setBusy(false));
  };
  const abandon = () => {
    void abandonFocus("已放弃").catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : "没能放弃");
    });
    setOpen(false);
  };

  return (
    <div className={styles.dock} ref={rootRef}>
      <button
        type="button"
        className={cx(styles.trigger, (active || open) && styles.triggerOn)}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={active ? `专注中：${state.title}` : "专注计时"}
      >
        <Timer size={15} aria-hidden />
        <span className={styles.label}>{active ? state.title : "专注"}</span>
        {active && (
          <span className={styles.clock} aria-live="off">
            {state.phase === "paused" && <Pause size={10} aria-hidden />}
            {formatClock(remain)}
          </span>
        )}
        {active && <span className={styles.progress} style={{ transform: `scaleX(${progress})` }} aria-hidden />}
      </button>

      {open && (
        <div className={styles.popover} role="dialog" aria-label="专注计时">
          {active ? (
            <>
              <div className={styles.bigClock}>{formatClock(remain)}</div>
              <p className={styles.popTitle}>{state.title}</p>
              <div className={styles.row}>
                {state.phase === "running" ? (
                  <button type="button" className={styles.ghost} onClick={pauseFocus}><Pause size={13} aria-hidden />暂停</button>
                ) : (
                  <button type="button" className={styles.ghost} onClick={resumeFocus}><Play size={13} aria-hidden />继续</button>
                )}
                <button type="button" className={styles.ghost} onClick={() => { onZenChange(!zen); setOpen(false); }}>
                  {zen ? <Minimize2 size={13} aria-hidden /> : <Maximize2 size={13} aria-hidden />}
                  {zen ? "退出禅定" : "禅定模式"}
                </button>
                <button type="button" className={cx(styles.ghost, styles.danger)} onClick={abandon}>放弃</button>
              </div>
            </>
          ) : (
            <>
              <p className={styles.popHead}>专注时长</p>
              <div className={styles.presets} role="group" aria-label="专注时长">
                {FOCUS_PRESETS.map((preset) => (
                  <button
                    key={preset.seconds}
                    type="button"
                    className={cx(styles.preset, state.presetSeconds === preset.seconds && styles.presetOn)}
                    aria-pressed={state.presetSeconds === preset.seconds}
                    onClick={() => selectPreset(preset.seconds)}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
              <button type="button" className={styles.primary} disabled={busy} onClick={begin}>开始专注</button>
              <p className={styles.tip}>也可以在日程里点任务的「▶ 专注」，结束时会自动关联到这项任务。</p>
            </>
          )}
          {error && <p className={styles.error} role="alert">{error}</p>}
        </div>
      )}

      {/* 侧栏收起时整体带 transform，fixed 元素要挂到 body 上才能定位到视口 */}
      {zen && (active || state.phase === "wrapup") && portal(
        <div className={styles.zenPill} role="status">
          <Timer size={13} aria-hidden />
          <span className={styles.zenClock}>{formatClock(remain)}</span>
          <span className={styles.zenTitle}>{state.title}</span>
          <button type="button" className={styles.zenExit} onClick={() => onZenChange(false)} aria-label="退出禅定" title="退出禅定">
            <X size={13} />
          </button>
        </div>,
      )}

      {state.phase === "wrapup" && portal(
        <form
          className={styles.card}
          onSubmit={(event) => {
            event.preventDefault();
            setBusy(true);
            void completeFocus()
              .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "结项没有保存"))
              .finally(() => setBusy(false));
          }}
        >
          <div className={styles.cardHead}>
            <strong>🍅 专注结束 · {state.title}</strong>
            {wrapLeft != null && <span className={styles.hint}>{wrapLeft}s</span>}
          </div>
          <input
            className={styles.input}
            value={state.draftNote}
            maxLength={280}
            placeholder="一句话收获，会存进空间的 Pages 笔记"
            aria-label="一句话收获"
            autoFocus
            onChange={(event) => setWrapupDraft({ draftNote: event.target.value })}
          />
          <div className={styles.cardFoot}>
            {state.taskId ? (
              <label className={styles.check}>
                <input
                  type="checkbox"
                  checked={state.completeTask}
                  onChange={(event) => setWrapupDraft({ completeTask: event.target.checked })}
                />
                完成绑定的任务
              </label>
            ) : <span />}
            <button type="submit" className={styles.primary} disabled={busy}>保存</button>
          </div>
          {error && <p className={styles.error} role="alert">{error}</p>}
        </form>,
      )}
    </div>
  );
}

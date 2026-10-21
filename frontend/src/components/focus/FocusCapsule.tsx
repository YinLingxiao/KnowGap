"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { FOCUS_START_EVENT, type FocusStartDetail } from "@/lib/agenda/types";
import { FOCUS_PRESETS } from "@/lib/focus/types";
import {
  abandonFocus, completeFocus, getFocusServerSnapshot, getFocusSnapshot, hydrateFocus, pauseFocus,
  remainingMs, resumeFocus, selectPreset, setWrapupDraft, startFocus, subscribeFocus,
} from "@/lib/focus/store";
import styles from "./FocusCapsule.module.css";

function formatClock(ms: number) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

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

  const now = Date.now();
  const remain = remainingMs(state, now);
  const active = state.phase === "running" || state.phase === "paused";
  const wrapLeft = state.wrapupUntil == null ? null : Math.max(0, Math.ceil((state.wrapupUntil - now) / 1000));

  const begin = () => {
    setError(null);
    setBusy(true);
    void startFocus({ title: "自由专注", subjectId: contextSubjectId, taskId: null })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "没能开始专注"))
      .finally(() => setBusy(false));
  };

  return (
    <div className={styles.slot}>
      <div className={styles.bar}>
        <span className={styles.time} aria-live="polite">{formatClock(remain)}</span>
        {state.phase !== "idle" && state.title && <span className={styles.task}>{state.title}</span>}
        {state.phase === "idle" && (
          <div className={styles.presets} role="group" aria-label="专注时长">
            {FOCUS_PRESETS.map((preset) => (
              <button
                key={preset.seconds}
                type="button"
                className={state.presetSeconds === preset.seconds ? styles.presetOn : styles.preset}
                aria-pressed={state.presetSeconds === preset.seconds}
                onClick={() => selectPreset(preset.seconds)}
              >
                {preset.label}
              </button>
            ))}
          </div>
        )}
        {state.phase === "idle" && (
          <button type="button" className={styles.primary} disabled={busy} onClick={begin}>开始</button>
        )}
        {state.phase === "running" && (
          <button type="button" className={styles.ghost} onClick={pauseFocus}>暂停</button>
        )}
        {state.phase === "paused" && (
          <button type="button" className={styles.ghost} onClick={resumeFocus}>继续</button>
        )}
        {active && (
          <button
            type="button"
            className={styles.ghost}
            onClick={() => {
              void abandonFocus("已放弃").catch((reason: unknown) => {
                setError(reason instanceof Error ? reason.message : "没能放弃");
              });
            }}
          >
            放弃
          </button>
        )}
        {active && (
          <button type="button" className={zen ? styles.presetOn : styles.ghost} onClick={() => onZenChange(!zen)}>
            {zen ? "退出禅定" : "禅定"}
          </button>
        )}
        {state.phase === "wrapup" && zen && (
          <button type="button" className={styles.ghost} onClick={() => onZenChange(false)}>退出禅定</button>
        )}
      </div>
      {error && <p className={styles.error} role="alert">{error}</p>}
      {state.phase === "wrapup" && (
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
            <strong>专注结束</strong>
            {wrapLeft != null && <span className={styles.hint}>{wrapLeft} 秒后自动收起</span>}
          </div>
          <input
            className={styles.input}
            value={state.draftNote}
            maxLength={280}
            placeholder="一句话收获"
            aria-label="一句话收获"
            onChange={(event) => setWrapupDraft({ draftNote: event.target.value })}
          />
          {state.taskId && (
            <label className={styles.check}>
              <input
                type="checkbox"
                checked={state.completeTask}
                onChange={(event) => setWrapupDraft({ completeTask: event.target.checked })}
              />
              完成绑定的任务
            </label>
          )}
          <button type="submit" className={styles.primary} disabled={busy}>保存</button>
        </form>
      )}
    </div>
  );
}

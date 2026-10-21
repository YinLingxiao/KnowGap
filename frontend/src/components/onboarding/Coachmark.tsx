"use client";

import { useEffect, useState } from "react";
import {
  COACH_COPY, COACH_IDS, coachSeenKey, coachSessionKey,
  type CoachId,
} from "./coach";
import styles from "./Coachmark.module.css";

function anchorFor(id: CoachId): HTMLElement | null {
  if (id === "plan") return document.querySelector<HTMLElement>('[aria-label="学习计划"]');
  return document.querySelector<HTMLElement>(`[data-coachmark="${id}"]`);
}

function sessionIds(userId: string) {
  return (sessionStorage.getItem(coachSessionKey(userId)) ?? "").split(",").filter(Boolean);
}

function rememberShown(userId: string, id: CoachId) {
  const ids = sessionIds(userId);
  if (!ids.includes(id)) {
    ids.push(id);
    sessionStorage.setItem(coachSessionKey(userId), ids.join(","));
  }
}

function typingNow() {
  const el = document.activeElement;
  return el instanceof HTMLElement && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));
}

export function CoachmarkHost({ userId, enabled }: { userId: string; enabled: boolean }) {
  const [current, setCurrent] = useState<CoachId | null>(null);
  const [box, setBox] = useState<{ top: number; left: number } | null>(null);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    const sync = () => setPaused(typingNow());
    document.addEventListener("focusin", sync);
    document.addEventListener("focusout", sync);
    return () => {
      document.removeEventListener("focusin", sync);
      document.removeEventListener("focusout", sync);
    };
  }, []);

  useEffect(() => {
    if (!enabled || paused) {
      setCurrent(null);
      return;
    }
    let frame = 0;
    const pick = () => {
      const shown = sessionIds(userId);
      const order = COACH_IDS.filter((id) => id !== "spotlight" || Boolean(window.knowgap));
      let next: CoachId | null = null;
      let node: HTMLElement | null = null;
      for (const id of order) {
        if (localStorage.getItem(coachSeenKey(userId, id)) === "1") continue;
        if (shown.length >= 2 && !shown.includes(id)) continue;
        const found = anchorFor(id);
        if (!found) continue;
        next = id;
        node = found;
        break;
      }
      setCurrent(next);
      if (next && node) {
        rememberShown(userId, next);
        const rect = node.getBoundingClientRect();
        const top = rect.bottom + 8 + 72 > window.innerHeight ? Math.max(8, rect.top - 72) : rect.bottom + 8;
        setBox({ top, left: Math.min(Math.max(8, rect.left), window.innerWidth - 280) });
      } else {
        setBox(null);
      }
    };
    const schedule = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(pick);
    };
    schedule();
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
    };
  }, [enabled, paused, userId]);

  if (!current || !box) return null;
  return (
    <div className={styles.bubble} style={{ top: box.top, left: box.left }} role="dialog" aria-label={COACH_COPY[current]}>
      <p>{COACH_COPY[current]}</p>
      <button
        type="button"
        onClick={() => {
          localStorage.setItem(coachSeenKey(userId, current), "1");
          setCurrent(null);
        }}
      >
        知道了
      </button>
    </div>
  );
}

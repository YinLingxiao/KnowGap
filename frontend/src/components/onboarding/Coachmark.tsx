"use client";

import { useEffect, useRef, useState } from "react";
import {
  COACH_COPY, COACH_IDS, LEGACY_COACH_IDS, coachSeenKey, coachSessionKey,
  type CoachId,
} from "./coach";
import styles from "./Coachmark.module.css";

const LEGACY = new Set<CoachId>(LEGACY_COACH_IDS);

function anchorFor(id: CoachId): HTMLElement | null {
  if (id === "plan") return document.querySelector<HTMLElement>('[aria-label="学习计划"]');
  if (id === "slash") return document.getElementById("chat-input");
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

function seen(userId: string, id: CoachId) {
  return localStorage.getItem(coachSeenKey(userId, id)) === "1";
}

function emptyComposer() {
  const el = document.activeElement;
  return el instanceof HTMLTextAreaElement && el.id === "chat-input" && el.value.length === 0;
}

function blockingInput() {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement)) return false;
  if (!(el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName))) return false;
  return !emptyComposer();
}

function place(id: CoachId, node: HTMLElement) {
  const rect = node.getBoundingClientRect();
  const bubble = 76;
  const below = rect.bottom + 8;
  const above = Math.max(8, rect.top - 8 - bubble);
  const top = id === "slash" || below + bubble > window.innerHeight ? above : below;
  return { top, left: Math.min(Math.max(8, rect.left), window.innerWidth - 368) };
}

export function CoachmarkHost({ userId, enabled }: { userId: string; enabled: boolean }) {
  const [current, setCurrent] = useState<CoachId | null>(null);
  const [box, setBox] = useState<{ top: number; left: number } | null>(null);
  const [paused, setPaused] = useState(false);
  const [slashArmed, setSlashArmed] = useState(false);
  const currentRef = useRef<CoachId | null>(null);
  currentRef.current = current;

  useEffect(() => {
    const sync = () => setPaused(blockingInput());
    const arm = () => {
      if (emptyComposer() && !seen(userId, "slash")) setSlashArmed(true);
    };
    const onFocus = (event: FocusEvent) => {
      const target = event.target;
      if (target instanceof HTMLTextAreaElement && target.id === "chat-input" && target.value.length === 0 && !seen(userId, "slash")) {
        setSlashArmed(true);
      }
      sync();
    };
    arm();
    const frame = window.requestAnimationFrame(arm);
    sync();
    document.addEventListener("focusin", onFocus);
    document.addEventListener("focusout", sync);
    document.addEventListener("input", sync);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("focusout", sync);
      document.removeEventListener("input", sync);
    };
  }, [userId]);

  useEffect(() => {
    if (paused && currentRef.current === "slash") {
      localStorage.setItem(coachSeenKey(userId, "slash"), "1");
      setSlashArmed(false);
    }
  }, [paused, userId]);

  useEffect(() => {
    if (!enabled || paused) {
      setCurrent(null);
      return;
    }
    let frame = 0;
    const pick = () => {
      const shown = sessionIds(userId);
      const legacyShown = shown.filter((id) => LEGACY.has(id as CoachId));
      const order = COACH_IDS.filter((id) => id !== "slash" && (id !== "spotlight" || Boolean(window.knowgap)));
      const sticky = currentRef.current;
      let next: CoachId | null = null;
      let node: HTMLElement | null = null;
      if (sticky && sticky !== "slash" && !seen(userId, sticky)) {
        const stuck = anchorFor(sticky);
        if (stuck) {
          next = sticky;
          node = stuck;
        }
      }
      if (!next) {
        for (const id of order) {
          if (seen(userId, id)) continue;
          if (id === "fog" && !seen(userId, "sheet")) continue;
          if (LEGACY.has(id) && legacyShown.length >= 2 && !shown.includes(id)) continue;
          const found = anchorFor(id);
          if (!found) continue;
          next = id;
          node = found;
          break;
        }
      }
      if (!next && slashArmed && !seen(userId, "slash") && emptyComposer()) {
        const found = anchorFor("slash");
        if (found) {
          next = "slash";
          node = found;
        }
      }
      setCurrent(next);
      if (next && node) {
        rememberShown(userId, next);
        setBox(place(next, node));
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
  }, [enabled, paused, slashArmed, userId]);

  if (!current || !box) return null;
  return (
    <div className={styles.bubble} style={{ top: box.top, left: box.left }} role="dialog" aria-label={COACH_COPY[current]}>
      <p>{COACH_COPY[current]}</p>
      <button
        type="button"
        onClick={() => {
          localStorage.setItem(coachSeenKey(userId, current), "1");
          if (current === "slash") setSlashArmed(false);
          setCurrent(null);
        }}
      >
        知道了
      </button>
    </div>
  );
}

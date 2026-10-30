"use client";

import { useEffect, useRef, useState } from "react";
import {
  COACH_COPY, COACH_IDS, LEGACY_COACH_IDS, coachSeenKey, coachSessionKey,
  type CoachId,
} from "./coach";
import { cx } from "@/lib/cx";
import { useI18n } from "@/components/LanguageProvider";
import styles from "./Coachmark.module.css";

const LEGACY = new Set<CoachId>(LEGACY_COACH_IDS);

function anchorFor(id: CoachId): HTMLElement | null {
  const selector = id === "plan" ? '[aria-label="学习计划"]' : id === "slash" ? "#chat-input" : `[data-coachmark="${id}"]`;
  // 面板全屏时主线是 inert 的：气泡不能指向被盖住的控件，退出全屏后再出现
  return [...document.querySelectorAll<HTMLElement>(selector)].find((node) => !node.closest("[inert]")) ?? null;
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

type Box = { top: number; left?: number; right?: number; inline?: boolean };

const BUBBLE_H = 44;

/** 气泡不能压住标题、问候语这类正文，按锚点类型选位置 */
function place(id: CoachId, node: HTMLElement): Box | null {
  const rect = node.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (id === "slash") {
    // 只在输入框为空时出现：收进输入框第一行的右侧，那里没有文字；太窄放不下就不提示
    if (rect.width < 520) return null;
    return { top: rect.top - 1, right: Math.max(8, vw - rect.right), inline: true };
  }
  const visibleBottom = Math.min(rect.bottom, vh);
  if (visibleBottom - Math.max(rect.top, 0) > vh * 0.5) {
    // 整页锚点（日程页、整个应用）：像通知一样放在可见区域右下角
    return { top: visibleBottom - BUBBLE_H - 16, right: Math.max(8, vw - Math.min(rect.right, vw) + 16) };
  }
  const left = Math.min(Math.max(8, rect.left), vw - 368);
  if (rect.bottom + 8 + BUBBLE_H <= vh) return { top: rect.bottom + 8, left };
  return { top: Math.max(8, rect.top - 8 - BUBBLE_H), left };
}

export function CoachmarkHost({ userId, enabled }: { userId: string; enabled: boolean }) {
  const { tx } = useI18n();
  const [current, setCurrent] = useState<CoachId | null>(null);
  const [box, setBox] = useState<Box | null>(null);
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
      const spot = next && node ? place(next, node) : null;
      setCurrent(spot ? next : null);
      if (next && spot) {
        rememberShown(userId, next);
        setBox(spot);
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
    // 侧栏收起、面板展开这类布局变化只改 class，也要重新定位
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    // 侧栏等宽度动画结束后再量一次，否则气泡停在动画开始前的位置
    document.addEventListener("transitionend", schedule, true);
    return () => {
      document.removeEventListener("transitionend", schedule, true);
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
    };
  }, [enabled, paused, slashArmed, userId]);

  if (!current || !box) return null;
  return (
    <div
      className={cx(styles.bubble, box.inline && styles.inline)}
      style={{ top: box.top, left: box.left, right: box.right }}
      role="dialog"
      aria-label={tx(COACH_COPY[current])}
    >
      <p>{tx(COACH_COPY[current])}</p>
      <button
        type="button"
        onClick={() => {
          localStorage.setItem(coachSeenKey(userId, current), "1");
          if (current === "slash") setSlashArmed(false);
          setCurrent(null);
        }}
      >
        {tx("知道了")}
      </button>
    </div>
  );
}

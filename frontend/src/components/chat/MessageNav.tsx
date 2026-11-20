"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { useI18n } from "@/components/LanguageProvider";
import type { NavTurn } from "@/lib/chat/messageNav";
import { cx } from "@/lib/cx";
import styles from "./MessageNav.module.css";

export type MessageNavEntry = NavTurn;

const SHOW_DELAY = 90;
const HIDE_DELAY = 160;

/** 当前读到哪一问：视口上方 1/3 处之上的最后一条提问 */
function activeIndex(root: HTMLElement, entries: MessageNavEntry[]): number {
  const line = root.getBoundingClientRect().top + root.clientHeight / 3;
  let active = 0;
  entries.forEach((entry, index) => {
    const element = root.querySelector<HTMLElement>(`[data-msg-id="${CSS.escape(entry.id)}"]`);
    if (element && element.getBoundingClientRect().top <= line) active = index;
  });
  return active;
}

/**
 * 对话右侧的提问导航：每条提问一道刻度，当前读到的那条更长更亮。
 * 悬停或键盘聚焦某道刻度时，在它左边弹出预览卡（提问 + 回答开头），点刻度或卡片跳过去。
 */
export function MessageNav({
  entries, scrollRef, onJump,
}: {
  entries: MessageNavEntry[];
  scrollRef: RefObject<HTMLDivElement | null>;
  onJump: (messageId: string) => void;
}) {
  const { tx } = useI18n();
  const cardId = useId();
  const [active, setActive] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  const [cardTop, setCardTop] = useState(0);
  const navRef = useRef<HTMLElement>(null);
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const showTimer = useRef(0);
  const hideTimer = useRef(0);
  // 每次渲染都会拿到新数组；只在提问增减时重新挂监听
  const latest = useRef(entries);
  latest.current = entries;
  const idsKey = entries.map((entry) => entry.id).join("|");

  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      setActive(activeIndex(root, latest.current));
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
    };
    update();
    root.addEventListener("scroll", schedule, { passive: true });
    return () => {
      root.removeEventListener("scroll", schedule);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [idsKey, scrollRef]);

  useEffect(() => () => {
    window.clearTimeout(showTimer.current);
    window.clearTimeout(hideTimer.current);
  }, []);

  if (entries.length < 2) return null;

  const place = (index: number) => {
    const button = buttons.current[index];
    const nav = navRef.current;
    if (!button || !nav) return;
    const box = button.getBoundingClientRect();
    setCardTop(box.top + box.height / 2 - nav.getBoundingClientRect().top);
  };

  const show = (index: number, immediate = false) => {
    window.clearTimeout(hideTimer.current);
    window.clearTimeout(showTimer.current);
    place(index);
    // 卡片已经开着时（在刻度间移动）直接换内容，不再等待
    if (immediate || hover !== null) setHover(index);
    else showTimer.current = window.setTimeout(() => setHover(index), SHOW_DELAY);
  };

  const keepOpen = () => window.clearTimeout(hideTimer.current);

  const scheduleHide = () => {
    window.clearTimeout(showTimer.current);
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setHover(null), HIDE_DELAY);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLOListElement>) => {
    const current = buttons.current.findIndex((button) => button === document.activeElement);
    if (current < 0) return;
    let next = current;
    if (event.key === "ArrowDown") next = Math.min(entries.length - 1, current + 1);
    else if (event.key === "ArrowUp") next = Math.max(0, current - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = entries.length - 1;
    else if (event.key === "Escape") {
      setHover(null);
      return;
    } else return;
    event.preventDefault();
    buttons.current[next]?.focus();
  };

  const open = hover !== null ? entries[hover] : undefined;

  return (
    <nav ref={navRef} className={styles.nav} aria-label={tx("提问导航")} onPointerLeave={scheduleHide}>
      <ol className={styles.ticks} onKeyDown={onKeyDown} onScroll={() => setHover(null)}>
        {entries.map((entry, index) => (
          <li key={entry.id}>
            <button
              ref={(element) => { buttons.current[index] = element; }}
              type="button"
              className={cx(styles.tickButton, index === active && styles.on, index === hover && styles.hovered)}
              aria-current={index === active ? "location" : undefined}
              aria-label={tx("第 {n} 问：{text}", { n: index + 1, text: entry.question })}
              aria-describedby={index === hover ? cardId : undefined}
              onPointerEnter={() => show(index)}
              onFocus={() => show(index, true)}
              onBlur={scheduleHide}
              onClick={() => onJump(entry.id)}
            >
              <span className={styles.tick} aria-hidden />
            </button>
          </li>
        ))}
      </ol>
      {open && (
        <div
          id={cardId}
          role="tooltip"
          className={styles.card}
          style={{ top: cardTop }}
          onPointerEnter={keepOpen}
          onClick={() => onJump(open.id)}
        >
          <div className={styles.cardMeta}>
            <span>{tx("第 {n} / {total} 问", { n: (hover ?? 0) + 1, total: entries.length })}</span>
            {open.hasQuiz && <span className={styles.badge}>{tx("含小测")}</span>}
          </div>
          <p className={styles.question}>{open.question}</p>
          {open.answer
            ? <p className={styles.answer}>{open.answer}</p>
            : <p className={cx(styles.answer, styles.pending)}>{tx("还没有文字回答")}</p>}
        </div>
      )}
    </nav>
  );
}

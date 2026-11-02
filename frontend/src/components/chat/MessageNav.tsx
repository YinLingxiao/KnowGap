"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { useI18n } from "@/components/LanguageProvider";
import { cx } from "@/lib/cx";
import styles from "./MessageNav.module.css";

export interface MessageNavEntry {
  id: string;
  preview: string;
}

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
 * 对话右侧的提问导航：每条提问一道刻度，当前读到的那条更长更亮；
 * 悬停或键盘聚焦时向左展开提问列表，点一下跳过去。
 */
export function MessageNav({
  entries, scrollRef, onJump,
}: {
  entries: MessageNavEntry[];
  scrollRef: RefObject<HTMLDivElement | null>;
  onJump: (messageId: string) => void;
}) {
  const { tx } = useI18n();
  const [active, setActive] = useState(0);
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

  if (entries.length < 2) return null;

  return (
    <nav className={styles.nav} aria-label={tx("提问导航")}>
      <ol className={styles.panel}>
        {entries.map((entry, index) => (
          <li key={entry.id}>
            <button
              type="button"
              className={cx(styles.item, index === active && styles.itemOn)}
              aria-current={index === active ? "location" : undefined}
              onClick={() => onJump(entry.id)}
            >
              <span className={styles.itemText}>{entry.preview}</span>
              <span className={styles.tick} aria-hidden />
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}

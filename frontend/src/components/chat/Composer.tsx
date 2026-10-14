"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ArrowUp, Dumbbell, Plus, Square } from "lucide-react";
import type { StreamPhase } from "@/hooks/useChat";
import { cx } from "@/lib/cx";
import type { Problem } from "@/lib/types";
import styles from "./Composer.module.css";

interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  phase: StreamPhase | null;
  busy: boolean;
  problems: Problem[];
  onStartExercise: (problemId: string) => void;
  autoFocusKey: string;
  inputId?: string;
  placeholder?: string;
  /** 首页居中的大输入框 */
  hero?: boolean;
}

export const COMPOSER_ID = "chat-input";
const MAX_HEIGHT = 220;

export function Composer({
  value, onChange, onSend, onStop, phase, busy, problems, onStartExercise, autoFocusKey,
  placeholder = "继续提问，或说说你的理解…", hero = false, inputId = COMPOSER_ID,
}: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const generating = phase === "connecting" || phase === "streaming";
  const locked = busy || phase === "connecting";

  // 输入框随内容增高；宽度变化（侧栏开合、窗口缩放）时重新计算
  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    const fit = () => {
      if (!element.value) {
        element.style.height = "";
        element.style.overflowY = "hidden";
        return;
      }
      element.style.height = "auto";
      element.style.height = `${Math.min(element.scrollHeight, MAX_HEIGHT)}px`;
      element.style.overflowY = element.scrollHeight > MAX_HEIGHT ? "auto" : "hidden";
    };
    fit();
    const observer = new ResizeObserver(() => {
      if (element.value) fit();
    });
    observer.observe(element.parentElement ?? element);
    return () => observer.disconnect();
  }, [value]);

  useEffect(() => {
    if (window.matchMedia("(pointer: fine)").matches) textareaRef.current?.focus();
  }, [autoFocusKey]);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const canSend = Boolean(value.trim()) && !generating && !locked;

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey) return;
    // 输入法组字中的回车用于确认候选词，不发送（keyCode 229 兼容部分浏览器）
    if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    if (canSend) onSend();
  };

  return (
    <div className={cx(styles.composer, hero && styles.hero)}>
      <div className={cx(styles.box, locked && styles.locked)}>
        <label htmlFor={inputId} className="sr-only">
          发送消息
        </label>
        <textarea
          id={inputId}
          ref={textareaRef}
          className={styles.input}
          rows={1}
          maxLength={12000}
          value={value}
          readOnly={locked}
          onChange={(event) => onChange(event.target.value)}
          onCompositionStart={() => { composing.current = true; }}
          onCompositionEnd={() => { composing.current = false; }}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
        />
        <div className={styles.toolbar}>
          <div className={styles.menuAnchor} ref={menuRef}>
            <button
              className={styles.tool}
              onClick={() => setMenuOpen((open) => !open)}
              aria-expanded={menuOpen}
              aria-haspopup="menu"
              aria-label="更多：带入练习题"
              title="带入练习题"
              disabled={generating || problems.length === 0}
            >
              <Plus size={17} aria-hidden />
            </button>
            {menuOpen && (
              <div className={styles.menu} role="menu">
                <p className={styles.menuLabel}>
                  <Dumbbell size={12} aria-hidden />
                  带入一道练习题
                </p>
                {problems.map((problem) => (
                  <button
                    key={problem.id}
                    role="menuitem"
                    className={styles.menuItem}
                    onClick={() => {
                      setMenuOpen(false);
                      onStartExercise(problem.id);
                    }}
                  >
                    <span>{problem.title}</span>
                    {problem.inputSequence && problem.outputSequence && (
                      <code>{problem.inputSequence.join("")} → {problem.outputSequence.join("")}</code>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
          {generating ? (
            <button className={cx(styles.send, styles.stop)} onClick={onStop} aria-label="停止生成" title="停止生成">
              <Square size={12} fill="currentColor" aria-hidden />
            </button>
          ) : (
            <button className={styles.send} onClick={onSend} disabled={!canSend} aria-label="发送" title="发送">
              <ArrowUp size={16} aria-hidden />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

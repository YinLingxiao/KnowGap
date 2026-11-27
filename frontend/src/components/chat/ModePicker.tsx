"use client";

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Check, ChevronDown, FolderOpen, GraduationCap, Lightbulb, ListTodo, X } from "lucide-react";
import { useI18n } from "@/components/LanguageProvider";
import { CHAT_MODE_OPTIONS, type ChatMode } from "@/lib/chat/modes";
import { cx } from "@/lib/cx";
import styles from "./ModePicker.module.css";

interface ModePickerProps {
  value: ChatMode | null;
  onChange: (mode: ChatMode | null) => void;
  disabled?: boolean;
  /** At the right end of a toolbar: align the menu's right edge so it stays inside the window. */
  alignEnd?: boolean;
}

function ModeTriggerIcon() {
  return (
    <svg className={styles.icon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 4.5l3.5 6h-7l3.5-6z" />
      <rect x="4.5" y="13.5" width="5.5" height="5.5" rx="1.2" />
      <circle cx="16.75" cy="16.25" r="2.75" />
    </svg>
  );
}

function SolveIcon() {
  return (
    <svg className={styles.icon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 13.5h2.5l2.5 5.5 3.5-13h9.5" />
      <path d="M14.5 12.5l5 5" />
      <path d="M19.5 12.5l-5 5" />
    </svg>
  );
}

function PlanIcon() {
  return (
    <svg className={styles.icon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 6.5l6-2.5 6 2.5 6-2.5v13.5l-6 2.5-6-2.5-6 2.5V6.5z" />
      <path d="M9 4v13.5" />
      <path d="M15 6.5V20" />
    </svg>
  );
}

function ResearchIcon() {
  return (
    <svg className={styles.icon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h4.5" />
      <path d="M14 3v4a1 1 0 0 0 1 1h4" />
      <path d="M19 8v2.5" />
      <path d="M8 12h4" />
      <path d="M8 16h2" />
      <circle cx="16.5" cy="16.5" r="3" />
      <path d="M18.8 18.8L21 21" />
    </svg>
  );
}

const MODE_ICONS: Record<ChatMode, ReactNode> = {
  explain: <Lightbulb size={15} strokeWidth={1.75} className={styles.icon} aria-hidden />,
  solve: <SolveIcon />,
  practice: <ListTodo size={15} strokeWidth={1.75} className={styles.icon} aria-hidden />,
  plan: <PlanIcon />,
  research: <ResearchIcon />,
  organize: <FolderOpen size={15} strokeWidth={1.75} className={styles.icon} aria-hidden />,
  review: <GraduationCap size={15} strokeWidth={1.75} className={styles.icon} aria-hidden />,
};

export function ModePicker({ value, onChange, disabled = false, alignEnd = false }: ModePickerProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [down, setDown] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  // Decide the direction when opening: down only if there is no room above and more room below.
  const toggle = () => {
    if (!open && anchorRef.current && typeof window !== "undefined") {
      const rect = anchorRef.current.getBoundingClientRect();
      setDown(rect.top < 300 && window.innerHeight - rect.bottom > rect.top);
    }
    setOpen(!open);
  };

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!anchorRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      anchorRef.current?.querySelector<HTMLButtonElement>("button[aria-haspopup]")?.focus();
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const activeOption = value ? CHAT_MODE_OPTIONS.find((option) => option.id === value) ?? null : null;
  const shortLabel = t("chat.mode.short");
  const clearLabel = t("chat.mode.clear");

  return (
    <div className={styles.anchor} ref={anchorRef}>
      {activeOption ? (
        <span key={activeOption.id} className={cx(styles.activePill, open && styles.activePillOpen)}>
          <button
            type="button"
            className={styles.activeMain}
            aria-expanded={open}
            aria-haspopup="menu"
            aria-label={t("chat.mode.label")}
            disabled={disabled}
            onMouseDown={(event) => event.preventDefault()}
            onClick={toggle}
          >
            {MODE_ICONS[activeOption.id]}
            <span>{t(activeOption.labelKey)}</span>
            <ChevronDown size={12} className={cx(styles.chevron, open && styles.chevronOpen)} aria-hidden />
          </button>
          <button
            type="button"
            className={styles.clearBtn}
            aria-label={clearLabel}
            title={clearLabel}
            disabled={disabled}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              setOpen(false);
              onChange(null);
            }}
          >
            <X size={12} aria-hidden />
          </button>
        </span>
      ) : (
        <button
          type="button"
          className={styles.trigger}
          aria-expanded={open}
          aria-haspopup="menu"
          aria-label={t("chat.mode.label")}
          disabled={disabled}
          onMouseDown={(event) => event.preventDefault()}
          onClick={toggle}
        >
          <ModeTriggerIcon />
          <span>{shortLabel}</span>
          <ChevronDown size={12} className={cx(styles.chevron, open && styles.chevronOpen)} aria-hidden />
        </button>
      )}

      {open && !disabled && (
        <div className={cx(styles.menu, alignEnd && styles.menuEnd, down && styles.menuDown)} role="menu" aria-label={t("chat.mode.label")}>
          {CHAT_MODE_OPTIONS.map((option, index) => {
            const selected = value === option.id;
            return (
              <button
                key={option.id}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                className={cx(styles.menuItem, selected && styles.menuItemOn)}
                style={{ "--item-index": index } as CSSProperties}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  onChange(selected ? null : option.id);
                  setOpen(false);
                }}
              >
                <span className={styles.menuItemLeft}>
                  {MODE_ICONS[option.id]}
                  <span>{t(option.labelKey)}</span>
                </span>
                {selected && <Check size={13} className={styles.menuCheck} aria-hidden />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

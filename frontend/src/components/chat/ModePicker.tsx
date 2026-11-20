"use client";

import type { ReactNode } from "react";
import { FolderOpen, Lightbulb, ListTodo } from "lucide-react";
import { useI18n } from "@/components/LanguageProvider";
import { CHAT_MODE_OPTIONS, type ChatMode } from "@/lib/chat/modes";
import { cx } from "@/lib/cx";
import styles from "./ModePicker.module.css";

interface ModePickerProps {
  value: ChatMode | null;
  onChange: (mode: ChatMode | null) => void;
  hero?: boolean;
  disabled?: boolean;
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
};

export function ModePicker({ value, onChange, hero = false, disabled = false }: ModePickerProps) {
  const { t } = useI18n();
  return (
    <div className={cx(styles.bar, hero && styles.heroBar)} role="group" aria-label={t("chat.mode.label")}>
      {CHAT_MODE_OPTIONS.map((option) => {
        const selected = value === option.id;
        return (
          <button
            key={option.id}
            type="button"
            className={cx(styles.chip, hero && styles.heroChip, selected && styles.chipOn)}
            aria-pressed={selected}
            disabled={disabled}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onChange(selected ? null : option.id)}
          >
            {MODE_ICONS[option.id]}
            <span>{t(option.labelKey)}</span>
          </button>
        );
      })}
    </div>
  );
}

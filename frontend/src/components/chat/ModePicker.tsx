"use client";

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
            className={cx(styles.chip, selected && styles.chipOn)}
            aria-pressed={selected}
            disabled={disabled}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onChange(selected ? null : option.id)}
          >
            {t(option.labelKey)}
          </button>
        );
      })}
    </div>
  );
}
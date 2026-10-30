"use client";

import { useEffect, useRef, useState } from "react";
import { SlidersHorizontal } from "lucide-react";
import { useI18n } from "@/components/LanguageProvider";
import { cx } from "@/lib/cx";
import {
  DEFAULT_VIEW_OPTIONS,
  type AgendaGroupBy, type AgendaSortBy, type AgendaViewOptions,
} from "./agendaModel";
import styles from "./ViewOptions.module.css";

const KEY = "knowgap.agenda.viewopts.v1";

export function loadViewOptions(view: string): AgendaViewOptions {
  try {
    const all = JSON.parse(localStorage.getItem(KEY) || "{}") as Record<string, Partial<AgendaViewOptions>>;
    const raw = all[view] ?? {};
    const groupBy: AgendaGroupBy = raw.groupBy === "space" || raw.groupBy === "priority" || raw.groupBy === "date" ? raw.groupBy : "none";
    const sortBy: AgendaSortBy = raw.sortBy === "date" || raw.sortBy === "priority" ? raw.sortBy : "manual";
    return { showCompleted: raw.showCompleted === true, groupBy, sortBy };
  } catch {
    return { ...DEFAULT_VIEW_OPTIONS };
  }
}

export function saveViewOptions(view: string, options: AgendaViewOptions) {
  try {
    const all = JSON.parse(localStorage.getItem(KEY) || "{}") as Record<string, AgendaViewOptions>;
    all[view] = options;
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch { /* 存储不可用时只影响本次会话 */ }
}

const GROUPS: { value: AgendaGroupBy; label: string }[] = [
  { value: "none", label: "无" },
  { value: "space", label: "学习空间" },
  { value: "priority", label: "优先级" },
  { value: "date", label: "日期" },
];

const SORTS: { value: AgendaSortBy; label: string }[] = [
  { value: "manual", label: "默认" },
  { value: "date", label: "日期" },
  { value: "priority", label: "优先级" },
];

export function ViewOptions({ value, week, onChange }: {
  value: AgendaViewOptions;
  week?: boolean;
  onChange: (next: AgendaViewOptions) => void;
}) {
  const { tx } = useI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className={styles.anchor} ref={ref}>
      <button
        type="button"
        className={styles.btn}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={tx("布局")}
        title={tx("布局")}
        onClick={() => setOpen((current) => !current)}
      >
        <SlidersHorizontal size={13} aria-hidden />
        {tx("布局")}
      </button>
      {open && (
        <div className={styles.pop} role="dialog" aria-label={tx("视图选项")}>
          <label className={styles.row}>
            <span>{tx("显示已完成")}</span>
            <input
              type="checkbox"
              role="switch"
              checked={value.showCompleted}
              onChange={(event) => onChange({ ...value, showCompleted: event.target.checked })}
            />
          </label>
          <fieldset className={styles.field} disabled={week}>
            <legend>{tx("分组")}</legend>
            <div className={styles.choices}>
              {GROUPS.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  className={cx(styles.choice, value.groupBy === item.value && styles.on)}
                  aria-pressed={value.groupBy === item.value}
                  onClick={() => onChange({ ...value, groupBy: item.value })}
                >
                  {tx(item.label)}
                </button>
              ))}
            </div>
          </fieldset>
          <fieldset className={styles.field} disabled={week}>
            <legend>{tx("排序")}</legend>
            <div className={styles.choices}>
              {SORTS.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  className={cx(styles.choice, value.sortBy === item.value && styles.on)}
                  aria-pressed={value.sortBy === item.value}
                  onClick={() => onChange({ ...value, sortBy: item.value })}
                >
                  {tx(item.label)}
                </button>
              ))}
            </div>
          </fieldset>
          {week && <p className={styles.note}>{tx("周历按时间格排列，分组和排序不适用。")}</p>}
        </div>
      )}
    </div>
  );
}

"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useI18n } from "@/components/LanguageProvider";
import { formatYmd } from "@/lib/agenda/quickAdd";
import { cx } from "@/lib/cx";
import { addDays, dateWord, monthDay, weekdayOf, weekendOf } from "./agendaModel";
import styles from "./DatePicker.module.css";

interface DatePickerProps {
  value: string | null;
  onChange: (value: string | null) => void;
  ariaLabel: string;
  today?: string;
  disabled?: boolean;
}

export function DatePicker({ value, onChange, ariaLabel, today, disabled }: DatePickerProps) {
  const { tx } = useI18n();
  const day = today || formatYmd(new Date());
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(() => (value ?? day).slice(0, 7));
  const anchor = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: 0, top: 0 });

  useEffect(() => { if (value) setCursor(value.slice(0, 7)); }, [value]);

  useLayoutEffect(() => {
    if (!open || !anchor.current || !pop.current) return;
    const rect = anchor.current.getBoundingClientRect();
    const box = pop.current.getBoundingClientRect();
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - box.width - 8));
    const top = rect.bottom + 4 + box.height > window.innerHeight - 8 ? Math.max(8, rect.top - box.height - 4) : rect.bottom + 4;
    setPos({ left, top });
  }, [open, cursor]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!anchor.current?.contains(target) && !pop.current?.contains(target)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pick = (next: string | null) => {
    onChange(next);
    setOpen(false);
  };
  const shortcuts = [
    { label: tx("今天"), date: day },
    { label: tx("明天"), date: addDays(day, 1) },
    { label: tx("本周末"), date: weekendOf(day) },
    { label: tx("下周"), date: addDays(day, 7) },
  ];

  return (
    <>
      <button
        ref={anchor}
        type="button"
        className={styles.trigger}
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        {value ? dateWord(value, day, tx) : tx("选择日期")}
      </button>
      {open && createPortal(
        <div ref={pop} className={styles.pop} style={pos} role="dialog" aria-label={ariaLabel}>
          <div className={styles.shortcuts}>
            {shortcuts.map((item) => (
              <button key={item.label} type="button" className={cx(styles.shortcut, value === item.date && styles.on)} onClick={() => pick(item.date)}>
                {item.label}
              </button>
            ))}
            <button type="button" className={cx(styles.shortcut, !value && styles.on)} onClick={() => pick(null)}>{tx("无日期")}</button>
          </div>
          <Month cursor={cursor} value={value} today={day} onCursor={setCursor} onPick={pick} />
        </div>,
        document.body,
      )}
    </>
  );
}

function Month({ cursor, value, today, onCursor, onPick }: {
  cursor: string;
  value: string | null;
  today: string;
  onCursor: (next: string) => void;
  onPick: (day: string) => void;
}) {
  const { tx } = useI18n();
  const year = Number(cursor.slice(0, 4));
  const month = Number(cursor.slice(5, 7));
  const shift = (delta: number) => {
    const date = new Date(Date.UTC(year, month - 1 + delta, 1));
    onCursor(`${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`);
  };
  const first = (new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 6) % 7;
  const count = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const cells: (string | null)[] = [...Array(first).fill(null)];
  for (let day = 1; day <= count; day += 1) {
    cells.push(`${cursor}-${String(day).padStart(2, "0")}`);
  }
  while (cells.length % 7) cells.push(null);

  return (
    <div className={styles.month}>
      <div className={styles.monthHead}>
        <button type="button" aria-label={tx("上个月")} onClick={() => shift(-1)}><ChevronLeft size={14} /></button>
        <strong>{tx("{year}年{month}月", { year, month })}</strong>
        <button type="button" aria-label={tx("下个月")} onClick={() => shift(1)}><ChevronRight size={14} /></button>
      </div>
      <div className={styles.week} aria-hidden>
        {["一", "二", "三", "四", "五", "六", "日"].map((name) => <span key={name}>{tx(`周${name}`)}</span>)}
      </div>
      <div className={styles.grid}>
        {cells.map((day, index) => day ? (
          <button
            key={day}
            type="button"
            className={cx(styles.day, day === today && styles.today, day === value && styles.picked)}
            aria-label={`${monthDay(day, tx)} ${weekdayOf(day, tx)}`}
            aria-pressed={day === value}
            onClick={() => onPick(day)}
          >
            {Number(day.slice(8))}
          </button>
        ) : <span key={`e${index}`} />)}
      </div>
    </div>
  );
}

export function SelectMenu({ label, value, placeholder, options, onChange }: {
  label: string;
  value: string;
  placeholder: string;
  options: { value: string; label: string; color?: string }[];
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: 0, top: 0 });
  const current = options.find((item) => item.value === value);

  useLayoutEffect(() => {
    if (!open || !anchor.current || !pop.current) return;
    const rect = anchor.current.getBoundingClientRect();
    const box = pop.current.getBoundingClientRect();
    setPos({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - box.width - 8)),
      top: rect.bottom + 4 + box.height > window.innerHeight - 8 ? Math.max(8, rect.top - box.height - 4) : rect.bottom + 4,
    });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!anchor.current?.contains(target) && !pop.current?.contains(target)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <>
      <button
        ref={anchor}
        type="button"
        className={styles.trigger}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((currentOpen) => !currentOpen)}
      >
        {current?.color && <span className={styles.dot} style={{ background: current.color }} aria-hidden />}
        <span>{current?.label ?? placeholder}</span>
      </button>
      {open && createPortal(
        <div ref={pop} className={styles.list} style={{ ...pos, width: anchor.current?.offsetWidth }} role="listbox" aria-label={label}>
          <button type="button" role="option" aria-selected={!value} className={cx(styles.option, !value && styles.on)} onClick={() => { onChange(""); setOpen(false); }}>
            {placeholder}
          </button>
          {options.map((item) => (
            <button
              key={item.value}
              type="button"
              role="option"
              aria-selected={item.value === value}
              className={cx(styles.option, item.value === value && styles.on)}
              onClick={() => { onChange(item.value); setOpen(false); }}
            >
              {item.color && <span className={styles.dot} style={{ background: item.color }} aria-hidden />}
              {item.label}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}

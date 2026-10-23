"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Plus } from "lucide-react";
import type { Subject } from "@/lib/chat/types";
import styles from "./SubjectPicker.module.css";

interface SubjectPickerProps {
  subjects: Subject[];
  value: string | null;
  onChange: (subjectId: string | null) => void;
  onCreate: () => void;
}

/** 首页输入框下方：选择新对话归入哪个 Subject */
export function SubjectPicker({ subjects, value, onChange, onCreate }: SubjectPickerProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = subjects.find((subject) => subject.id === value) ?? null;

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pick = (id: string | null) => {
    onChange(id);
    setOpen(false);
  };

  return (
    <div className={styles.anchor} ref={ref}>
      <button className={styles.trigger} onClick={() => setOpen((state) => !state)} aria-haspopup="listbox" aria-expanded={open}>
        {current && <span className={styles.dot} style={{ background: current.color }} />}
        {current ? current.name : "学习空间"}
        <ChevronDown size={13} aria-hidden />
      </button>
      {open && (
        <div className={styles.menu} role="listbox" aria-label="发送到哪个学习空间">
          <button role="option" aria-selected={value === null} className={styles.option} onClick={() => pick(null)}>
            <span>不放入学习空间</span>
            {value === null && <Check size={14} aria-hidden />}
          </button>
          {subjects.map((subject) => (
            <button
              key={subject.id}
              role="option"
              aria-selected={value === subject.id}
              className={styles.option}
              onClick={() => pick(subject.id)}
            >
              <span className={styles.optionName}>
                <i style={{ background: subject.color }} />
                {subject.name}
              </span>
              {value === subject.id && <Check size={14} aria-hidden />}
            </button>
          ))}
          <div className={styles.divider} />
          <button className={styles.option} onClick={() => { setOpen(false); onCreate(); }}>
            <span className={styles.create}>
              <Plus size={13} aria-hidden />
              新建学习空间
            </span>
          </button>
        </div>
      )}
    </div>
  );
}

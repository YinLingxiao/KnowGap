"use client";

import { useEffect, useRef, useState } from "react";
import { Upload, X } from "lucide-react";
import { SPACE_COLORS, LEVELS } from "@/lib/chat/space";
import type { Level, SpaceInput, Subject } from "@/lib/chat/types";
import { Button } from "../ui/Button";
import styles from "./CreateSpaceDialog.module.css";

interface CreateSpaceDialogProps {
  subject?: Subject | null;
  onClose: () => void;
  onCreate: (input: SpaceInput & { name: string }, files: File[]) => Promise<boolean>;
  onUpdate: (id: string, input: SpaceInput) => Promise<boolean>;
}

export function CreateSpaceDialog({ subject, onClose, onCreate, onUpdate }: CreateSpaceDialogProps) {
  const editing = Boolean(subject);
  const [name, setName] = useState(subject?.name ?? "");
  const [goal, setGoal] = useState(subject?.goal ?? "");
  const [level, setLevel] = useState<Level | null>(subject?.level ?? null);
  const [deadline, setDeadline] = useState(subject?.deadline ?? "");
  const [color, setColor] = useState(subject?.color || SPACE_COLORS[0]);
  const [files, setFiles] = useState<File[]>([]);
  const [working, setWorking] = useState(false);
  const [over, setOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const cycleColor = () => {
    const index = SPACE_COLORS.indexOf(color);
    setColor(SPACE_COLORS[(index + 1) % SPACE_COLORS.length]);
  };

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    setFiles((current) => [...current, ...Array.from(list)]);
  };

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed || working) return;
    setWorking(true);
    const input = {
      name: trimmed.slice(0, 40),
      goal: goal.trim(),
      level,
      deadline: deadline || null,
      color,
    };
    const ok = editing && subject
      ? await onUpdate(subject.id, input)
      : await onCreate(input, files);
    setWorking(false);
    if (ok) onClose();
  };

  return (
    <div className={styles.backdrop} onMouseDown={onClose}>
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="space-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className={styles.head}>
          <h2 id="space-dialog-title">{editing ? "编辑学习空间" : "新建学习空间"}</h2>
          <button className={styles.close} onClick={onClose} aria-label="关闭">
            <X size={16} />
          </button>
        </header>
        <p className={styles.hint}>先说清想学会什么。AI 会在主对话协调，在右侧 Thread 中开始具体任务，并同步进展。</p>
        <label className={styles.nameRow}>
          <button type="button" className={styles.swatch} style={{ background: color }} onClick={cycleColor} aria-label="更换颜色" />
          <input
            ref={nameRef}
            value={name}
            maxLength={40}
            placeholder="名称，例如日语"
            aria-label="学习空间名称"
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className={styles.field}>
          <span>想学会什么</span>
          <textarea
            value={goal}
            maxLength={400}
            rows={3}
            placeholder="三个月后能用日语点餐和问路"
            onChange={(event) => setGoal(event.target.value)}
          />
        </label>
        <div className={styles.field}>
          <span>现在的基础</span>
          <div className={styles.levels} role="radiogroup" aria-label="现在的基础">
            {LEVELS.map((item) => (
              <button
                key={item.id}
                type="button"
                role="radio"
                aria-checked={level === item.id}
                className={level === item.id ? styles.levelOn : styles.level}
                onClick={() => setLevel(level === item.id ? null : item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
        <label className={styles.field}>
          <span>截止日期（可选）</span>
          <input type="date" value={deadline} onChange={(event) => setDeadline(event.target.value)} />
        </label>
        {!editing && (
          <div
            className={over ? styles.dropOn : styles.drop}
            onDragOver={(event) => { event.preventDefault(); setOver(true); }}
            onDragLeave={() => setOver(false)}
            onDrop={(event) => { event.preventDefault(); setOver(false); addFiles(event.dataTransfer.files); }}
          >
            <Upload size={14} aria-hidden />
            <button type="button" onClick={() => fileRef.current?.click()}>拖入资料，或点此选择</button>
            <span>PDF / TXT / Markdown，创建后上传</span>
            <input ref={fileRef} type="file" accept=".pdf,.txt,.md" multiple hidden onChange={(event) => addFiles(event.target.files)} />
            {files.length > 0 && <ul>{files.map((file) => <li key={file.name}>{file.name}</li>)}</ul>}
          </div>
        )}
        <footer className={styles.actions}>
          <Button onClick={onClose} disabled={working}>取消</Button>
          <Button variant="primary" onClick={() => void submit()} disabled={!name.trim()} loading={working}>
            {editing ? "保存" : "创建"}
          </Button>
        </footer>
      </div>
    </div>
  );
}

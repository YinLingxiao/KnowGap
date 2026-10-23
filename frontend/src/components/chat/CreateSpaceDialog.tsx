"use client";

import { useEffect, useRef, useState } from "react";
import { GraduationCap, Plus, X } from "lucide-react";
import { DOCUMENT_EXTENSIONS } from "@/lib/chat/attachments";
import { SPACE_COLORS, LEVELS } from "@/lib/chat/space";
import type { Level, SpaceInput, Subject } from "@/lib/chat/types";
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
  const [colorOpen, setColorOpen] = useState(false);
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

        <div className={styles.field}>
          <label className={styles.label} htmlFor="space-name-input">
            名称
          </label>
          <div className={styles.nameRow}>
            <div className={styles.colorAnchor}>
              <button
                type="button"
                className={styles.iconSwatch}
                style={{ color }}
                onClick={() => setColorOpen((v) => !v)}
                aria-label="更换图标颜色"
                title="更换颜色"
              >
                <GraduationCap size={15} />
              </button>
              {colorOpen && (
                <div className={styles.colorPopover}>
                  {SPACE_COLORS.map((item) => (
                    <button
                      key={item}
                      type="button"
                      className={color === item ? styles.dotOn : styles.dot}
                      style={{ background: item }}
                      onClick={() => {
                        setColor(item);
                        setColorOpen(false);
                      }}
                      aria-label={`颜色 ${item}`}
                    />
                  ))}
                </div>
              )}
            </div>
            <input
              id="space-name-input"
              ref={nameRef}
              value={name}
              maxLength={40}
              placeholder="例如：西班牙语学习、微积分、宏观经济学…"
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.nativeEvent.isComposing && name.trim()) {
                  event.preventDefault();
                  void submit();
                }
              }}
            />
          </div>
        </div>

        <label className={styles.field}>
          <span className={styles.label}>
            目标 <small className={styles.optional}>(可选)</small>
          </span>
          <textarea
            value={goal}
            maxLength={400}
            rows={3}
            placeholder="描述你想在这个空间达成的学习目标，或希望重点攻克的内容…"
            onChange={(event) => setGoal(event.target.value)}
          />
        </label>

        {!editing ? (
          <div className={styles.contextBox}>
            <div className={styles.contextHead}>
              <span className={styles.label}>
                资料 <small className={styles.optional}>(可选)</small>
              </span>
              <button
                type="button"
                className={styles.addFileBtn}
                onClick={() => fileRef.current?.click()}
                aria-label="添加资料文件"
                title="添加资料文件"
              >
                <Plus size={15} />
              </button>
            </div>
            <div
              className={over ? styles.dropOn : styles.drop}
              onClick={() => fileRef.current?.click()}
              onDragOver={(event) => { event.preventDefault(); setOver(true); }}
              onDragLeave={() => setOver(false)}
              onDrop={(event) => { event.preventDefault(); setOver(false); addFiles(event.dataTransfer.files); }}
            >
              <span>拖入 PDF、Word、PPT、Excel 或文本文件，或点击添加</span>
              <input ref={fileRef} type="file" accept={DOCUMENT_EXTENSIONS.join(",")} multiple hidden onChange={(event) => addFiles(event.target.files)} />
            </div>
            {files.length > 0 && (
              <ul className={styles.fileList}>
                {files.map((file) => <li key={file.name}>{file.name}</li>)}
              </ul>
            )}
          </div>
        ) : (
          <div className={styles.editExtra}>
            <div className={styles.levels} role="radiogroup" aria-label="当前基础">
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
            <input
              type="date"
              className={styles.dateInput}
              value={deadline}
              aria-label="截止日期"
              onChange={(event) => setDeadline(event.target.value)}
            />
          </div>
        )}

        <footer className={styles.actions}>
          <button type="button" className={styles.cancelBtn} onClick={onClose} disabled={working}>
            取消
          </button>
          <button
            type="button"
            className={styles.submitBtn}
            onClick={() => void submit()}
            disabled={!name.trim() || working}
          >
            {working ? "处理中…" : editing ? "保存" : "创建空间"}
          </button>
        </footer>
      </div>
    </div>
  );
}

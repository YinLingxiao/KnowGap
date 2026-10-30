"use client";

import { useEffect, useRef, useState } from "react";
import { GraduationCap, Plus, X } from "lucide-react";
import { useI18n } from "@/components/LanguageProvider";
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
  const { t } = useI18n();
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
          <h2 id="space-dialog-title">{editing ? t("createSpace.editTitle") : t("createSpace.newTitle")}</h2>
          <button className={styles.close} onClick={onClose} aria-label={t("common.close")}>
            <X size={16} />
          </button>
        </header>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="space-name-input">
            {t("createSpace.nameLabel")}
          </label>
          <div className={styles.nameRow}>
            <div className={styles.colorAnchor}>
              <button
                type="button"
                className={styles.iconSwatch}
                style={{ color }}
                onClick={() => setColorOpen((v) => !v)}
                aria-label={t("createSpace.colorAria")}
                title={t("createSpace.changeColor")}
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
              placeholder={t("createSpace.namePlaceholder")}
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
            {t("createSpace.goalLabel")} <small className={styles.optional}>{t("common.optional")}</small>
          </span>
          <textarea
            value={goal}
            maxLength={400}
            rows={3}
            placeholder={t("createSpace.goalPlaceholder")}
            onChange={(event) => setGoal(event.target.value)}
          />
        </label>

        {!editing ? (
          <div className={styles.contextBox}>
            <div className={styles.contextHead}>
              <span className={styles.label}>
                {t("createSpace.materials")} <small className={styles.optional}>{t("common.optional")}</small>
              </span>
              <button
                type="button"
                className={styles.addFileBtn}
                onClick={() => fileRef.current?.click()}
                aria-label={t("createSpace.addFile")}
                title={t("createSpace.addFile")}
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
              <span>{t("createSpace.dropFiles")}</span>
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
            <div className={styles.levels} role="radiogroup" aria-label={t("createSpace.levelLabel")}>
              {LEVELS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="radio"
                  aria-checked={level === item.id}
                  className={level === item.id ? styles.levelOn : styles.level}
                  onClick={() => setLevel(level === item.id ? null : item.id)}
                >
                  {t(item.labelKey)}
                </button>
              ))}
            </div>
            <input
              type="date"
              className={styles.dateInput}
              value={deadline}
              aria-label={t("createSpace.deadline")}
              onChange={(event) => setDeadline(event.target.value)}
            />
          </div>
        )}

        <footer className={styles.actions}>
          <button type="button" className={styles.cancelBtn} onClick={onClose} disabled={working}>
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className={styles.submitBtn}
            onClick={() => void submit()}
            disabled={!name.trim() || working}
          >
            {working ? t("common.processing") : editing ? t("common.save") : t("common.create")}
          </button>
        </footer>
      </div>
    </div>
  );
}

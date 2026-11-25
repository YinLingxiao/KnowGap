"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, RotateCcw, Search, X } from "lucide-react";
import { useI18n } from "@/components/LanguageProvider";
import { DOCUMENT_EXTENSIONS } from "@/lib/chat/attachments";
import { SPACE_COLORS } from "@/lib/chat/space";
import type { Level, SpaceInput, Subject } from "@/lib/chat/types";
import { cx } from "@/lib/cx";
import { DEFAULT_SPACE_ICON, SpaceIcon, filterSpaceIcons } from "./SpaceIcon";
import styles from "./CreateSpaceDialog.module.css";

interface CreateSpaceDialogProps {
  subject?: Subject | null;
  onClose: () => void;
  onCreate: (input: SpaceInput & { name: string }, files: File[]) => Promise<boolean>;
  onUpdate: (id: string, input: SpaceInput) => Promise<boolean>;
}

export function CreateSpaceDialog({ subject, onClose, onCreate, onUpdate }: CreateSpaceDialogProps) {
  const { t, tx } = useI18n();
  const editing = Boolean(subject);
  const [name, setName] = useState(subject?.name ?? "");
  const [goal, setGoal] = useState(subject?.goal ?? "");
  const [level] = useState<Level | null>(subject?.level ?? null);
  const [deadline, setDeadline] = useState(subject?.deadline ?? "");
  const [color, setColor] = useState(subject?.color || SPACE_COLORS[0]);
  const [icon, setIcon] = useState(subject?.icon || DEFAULT_SPACE_ICON);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [iconQuery, setIconQuery] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [working, setWorking] = useState(false);
  const [over, setOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const visibleIcons = useMemo(() => filterSpaceIcons(iconQuery), [iconQuery]);
  const isDefaultAppearance = icon === DEFAULT_SPACE_ICON && color === SPACE_COLORS[0];

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (pickerOpen) {
        event.stopPropagation();
        setPickerOpen(false);
      } else {
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, pickerOpen]);

  useEffect(() => {
    if (!pickerOpen) {
      setIconQuery("");
      return;
    }
    searchRef.current?.focus();
    const onDown = (event: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(event.target as Node)) {
        setPickerOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [pickerOpen]);

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
      icon,
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
        <nav className={styles.nav} aria-label={t("space.settings")}>
          <button
            type="button"
            className={cx(styles.navItem, styles.navItemActive)}
            aria-current="page"
          >
            {t("settings.tab.general")}
          </button>
        </nav>

        <div className={styles.main}>
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
            <div className={styles.colorAnchor} ref={pickerRef}>
              <button
                type="button"
                className={cx(styles.iconSwatch, pickerOpen && styles.iconSwatchOpen)}
                style={{ color }}
                onClick={() => setPickerOpen((v) => !v)}
                aria-expanded={pickerOpen}
                aria-haspopup="dialog"
                aria-label={tx("选择图标和颜色")}
                title={tx("选择图标和颜色")}
              >
                <span key={`${icon}-${color}`} className={styles.swatchGlyph}>
                  <SpaceIcon name={icon} size={15} />
                </span>
              </button>
              {pickerOpen && (
                <div className={styles.pickerPopover} role="dialog" aria-label={tx("图标与颜色选择器")}>
                  <div className={styles.pickerSearch}>
                    <Search size={13} aria-hidden />
                    <input
                      ref={searchRef}
                      type="text"
                      value={iconQuery}
                      placeholder={tx("搜索图标…")}
                      aria-label={tx("搜索图标")}
                      onChange={(event) => setIconQuery(event.target.value)}
                    />
                    {iconQuery && (
                      <button
                        type="button"
                        className={styles.searchClear}
                        aria-label={tx("清空搜索")}
                        onClick={() => { setIconQuery(""); searchRef.current?.focus(); }}
                      >
                        <X size={12} aria-hidden />
                      </button>
                    )}
                  </div>

                  <div className={styles.colorRow} role="radiogroup" aria-label={t("createSpace.colorAria")}>
                    {SPACE_COLORS.map((item) => (
                      <button
                        key={item}
                        type="button"
                        role="radio"
                        aria-checked={color === item}
                        className={color === item ? styles.dotOn : styles.dot}
                        style={{ background: item }}
                        onClick={() => setColor(item)}
                        aria-label={`颜色 ${item}`}
                      />
                    ))}
                  </div>

                  {visibleIcons.length === 0 ? (
                    <p className={styles.pickerEmpty}>{tx("没有匹配的图标")}</p>
                  ) : (
                    <div className={styles.iconGrid} role="listbox" aria-label={tx("可选图标")}>
                      {visibleIcons.map((entry) => {
                        const active = icon === entry.id;
                        const IconComp = entry.icon;
                        return (
                          <button
                            key={entry.id}
                            type="button"
                            role="option"
                            aria-selected={active}
                            className={cx(styles.iconCell, active && styles.iconCellActive)}
                            style={active ? { color } : undefined}
                            title={tx(entry.label)}
                            aria-label={tx(entry.label)}
                            onClick={() => setIcon(entry.id)}
                          >
                            <IconComp size={15} aria-hidden />
                          </button>
                        );
                      })}
                    </div>
                  )}

                  <div className={styles.pickerFoot}>
                    <button
                      type="button"
                      className={styles.resetBtn}
                      disabled={isDefaultAppearance}
                      onClick={() => {
                        setIcon(DEFAULT_SPACE_ICON);
                        setColor(SPACE_COLORS[0]);
                      }}
                    >
                      <RotateCcw size={12} aria-hidden />
                      <span>{tx("重置图标与颜色")}</span>
                    </button>
                  </div>
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
    </div>
  );
}

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FileSpreadsheet, FileText, FileType, Plus, Presentation, RotateCcw, Search, X } from "lucide-react";
import { useI18n } from "@/components/LanguageProvider";
import { DOCUMENT_EXTENSIONS, MAX_UPLOAD_BYTES } from "@/lib/chat/attachments";
import { kindFromFilename, type MaterialKind } from "@/lib/materials/kinds";
import { sameFile, sizeText, splitName } from "@/lib/materials/uploads";
import { SPACE_COLORS } from "@/lib/chat/space";
import type { SpaceInput, Subject } from "@/lib/chat/types";
import { cx } from "@/lib/cx";
import { DEFAULT_SPACE_ICON, SpaceIcon, filterSpaceIcons } from "./SpaceIcon";
import styles from "./CreateSpaceDialog.module.css";

const PICKER_WIDTH = 276;
const PICKER_EDGE = 12;
const PICKER_GAP = 8;
const PICKER_ESTIMATED_HEIGHT = 320;

export interface PickerPosition {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
}

/** 按锚点与视口尺寸计算 fixed 弹层坐标：优先放下方，放不下翻到上方，水平与垂直都不超出视口。 */
export function computePickerPosition(
  anchor: { top: number; bottom: number; left: number },
  viewport: { width: number; height: number },
  popoverHeight = PICKER_ESTIMATED_HEIGHT,
): PickerPosition {
  const maxWidth = Math.max(0, viewport.width - PICKER_EDGE * 2);
  const width = Math.min(PICKER_WIDTH, maxWidth);
  const left = Math.max(PICKER_EDGE, Math.min(anchor.left - 6, viewport.width - PICKER_EDGE - width));
  const maxHeight = Math.max(120, viewport.height - PICKER_EDGE * 2);
  const height = Math.min(popoverHeight, maxHeight);
  const availBelow = viewport.height - anchor.bottom - PICKER_GAP - PICKER_EDGE;
  const availAbove = anchor.top - PICKER_GAP - PICKER_EDGE;
  let top: number;
  if (height <= availBelow) {
    top = anchor.bottom + PICKER_GAP;
  } else if (height <= availAbove) {
    top = anchor.top - PICKER_GAP - height;
  } else {
    top = Math.max(PICKER_EDGE, viewport.height - PICKER_EDGE - height);
  }
  return { top, left, width, maxHeight };
}

const FILE_ICONS: Record<MaterialKind, typeof FileText> = {
  pdf: FileType, docx: FileType, pptx: Presentation, xlsx: FileSpreadsheet, csv: FileSpreadsheet, md: FileText, txt: FileText,
};

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
  const [deadline, setDeadline] = useState(subject?.deadline ?? "");
  const [color, setColor] = useState(subject?.color || SPACE_COLORS[0]);
  const [icon, setIcon] = useState(subject?.icon || DEFAULT_SPACE_ICON);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerPos, setPickerPos] = useState<PickerPosition | null>(null);
  const [iconQuery, setIconQuery] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [rejected, setRejected] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [over, setOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const visibleIcons = useMemo(() => filterSpaceIcons(iconQuery), [iconQuery]);
  const isDefaultAppearance = icon === DEFAULT_SPACE_ICON && color === SPACE_COLORS[0];

  const updatePickerPosition = useCallback(() => {
    const anchor = pickerRef.current?.getBoundingClientRect();
    if (!anchor || typeof window === "undefined") return;
    const measuredHeight = popoverRef.current?.getBoundingClientRect().height || PICKER_ESTIMATED_HEIGHT;
    setPickerPos(computePickerPosition(anchor, { width: window.innerWidth, height: window.innerHeight }, measuredHeight));
  }, []);

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
      setPickerPos(null);
      return;
    }
    updatePickerPosition();
    searchRef.current?.focus();
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (pickerRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      setPickerOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("resize", updatePickerPosition);
    window.addEventListener("scroll", updatePickerPosition, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("resize", updatePickerPosition);
      window.removeEventListener("scroll", updatePickerPosition, true);
    };
  }, [pickerOpen, updatePickerPosition]);

  const addFiles = (list: FileList | null) => {
    if (!list?.length) return;
    const picked = Array.from(list);
    const unsupported = picked.filter((file) => !kindFromFilename(file.name));
    const tooLarge = picked.filter((file) => kindFromFilename(file.name) && file.size > MAX_UPLOAD_BYTES);
    const usable = picked.filter((file) => kindFromFilename(file.name) && file.size <= MAX_UPLOAD_BYTES);
    setFiles((current) => [...current, ...usable.filter((file) => !current.some((item) => sameFile(item, file)))]);
    setRejected(
      unsupported.length ? tx("「{name}」的格式不支持，已跳过。", { name: unsupported[0].name })
        : tooLarge.length ? tx("「{name}」超过 100 MB，已跳过。", { name: tooLarge[0].name })
          : null,
    );
  };
  const removeFile = (target: File) => {
    setFiles((current) => current.filter((file) => file !== target));
    setRejected(null);
  };

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed || working) return;
    setWorking(true);
    const input = {
      name: trimmed.slice(0, 40),
      goal: goal.trim(),
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

  const pickerPopover = pickerOpen ? (
    <div
      ref={popoverRef}
      className={styles.pickerPopover}
      role="dialog"
      aria-label={tx("图标与颜色选择器")}
      style={pickerPos ? {
        top: `${pickerPos.top}px`,
        left: `${pickerPos.left}px`,
        width: `${pickerPos.width}px`,
        maxHeight: `${pickerPos.maxHeight}px`,
      } : undefined}
      onMouseDown={(event) => event.stopPropagation()}
    >
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
  ) : null;

  return (
    <div className={styles.backdrop} onMouseDown={onClose}>
      <div
        className={cx(styles.dialog, editing && styles.dialogEdit)}
        role="dialog"
        aria-modal="true"
        aria-labelledby="space-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        {editing && (
          <nav className={styles.nav} aria-label={t("space.settings")}>
            <button
              type="button"
              className={cx(styles.navItem, styles.navItemActive)}
              aria-current="page"
            >
              {t("settings.tab.general")}
            </button>
          </nav>
        )}

        <div className={styles.main}>
          <header className={styles.head}>
            <h2 id="space-dialog-title">{editing ? t("space.settings") : t("createSpace.newTitle")}</h2>
            <button type="button" className={styles.close} onClick={onClose} aria-label={t("common.close")}>
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
                  onClick={() => {
                    if (!pickerOpen) updatePickerPosition();
                    setPickerOpen((v) => !v);
                  }}
                  aria-expanded={pickerOpen}
                  aria-haspopup="dialog"
                  aria-label={tx("选择图标和颜色")}
                  title={tx("选择图标和颜色")}
                >
                  <span key={`${icon}-${color}`} className={styles.swatchGlyph}>
                    <SpaceIcon name={icon} size={15} />
                  </span>
                </button>
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
                <input
                  ref={fileRef} type="file" accept={DOCUMENT_EXTENSIONS.join(",")} multiple hidden
                  onClick={(event) => event.stopPropagation()}
                  onChange={(event) => { addFiles(event.target.files); event.target.value = ""; }}
                />
              </div>
              {rejected && <p className={styles.fileRejected} role="alert">{rejected}</p>}
              {files.length > 0 && (
                <>
                  <ul className={styles.fileList} aria-label={tx("待上传的资料")}>
                    {files.map((file, index) => {
                      const Icon = FILE_ICONS[kindFromFilename(file.name) ?? "txt"];
                      return (
                        <li key={`${file.name}-${file.size}-${index}`} className={styles.fileRow}>
                          <Icon size={14} className={styles.fileIcon} aria-hidden />
                          <span className={styles.fileName} title={file.name}>
                            <span>{splitName(file.name)[0]}</span>
                            <span>{splitName(file.name)[1]}</span>
                          </span>
                          <span className={styles.fileSize}>{sizeText(file.size)}</span>
                          <button
                            type="button"
                            className={styles.fileRemove}
                            onClick={() => removeFile(file)}
                            aria-label={tx("移除 {name}", { name: file.name })}
                            title={tx("移除")}
                          >
                            <X size={13} aria-hidden />
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                  <p className={styles.fileHint}>
                    {tx("共 {count} 个文件。创建后在后台上传和解析，不用等它读完，进度在空间的「资料」里。", { count: files.length })}
                  </p>
                </>
              )}
            </div>
          ) : (
            <div className={styles.field}>
              <label className={styles.label} htmlFor="space-deadline-input">
                {t("createSpace.deadline")}
              </label>
              <div className={styles.editExtra}>
                <input
                  id="space-deadline-input"
                  type="date"
                  className={styles.dateInput}
                  value={deadline}
                  onChange={(event) => setDeadline(event.target.value)}
                />
              </div>
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
      {pickerPopover && (typeof document !== "undefined" ? createPortal(pickerPopover, document.body) : pickerPopover)}
    </div>
  );
}

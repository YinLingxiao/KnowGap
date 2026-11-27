"use client";

import { useEffect, useRef, useState } from "react";
import { FileSpreadsheet, FileText, FileType, Plus, Presentation, X } from "lucide-react";
import { useI18n } from "@/components/LanguageProvider";
import { DOCUMENT_EXTENSIONS, MAX_UPLOAD_BYTES } from "@/lib/chat/attachments";
import { kindFromFilename, type MaterialKind } from "@/lib/materials/kinds";
import { sameFile, sizeText, splitName } from "@/lib/materials/uploads";
import { SPACE_COLORS } from "@/lib/chat/space";
import type { SpaceInput } from "@/lib/chat/types";
import { DEFAULT_SPACE_ICON } from "./SpaceIcon";
import { SpaceAppearancePicker } from "./SpaceAppearancePicker";
import styles from "./CreateSpaceDialog.module.css";

const FILE_ICONS: Record<MaterialKind, typeof FileText> = {
  pdf: FileType, docx: FileType, pptx: Presentation, xlsx: FileSpreadsheet, csv: FileSpreadsheet, md: FileText, txt: FileText,
};

interface CreateSpaceDialogProps {
  onClose: () => void;
  onCreate: (input: SpaceInput & { name: string }, files: File[]) => Promise<boolean>;
}

/** 新建学习空间。改已有空间走 SpaceSettingsDialog。 */
export function CreateSpaceDialog({ onClose, onCreate }: CreateSpaceDialogProps) {
  const { t, tx } = useI18n();
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [appearance, setAppearance] = useState<{ icon: string; color: string }>({ icon: DEFAULT_SPACE_ICON, color: SPACE_COLORS[0] });
  const [files, setFiles] = useState<File[]>([]);
  const [rejected, setRejected] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [over, setOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

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
    const ok = await onCreate({
      name: trimmed.slice(0, 40),
      goal: goal.trim(),
      color: appearance.color,
      icon: appearance.icon,
    }, files);
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
          <h2 id="space-dialog-title">{t("createSpace.newTitle")}</h2>
          <button type="button" className={styles.close} onClick={onClose} aria-label={t("common.close")}>
            <X size={16} />
          </button>
        </header>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="space-name-input">
            {t("createSpace.nameLabel")}
          </label>
          <div className={styles.nameRow}>
            <SpaceAppearancePicker icon={appearance.icon} color={appearance.color} onChange={setAppearance} />
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
            {working ? t("common.processing") : t("common.create")}
          </button>
        </footer>
      </div>
    </div>
  );
}

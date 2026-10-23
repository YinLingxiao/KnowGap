"use client";

import { CircleAlert, FileSpreadsheet, FileText, FileType, Loader2, Presentation, X } from "lucide-react";
import type { AttachmentKind, FileAttachment } from "@/lib/chat/attachments";
import { USER_KEY } from "@/lib/api/auth";
import { API_BASE_URL } from "@/lib/config";
import { cx } from "@/lib/cx";
import styles from "./FileCard.module.css";

// 标记只保存 id / name；同一浏览器会话中保留解析规模，发送后和刷新后都能继续显示。
function metadataKey(id: string) {
  return `${localStorage.getItem(USER_KEY) ?? "anonymous"}:knowgap.file.v1:${API_BASE_URL}:${id}`;
}

export function rememberFile(file: FileAttachment) {
  try { sessionStorage.setItem(metadataKey(file.id), JSON.stringify(file)); } catch { /* 不影响发送 */ }
}

export function recalledFile(id: string): FileAttachment | undefined {
  try {
    const file = JSON.parse(sessionStorage.getItem(metadataKey(id)) ?? "null") as FileAttachment | null;
    if (file?.id === id && typeof file.name === "string" && Object.hasOwn(KIND_ICON, file.kind)
      && Number.isFinite(file.units) && file.units >= 0 && typeof file.unitLabel === "string") return file;
  } catch { /* 旧消息只有标记时只显示类型，不猜测规模 */ }
}

/** 复用 ChatApp / SubjectPage 已有的视图恢复协议；不引入不存在的资料路由。 */
export function openFileLibrary(subjectId: string | null) {
  const userId = localStorage.getItem(USER_KEY);
  if (!userId) throw new Error("请从侧栏打开通用资料，或在学习空间打开「课程资料」。");
  if (subjectId) {
    localStorage.setItem(`knowgap.space.panel.v1:${API_BASE_URL}:${subjectId}`, JSON.stringify({ mode: "info", section: "files" }));
  }
  localStorage.setItem(`${userId}:knowgap.chat.view.v1:${API_BASE_URL}`, JSON.stringify(
    subjectId ? { type: "subject", id: subjectId } : { type: "materials" },
  ));
  // 父组件目前未暴露导航回调；重新进入应用以恢复上述视图，不操作其 React 内部状态。
  window.location.assign("/");
}

export type FileCardState = "uploading" | "ready" | "error";

const KIND_LABEL: Record<AttachmentKind, string> = {
  pdf: "PDF", docx: "Word", pptx: "PPT", xlsx: "Excel", text: "文本",
};

const KIND_ICON = {
  pdf: FileText, docx: FileType, pptx: Presentation, xlsx: FileSpreadsheet, text: FileText,
} as const;

/** 消息里的标记只有文件名，按扩展名推断类型；上传中和失败时同理 */
export function kindFromName(name: string): AttachmentKind {
  const lower = name.toLowerCase();
  if (lower.endsWith(".pdf")) return "pdf";
  if (lower.endsWith(".docx") || lower.endsWith(".doc")) return "docx";
  if (lower.endsWith(".pptx") || lower.endsWith(".ppt")) return "pptx";
  if (lower.endsWith(".xlsx") || lower.endsWith(".xls")) return "xlsx";
  return "text";
}

/** 「24 张幻灯片」这类规模信息 */
export function scaleOf(attachment: Pick<FileAttachment, "units" | "unitLabel">): string {
  return attachment.units > 0 ? `${attachment.units} ${attachment.unitLabel}` : "";
}

interface FileCardProps {
  name: string;
  kind?: AttachmentKind;
  state?: FileCardState;
  /** 就绪后的规模信息；缺省时显示文件类型 */
  scale?: string;
  /** 失败原因（后端返回的中文说明） */
  error?: string;
  /** 读取说明：没读到的内容，鼠标停在规模信息上时显示，并以标记点提示 */
  notes?: string[];
  /** 给出时显示 × 移除按钮（输入框里的待发送附件） */
  onRemove?: () => void;
  /** 给出时整张卡片可点击（消息里的只读卡片） */
  onOpen?: () => void;
}

export function FileCard({ name, kind, state = "ready", scale, error, notes, onRemove, onOpen }: FileCardProps) {
  const resolved = kind ?? kindFromName(name);
  const Icon = state === "error" ? CircleAlert : KIND_ICON[resolved];
  const meta = state === "uploading" ? "正在上传并解析…" : state === "error" ? "" : scale || KIND_LABEL[resolved];
  const body = (
    <>
      <span className={styles.icon} aria-hidden>
        {state === "uploading" ? <Loader2 size={15} className={styles.spin} /> : <Icon size={15} />}
      </span>
      <span className={styles.text}>
        <span className={styles.name} title={name}>{name}</span>
        {state === "error" ? (
          <span className={styles.errorText} role="alert">{error || "上传失败"}</span>
        ) : (
          <span className={styles.meta} title={notes?.length ? notes.join("\n") : undefined}>
            {meta}
            {state === "ready" && notes && notes.length > 0 && (
              <span className={styles.noteDot} aria-label={`读取说明：${notes.join(" ")}`} role="note">没读到的内容</span>
            )}
            {state === "ready" && scale && <span className={styles.kind}>{KIND_LABEL[resolved]}</span>}
          </span>
        )}
      </span>
    </>
  );
  return (
    <div className={cx(styles.card, styles[state], onOpen && styles.openable)} role="listitem">
      {onOpen ? (
        <button type="button" className={styles.body} onClick={onOpen} title="在资料库中打开">
          {body}
        </button>
      ) : (
        <div className={styles.body}>{body}</div>
      )}
      {onRemove && (
        <button type="button" className={styles.remove} onClick={onRemove} aria-label={`移除 ${name}`} title="移除">
          <X size={13} aria-hidden />
        </button>
      )}
    </div>
  );
}

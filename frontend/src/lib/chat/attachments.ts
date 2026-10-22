/**
 * 对话文件附件：类型、上传 API、消息标记与快捷意图。接口约定见 docs/contracts/file-attachments.md。
 */
import { request } from "@/lib/api/http-client";
import { API_BASE_URL } from "@/lib/config";

/* eslint-disable @typescript-eslint/no-explicit-any -- wire payloads are mapped field by field below */
type Wire = any;

export type AttachmentKind = "pdf" | "docx" | "pptx" | "xlsx" | "text";

export interface FileAttachment {
  id: string;
  name: string;
  kind: AttachmentKind;
  units: number;
  unitLabel: string;
  chars: number;
  outline: string[];
  subjectId: string | null;
}

/** 文件选择器的 accept：图片仍走视觉上传，其余文档走附件上传 */
export const DOCUMENT_EXTENSIONS = [".pdf", ".docx", ".pptx", ".xlsx", ".txt", ".md", ".csv"] as const;
export const ATTACHMENT_ACCEPT = ["image/png", "image/jpeg", "image/webp", ...DOCUMENT_EXTENSIONS].join(",");
export const MAX_FILE_MARKERS = 5;

export function isDocumentFile(name: string): boolean {
  const lower = name.toLowerCase();
  return DOCUMENT_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

const KINDS = new Set<AttachmentKind>(["pdf", "docx", "pptx", "xlsx", "text"]);

export function mapAttachment(data: Wire): FileAttachment {
  return {
    id: String(data.id),
    name: String(data.name ?? ""),
    kind: KINDS.has(data.kind) ? data.kind : "text",
    units: typeof data.units === "number" ? data.units : 0,
    unitLabel: typeof data.unit_label === "string" ? data.unit_label : "页",
    chars: typeof data.chars === "number" ? data.chars : 0,
    outline: Array.isArray(data.outline) ? data.outline.filter((item: unknown) => typeof item === "string") : [],
    subjectId: typeof data.subject_id === "string" && data.subject_id ? data.subject_id : null,
  };
}

export const attachmentApi = {
  async upload(conversationId: string, file: File): Promise<FileAttachment> {
    const body = new FormData();
    body.append("file", file);
    return mapAttachment(await request<Wire>(
      API_BASE_URL, `/api/conversations/${encodeURIComponent(conversationId)}/attachments`,
      { method: "POST", body, timeoutMs: 120_000 },
    ));
  },
};

/** 消息正文最前面的附件标记：[[file:doc-…|文件名]]，一行一个 */
const MARKER_RE = /^\[\[file:([A-Za-z0-9_-]+)\|([^\]\n]{1,200})\]\]\s*$/;

export function formatFileMarker(attachment: Pick<FileAttachment, "id" | "name">): string {
  const safeName = attachment.name.replace(/[\]\n|]/g, " ").trim() || "附件";
  return `[[file:${attachment.id}|${safeName}]]`;
}

/** 拆出开头的附件标记与其余正文；标记只在开头连续出现时识别 */
export function parseFileMarkers(content: string): { files: Array<{ id: string; name: string }>; body: string } {
  const lines = content.split("\n");
  const files: Array<{ id: string; name: string }> = [];
  let index = 0;
  while (index < lines.length && files.length < MAX_FILE_MARKERS) {
    const match = MARKER_RE.exec(lines[index].trim());
    if (!match) break;
    files.push({ id: match[1], name: match[2] });
    index += 1;
  }
  return { files, body: lines.slice(index).join("\n").replace(/^\n+/, "") };
}

/** 上传成功后、发送前，在输入框上方给出的快捷意图 */
export interface FileIntent {
  id: "file_close_read" | "file_to_notes" | "file_check_work" | "file_data_explain";
  label: string;
  prompt: string;
}

const CLOSE_READ: FileIntent = { id: "file_close_read", label: "精读重点", prompt: "帮我精读这份材料，挑出重点和难点" };
const TO_NOTES: FileIntent = { id: "file_to_notes", label: "整理成笔记", prompt: "把这份材料整理成复习笔记" };
const CHECK_WORK: FileIntent = { id: "file_check_work", label: "检查作业", prompt: "帮我检查这份作业 / 试卷" };
const DATA_EXPLAIN: FileIntent = { id: "file_data_explain", label: "看懂表格", prompt: "帮我看懂这张表格" };

export function intentsFor(kind: AttachmentKind, name: string): FileIntent[] {
  if (kind === "xlsx" || name.toLowerCase().endsWith(".csv")) return [DATA_EXPLAIN, CLOSE_READ];
  return [CLOSE_READ, TO_NOTES, CHECK_WORK];
}

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
  /** 读取说明：哪些内容没有读到（图片里的字、隐藏页、扫描页……） */
  notes: string[];
}

/** 文件选择器的 accept：图片仍走视觉上传，其余文档走附件上传 */
export const DOCUMENT_EXTENSIONS = [".pdf", ".docx", ".doc", ".pptx", ".ppt", ".xlsx", ".xls", ".txt", ".md", ".csv"] as const;
const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp"] as const;
/**
 * 备用文件选择器的 accept。只写扩展名：混进 image/png 这类 MIME 类型后，Chromium 的文件对话框
 * 会把它们拆成各自的分组，默认只显示第一个分组（PNG），pptx / docx 要手动切换才看得到。
 */
export const ATTACHMENT_ACCEPT = [...DOCUMENT_EXTENSIONS, ...IMAGE_EXTENSIONS].join(",");

const PICKER_TYPES = [{
  description: "文档与图片",
  accept: {
    "application/pdf": [".pdf"],
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
    "application/msword": [".doc"],
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": [".pptx"],
    "application/vnd.ms-powerpoint": [".ppt"],
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
    "application/vnd.ms-excel": [".xls"],
    "text/csv": [".csv"],
    "text/plain": [".txt"],
    "text/markdown": [".md"],
    "image/png": [".png"],
    "image/jpeg": [".jpg", ".jpeg"],
    "image/webp": [".webp"],
  },
}];

type OpenFilePicker = (options: {
  multiple: boolean; id: string; startIn: string; types: typeof PICKER_TYPES;
}) => Promise<Array<{ getFile: () => Promise<File> }>>;

/**
 * 弹出系统的文件选择对话框，所有支持的格式放在同一个默认分组里。
 * 返回 null 表示这个环境没有该接口，调用方改用隐藏的 <input type="file">；用户取消返回空数组。
 */
export async function pickAttachmentFiles(): Promise<File[] | null> {
  const open = (window as unknown as { showOpenFilePicker?: OpenFilePicker }).showOpenFilePicker;
  if (typeof open !== "function") return null;
  try {
    const handles = await open.call(window, { multiple: true, id: "knowgap-attachments", startIn: "documents", types: PICKER_TYPES });
    return await Promise.all(handles.map((handle) => handle.getFile()));
  } catch (failure) {
    if (failure instanceof DOMException && failure.name === "AbortError") return [];
    return null;
  }
}
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
    notes: Array.isArray(data.notes) ? data.notes.filter((item: unknown) => typeof item === "string") : [],
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
  id: "file_close_read" | "file_summary" | "file_to_notes" | "file_quiz" | "file_check_work" | "file_data_explain" | "file_edit";
  label: string;
  prompt: string;
}

const CLOSE_READ: FileIntent = { id: "file_close_read", label: "精读重点", prompt: "帮我精读这份材料，挑出重点和难点" };
const SUMMARY: FileIntent = { id: "file_summary", label: "概括全文", prompt: "这份材料讲了什么？帮我概括一下结构和要点" };
const QUIZ: FileIntent = { id: "file_quiz", label: "出题自测", prompt: "根据这份材料出题考考我" };
const TO_NOTES: FileIntent = { id: "file_to_notes", label: "整理成笔记", prompt: "把这份材料整理成复习笔记" };
const CHECK_WORK: FileIntent = { id: "file_check_work", label: "检查作业", prompt: "帮我检查这份作业 / 试卷" };
const EDIT: FileIntent = { id: "file_edit", label: "按要求修改", prompt: "请按下面的要求修改这份文件，改好后另存给我：\n" };
const DATA_EXPLAIN: FileIntent = { id: "file_data_explain", label: "看懂表格", prompt: "帮我看懂这张表格" };

export function intentsFor(kind: AttachmentKind, name: string): FileIntent[] {
  const lower = name.toLowerCase();
  // 旧版 .doc / .ppt / .xls 和 PDF 不能原地修改（AI 只能读出来重新生成），所以不给「按要求修改」
  const editable = /\.(docx|pptx|xlsx)$/.test(lower);
  if (kind === "xlsx" || lower.endsWith(".csv")) return editable ? [DATA_EXPLAIN, CLOSE_READ, EDIT] : [DATA_EXPLAIN, CLOSE_READ];
  return editable ? [CLOSE_READ, SUMMARY, TO_NOTES, QUIZ, CHECK_WORK, EDIT] : [CLOSE_READ, SUMMARY, TO_NOTES, QUIZ, CHECK_WORK];
}

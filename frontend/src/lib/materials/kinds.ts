/**
 * 资料库的文件类型归档规则。
 *
 * 上传时按扩展名决定资料归到哪个类型（Word / PowerPoint / Excel / PDF / 文本），
 * 旧版 .doc / .ppt / .xls 和新版归到同一类，和 backend/app/services/materials.py 的
 * LEGACY_KINDS 保持一致。放在独立模块里，方便单测直接验证后缀映射。
 */
import type { CourseMaterial } from "@/lib/types";

export type MaterialKind = CourseMaterial["kind"];

/** 扩展名 → 归档类型。这里是上传入口和后端共同接受的格式，不要单独放宽。 */
const EXTENSION_KINDS: Record<string, MaterialKind> = {
  pdf: "pdf",
  md: "md",
  txt: "txt",
  csv: "csv",
  docx: "docx",
  doc: "docx",
  pptx: "pptx",
  ppt: "pptx",
  xlsx: "xlsx",
  xls: "xlsx",
};

/** 卡片、筛选胶囊和上传提示共用的类型名（直接交给 tx() 翻译）。 */
export const KIND_LABELS: Record<MaterialKind, string> = {
  pdf: "PDF 文件",
  md: "Markdown",
  txt: "纯文本",
  csv: "CSV",
  docx: "Word",
  pptx: "PowerPoint",
  xlsx: "Excel",
};

/** 文件名的小写扩展名（不带点）；没有扩展名时返回空串。 */
export function fileExtension(name: string): string {
  const match = /\.([a-z0-9]+)\s*$/i.exec(name);
  return match ? match[1].toLowerCase() : "";
}

/** 按扩展名归档；不认识的后缀返回 null，由调用方提示支持的格式。 */
export function kindFromFilename(name: string): MaterialKind | null {
  return EXTENSION_KINDS[fileExtension(name)] ?? null;
}

/** 后端返回的 kind 是否是我们认识的资料类型（旧版本数据可能缺字段）。 */
export function isMaterialKind(value: unknown): value is MaterialKind {
  return typeof value === "string" && value in KIND_LABELS;
}

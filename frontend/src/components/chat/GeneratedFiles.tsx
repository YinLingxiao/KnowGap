"use client";

import { useState } from "react";
import { CircleAlert, Download, FileSpreadsheet, FileText, FileType, Loader2, Presentation } from "lucide-react";
import { chatApi } from "@/lib/chat/api";
import type { GeneratedFile } from "@/lib/chat/types";
import styles from "./GeneratedFiles.module.css";

const ICON = { docx: FileType, pptx: Presentation, xlsx: FileSpreadsheet, pdf: FileText, md: FileText } as const;
const LABEL: Record<string, string> = { docx: "Word", pptx: "PPT", xlsx: "Excel", pdf: "PDF", md: "Markdown" };

export function sizeText(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B`;
}

/** AI 生成或修改出来的文件：点一下下载到本机 */
export function GeneratedFiles({ files }: { files: GeneratedFile[] }) {
  const [state, setState] = useState<Record<string, "busy" | string>>({});

  async function download(file: GeneratedFile) {
    setState((all) => ({ ...all, [file.id]: "busy" }));
    try {
      await chatApi.downloadFile(file);
      setState((all) => Object.fromEntries(Object.entries(all).filter(([id]) => id !== file.id)));
    } catch (failure) {
      setState((all) => ({ ...all, [file.id]: failure instanceof Error ? failure.message : "下载失败" }));
    }
  }

  return (
    <div className={styles.list} role="list" aria-label="生成的文件">
      {files.map((file) => {
        const Icon = ICON[file.kind as keyof typeof ICON] ?? FileText;
        const status = state[file.id];
        const failed = status !== undefined && status !== "busy";
        return (
          <button
            key={file.id} type="button" role="listitem" className={styles.card}
            disabled={status === "busy"} onClick={() => void download(file)}
            title={`下载 ${file.name}`}
          >
            <span className={styles.icon} aria-hidden>
              {failed ? <CircleAlert size={16} /> : <Icon size={16} />}
            </span>
            <span className={styles.text}>
              <span className={styles.name}>{file.name}</span>
              <span className={failed ? styles.error : styles.meta} role={failed ? "alert" : undefined}>
                {failed ? status : `${LABEL[file.kind] ?? file.kind.toUpperCase()} · ${sizeText(file.size)}`}
              </span>
            </span>
            <span className={styles.action} aria-hidden>
              {status === "busy" ? <Loader2 size={14} className={styles.spin} /> : <Download size={14} />}
            </span>
          </button>
        );
      })}
    </div>
  );
}

import type { SourceReference } from "@/lib/types";
import styles from "./MaterialLibrary.module.css";

export function sourceLocation(source: SourceReference): string {
  if (source.page) return `第 ${source.page} 页`;
  if (!source.startLine) return '原文片段';
  return source.endLine && source.endLine !== source.startLine
    ? `第 ${source.startLine}–${source.endLine} 行` : `第 ${source.startLine} 行`;
}
export function SourceReferences({ sources }: { sources: SourceReference[] }) {
  if (!sources.length) return null;
  return <div className={styles.references} aria-label="本轮引用的课程资料">{sources.map((source) => (
    <details key={source.id} className={styles.reference}>
      <summary>{source.label} · {source.title} · {sourceLocation(source)}</summary>
      <blockquote>{source.excerpt}</blockquote>
    </details>
  ))}</div>;
}

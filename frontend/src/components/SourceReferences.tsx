import type { SourceReference } from "@/lib/types";
import { useI18n } from "@/components/LanguageProvider";
import { translatePhrase, type Language } from "@/lib/i18n";
import styles from "./MaterialLibrary.module.css";

export function sourceLocation(source: SourceReference, lang: Language = "zh"): string {
  if (source.page) return translatePhrase(lang, "第 {page} 页", { page: source.page });
  if (!source.startLine) return translatePhrase(lang, "原文片段");
  return source.endLine && source.endLine !== source.startLine
    ? translatePhrase(lang, "第 {start}–{end} 行", { start: source.startLine, end: source.endLine })
    : translatePhrase(lang, "第 {start} 行", { start: source.startLine });
}
export function SourceReferences({ sources }: { sources: SourceReference[] }) {
  const { lang, tx } = useI18n();
  if (!sources.length) return null;
  return <div className={styles.references} aria-label={tx("本轮引用的课程资料")}>{sources.map((source) => (
    <details key={source.id} className={styles.reference}>
      <summary>{source.label} · {source.title} · {sourceLocation(source, lang)}</summary>
      <blockquote>{source.excerpt}</blockquote>
    </details>
  ))}</div>;
}

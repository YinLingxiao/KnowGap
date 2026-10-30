import { translate, type Language, type MessageKey } from "@/lib/i18n";
import type { Level, SpaceProgress } from "./types";

export const SPACE_COLORS = ["#3d6fdb", "#2e8a5c", "#0f766e", "#c2650a", "#a16207", "#c93535", "#be185d", "#7c5cbf"];

export const LEVELS: Array<{ id: Level; labelKey: MessageKey }> = [
  { id: "beginner", labelKey: "level.beginner" },
  { id: "some", labelKey: "level.some" },
  { id: "fluent", labelKey: "level.fluent" },
  { id: "exam", labelKey: "level.exam" },
];

export function levelLabel(level: Level | null, lang: Language): string | null {
  const item = LEVELS.find((entry) => entry.id === level);
  return item ? translate(lang, item.labelKey) : null;
}

/** 摘录只用于一两行预览，去掉 Markdown 记号后直接显示文字 */
export function plainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^\s{0,3}(#{1,6}|[-*+]|\d+\.|>)\s+/gm, "")
    .replace(/[*_`~|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function studiedLabel(iso: string | null, lang: Language, now = Date.now()): string {
  if (!iso) return translate(lang, "space.studied.notStarted");
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return translate(lang, "space.studied.notStarted");
  const days = Math.floor(Math.max(0, now - time) / 86_400_000);
  if (days <= 0) return translate(lang, "space.studied.today");
  if (days === 1) return translate(lang, "space.studied.yesterday");
  return translate(lang, "space.studied.daysAgo", { count: days });
}

export function progressLine(progress: SpaceProgress, lang: Language): string {
  const parts: string[] = [];
  if (progress.toReview) parts.push(translate(lang, "space.progress.toReview", { count: progress.toReview }));
  if (progress.mastered) parts.push(translate(lang, "space.progress.mastered", { count: progress.mastered }));
  if (progress.improving) parts.push(translate(lang, "space.progress.improving", { count: progress.improving }));
  if (progress.openThreads) parts.push(translate(lang, "space.progress.openThreads", { count: progress.openThreads }));
  else if (progress.resolvedThreads) parts.push(translate(lang, "space.progress.resolvedThreads", { count: progress.resolvedThreads }));
  if (parts.length === 0) parts.push(translate(lang, "space.progress.none"));
  parts.push(studiedLabel(progress.lastStudiedAt, lang));
  return parts.join(" · ");
}

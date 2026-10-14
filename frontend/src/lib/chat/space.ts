import type { Level, SpaceProgress } from "./types";

export const SPACE_COLORS = ["#3d6fdb", "#2e8a5c", "#0f766e", "#c2650a", "#a16207", "#c93535", "#be185d", "#7c5cbf"];

export const LEVELS: Array<{ id: Level; label: string }> = [
  { id: "beginner", label: "零基础" },
  { id: "some", label: "学过一些" },
  { id: "fluent", label: "比较熟练" },
  { id: "exam", label: "冲刺备考" },
];

export function levelLabel(level: Level | null): string | null {
  return LEVELS.find((item) => item.id === level)?.label ?? null;
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

export function studiedLabel(iso: string | null, now = Date.now()): string {
  if (!iso) return "还没开始";
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return "还没开始";
  const days = Math.floor(Math.max(0, now - time) / 86_400_000);
  if (days <= 0) return "今天学习";
  if (days === 1) return "昨天学习";
  return `${days} 天前学习`;
}

export function progressLine(progress: SpaceProgress): string {
  const parts: string[] = [];
  if (progress.toReview) parts.push(`${progress.toReview} 个待巩固`);
  if (progress.mastered) parts.push(`${progress.mastered} 个已掌握`);
  if (progress.improving) parts.push(`${progress.improving} 个改善中`);
  if (progress.openThreads) parts.push(`${progress.openThreads} 个 Thread 未解决`);
  else if (progress.resolvedThreads) parts.push(`${progress.resolvedThreads} 个 Thread 已解决`);
  if (parts.length === 0) parts.push("还没有进度");
  parts.push(studiedLabel(progress.lastStudiedAt));
  return parts.join(" · ");
}

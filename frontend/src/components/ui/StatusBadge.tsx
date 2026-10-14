import { cx } from "@/lib/cx";
import { statusMeta } from "@/lib/labels";
import type { MemoryStatus } from "@/lib/types";
import styles from "./StatusBadge.module.css";

const TONE: Record<MemoryStatus, string> = {
  suspected: styles.suspected,
  needs_review: styles.review,
  improving: styles.improving,
  resolved: styles.resolved,
};

/** 记忆状态：色块标记 + 文字，颜色从不单独表达含义 */
export function StatusBadge({ status, size = "md" }: { status: MemoryStatus; size?: "sm" | "md" }) {
  const meta = statusMeta(status);
  return (
    <span className={cx(styles.badge, TONE[status], size === "sm" && styles.sm)} title={meta.description}>
      <span className={styles.mark} aria-hidden />
      {meta.label}
    </span>
  );
}

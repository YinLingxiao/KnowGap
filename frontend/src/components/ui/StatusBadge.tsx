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

export function StatusBadge({ status, size = "md" }: { status: MemoryStatus; size?: "sm" | "md" }) {
  const meta = statusMeta(status);
  return (
    <span className={cx(styles.badge, TONE[status], size === "sm" && styles.sm)} title={meta.description}>
      <span className={styles.dot} aria-hidden />
      {meta.label}
    </span>
  );
}

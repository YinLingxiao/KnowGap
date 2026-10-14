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

/** 记忆状态图标：形状本身就区分状态，颜色只是加强 */
export function StatusIcon({ status, size = 14 }: { status: MemoryStatus; size?: number }) {
  return (
    <svg
      className={cx(styles.icon, TONE[status])}
      width={size}
      height={size}
      viewBox="0 0 14 14"
      aria-hidden="true"
      focusable="false"
    >
      {status === "suspected" && (
        <circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2.2 2" />
      )}
      {status === "needs_review" && (
        <>
          <circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M7 4v3.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          <circle cx="7" cy="9.6" r="0.9" fill="currentColor" />
        </>
      )}
      {status === "improving" && (
        <>
          <circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M7 3.5a3.5 3.5 0 0 1 0 7z" fill="currentColor" />
        </>
      )}
      {status === "resolved" && (
        <>
          <circle cx="7" cy="7" r="6.25" fill="currentColor" />
          <path d="M4.4 7.2l1.8 1.8 3.4-3.6" fill="none" stroke="var(--bg)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </>
      )}
    </svg>
  );
}

export function StatusBadge({ status, size = "md" }: { status: MemoryStatus; size?: "sm" | "md" }) {
  const meta = statusMeta(status);
  return (
    <span className={cx(styles.badge, size === "sm" && styles.sm)} title={meta.description}>
      <StatusIcon status={status} size={size === "sm" ? 12 : 14} />
      {meta.label}
    </span>
  );
}

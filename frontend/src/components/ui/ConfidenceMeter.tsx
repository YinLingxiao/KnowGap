import { Info } from "lucide-react";
import { cx } from "@/lib/cx";
import { formatConfidence } from "@/lib/labels";
import styles from "./ConfidenceMeter.module.css";

const NOTE = "由模型或规则给出的启发式可信度，未经校准，不代表统计概率";

export function ConfidenceMeter({ value, tone = "primary" }: { value: number | null; tone?: "primary" | "accent" }) {
  const percent = value == null ? 0 : Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div className={cx(styles.meter, tone === "accent" && styles.accent)}>
      <div className={styles.head}>
        <span className={styles.label} title={NOTE}>
          启发式置信度
          <Info size={12} aria-hidden />
        </span>
        <span className={styles.value}>{formatConfidence(value)}</span>
      </div>
      <div
        className={styles.track}
        role="meter"
        aria-label="启发式置信度"
        aria-valuemin={0}
        aria-valuemax={1}
        aria-valuenow={value ?? undefined}
        aria-valuetext={value == null ? "暂无" : formatConfidence(value)}
      >
        <div className={styles.fill} style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

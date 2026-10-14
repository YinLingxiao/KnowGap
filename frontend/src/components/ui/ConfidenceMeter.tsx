import { formatConfidence } from "@/lib/labels";
import styles from "./ConfidenceMeter.module.css";

const NOTE = "由模型或规则给出的启发式可信度，未经校准，不是准确率或掌握程度";

/** 启发式置信度：只给数值与说明，不画成进度条，避免被读成“掌握率” */
export function ConfidenceMeter({ value }: { value: number | null }) {
  return (
    <span className={styles.meter} title={NOTE}>
      <span className={styles.label}>启发式置信度</span>
      <span className={styles.value}>{formatConfidence(value)}</span>
    </span>
  );
}

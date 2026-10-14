import { CircleCheck, CircleHelp, CircleAlert } from "lucide-react";
import { cx } from "@/lib/cx";
import { topicLabel } from "@/lib/labels";
import type { Diagnosis } from "@/lib/types";
import { ConfidenceMeter } from "./ui/ConfidenceMeter";
import styles from "./DiagnosisNote.module.css";

export type Verdict = "correct" | "incorrect" | "uncertain";

export function verdictOf(diagnosis: Diagnosis): Verdict {
  if (diagnosis.assessment) return diagnosis.assessment;
  if (diagnosis.issue) return "incorrect";
  return diagnosis.confidence == null ? "uncertain" : "correct";
}

const VERDICT = {
  incorrect: { label: "疑似误区", icon: CircleAlert, fallback: "" },
  correct: { label: "判断正确", icon: CircleCheck, fallback: "未发现明显误区" },
  uncertain: { label: "暂不确定", icon: CircleHelp, fallback: "暂时无法确认，需要你补充推导过程" },
} as const;

interface DiagnosisNoteProps {
  diagnosis: Diagnosis;
  /** 依据是否已在原文中划出；没找到时把依据原文引出来 */
  evidenceMarked: boolean;
  /** 后续轮次用紧凑样式，首次作答用完整样式 */
  compact?: boolean;
}

/** 诊断批注：像老师在作答旁写的批语。依据在原文中用下划线标出 */
export function DiagnosisNote({ diagnosis, evidenceMarked, compact = false }: DiagnosisNoteProps) {
  const verdict = verdictOf(diagnosis);
  const meta = VERDICT[verdict];
  const Icon = meta.icon;
  const finding = diagnosis.issue ?? meta.fallback;

  return (
    <aside className={cx(styles.note, styles[verdict], compact && styles.compact)} aria-label={`诊断批注：${meta.label}`}>
      <div className={styles.head}>
        <span className={styles.mark}>批注</span>
        <span className={styles.verdict}>
          <Icon size={14} aria-hidden />
          {meta.label}
        </span>
        {!compact && <span className={styles.topic}>{topicLabel(diagnosis.topicKey, diagnosis.topicLabel)}</span>}
        <ConfidenceMeter value={diagnosis.confidence} />
      </div>

      {finding && (!compact || verdict === "incorrect") && <p className={styles.finding}>{finding}</p>}

      {diagnosis.evidence && (
        <p className={styles.evidence}>
          {evidenceMarked ? (
            <>依据：原文中划线的部分</>
          ) : (
            <>
              依据：<q className={styles.quote}>{diagnosis.evidence}</q>
            </>
          )}
        </p>
      )}
    </aside>
  );
}

/** 等待诊断时的占位：一条在纸面上缓慢推进的细线 */
export function DiagnosisPending() {
  return (
    <div className={styles.pending} role="status" aria-live="polite">
      <span className={styles.pendingLine} aria-hidden />
      正在阅读你的作答并做诊断…
    </div>
  );
}

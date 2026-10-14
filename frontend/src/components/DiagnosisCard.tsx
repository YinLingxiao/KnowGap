import { Brain, CircleCheck, Info, LoaderCircle, Quote, Target } from "lucide-react";
import { cx } from "@/lib/cx";
import { topicLabel } from "@/lib/labels";
import type { Diagnosis } from "@/lib/types";
import { ConfidenceMeter } from "./ui/ConfidenceMeter";
import styles from "./DiagnosisCard.module.css";

export function DiagnosisCard({ diagnosis }: { diagnosis: Diagnosis }) {
  const hasIssue = Boolean(diagnosis.issue);
  const uncertain = diagnosis.assessment === "uncertain" || (!hasIssue && diagnosis.confidence == null);

  return (
    <section
      className={cx(styles.card, hasIssue ? styles.issue : uncertain ? styles.uncertain : styles.clear)}
      aria-labelledby="diagnosis-title"
    >
      <header className={styles.header}>
        <span className={styles.headerIcon}>
          <Brain size={16} aria-hidden />
        </span>
        <h3 id="diagnosis-title" className={styles.title}>
          认知诊断
        </h3>
        <span className={styles.topic}>{topicLabel(diagnosis.topicKey, diagnosis.topicLabel)}</span>
      </header>

      <div className={styles.finding}>
        <span className={styles.findingIcon}>
          {hasIssue ? <Target size={20} aria-hidden /> : uncertain ? <Info size={20} aria-hidden /> : <CircleCheck size={20} aria-hidden />}
        </span>
        <div>
          <div className={styles.findingLabel}>{hasIssue ? "疑似误区" : "诊断结论"}</div>
          <div className={styles.findingText}>
            {hasIssue ? diagnosis.issue : uncertain ? "暂时无法确认，需要你补充思路" : "未发现明显误区"}
          </div>
        </div>
      </div>

      <div className={styles.grid}>
        <div className={styles.evidence}>
          <div className={styles.blockLabel}>
            <Quote size={13} aria-hidden />
            诊断依据
          </div>
          <p>{diagnosis.evidence ?? "暂无"}</p>
        </div>
        <div className={styles.meter}>
          <ConfidenceMeter value={diagnosis.confidence} tone={hasIssue ? "accent" : "primary"} />
        </div>
      </div>

      <p className={styles.disclaimer}>
        <Info size={12} aria-hidden />
        置信度为启发式估计，未经校准，仅供参考；诊断以本次作答为准，历史记忆只用于调整提问方式。
      </p>
    </section>
  );
}

export function DiagnosisSkeleton() {
  return (
    <section className={cx(styles.card, styles.loading)} aria-busy="true" aria-live="polite">
      <header className={styles.header}>
        <span className={styles.headerIcon}>
          <LoaderCircle size={16} className={styles.spin} aria-hidden />
        </span>
        <h3 className={styles.title}>正在分析你的作答…</h3>
      </header>
      <div className={styles.skeletonLines}>
        <span style={{ width: "72%" }} />
        <span style={{ width: "94%" }} />
        <span style={{ width: "58%" }} />
      </div>
    </section>
  );
}

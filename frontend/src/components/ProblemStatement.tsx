import { PenLine } from "lucide-react";
import { cx } from "@/lib/cx";
import { topicLabel } from "@/lib/labels";
import type { Problem } from "@/lib/types";
import { RichText } from "./ui/RichText";
import styles from "./ProblemStatement.module.css";

interface ProblemStatementProps {
  problem: Problem;
  submission?: { answer: string; reasoning: string };
}

export function ProblemStatement({ problem, submission }: ProblemStatementProps) {
  return (
    <article className={cx(styles.card, submission && styles.withSubmission)}>
      <div className={styles.meta}>
        <span className={styles.topic}>{topicLabel(problem.topicKey, problem.topicLabel)}</span>
        {problem.difficulty && <span className={styles.difficulty}>{problem.difficulty}</span>}
        <span className={styles.id}>{problem.id}</span>
      </div>
      <h2 className={styles.title}>{problem.title}</h2>
      <p className={styles.statement}>
        <RichText text={problem.statement} />
      </p>

      {submission && (
        <div className={styles.submission}>
          <div className={styles.subLabel}>
            <PenLine size={13} aria-hidden />
            你的作答
          </div>
          <p className={styles.answer}>{submission.answer}</p>
          {submission.reasoning && <p className={styles.reasoning}>{submission.reasoning}</p>}
        </div>
      )}
    </article>
  );
}

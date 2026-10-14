import { Check } from "lucide-react";
import { cx } from "@/lib/cx";
import styles from "./LoopStepper.module.css";

export interface LoopStep {
  key: string;
  label: string;
  status: "done" | "active" | "todo";
}

/** 学习闭环进度：作答 → 诊断 → 引导 → 记忆（真实的先后顺序，所以编号） */
export function LoopStepper({ steps, className }: { steps: LoopStep[]; className?: string }) {
  return (
    <ol className={cx(styles.stepper, className)} aria-label="学习闭环进度">
      {steps.map((step, index) => (
        <li
          key={step.key}
          className={cx(styles.step, styles[step.status])}
          aria-current={step.status === "active" ? "step" : undefined}
        >
          <span className={styles.index} aria-hidden>
            {step.status === "done" ? <Check size={12} strokeWidth={2.5} /> : index + 1}
          </span>
          <span className={styles.label}>{step.label}</span>
        </li>
      ))}
    </ol>
  );
}

"use client";

import { useEffect, useState } from "react";
import { cx } from "@/lib/cx";
import { topicLabel } from "@/lib/labels";
import type { Problem } from "@/lib/types";
import { StackBench } from "./StackBench";
import { topicIcon } from "./topicIcon";
import { RichText } from "./ui/RichText";
import styles from "./ProblemStatement.module.css";

function useNarrow() {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 900px)");
    const update = () => setNarrow(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return narrow;
}

/** 题目：标题 + 属性行 + 题干；有序列时给出可操作的栈，不含是否合法的判断 */
export function ProblemStatement({ problem, compact = false }: { problem: Problem; compact?: boolean }) {
  const input = problem.inputSequence ?? [];
  const output = problem.outputSequence ?? [];
  const hasSequences = input.length > 0 && output.length > 0;
  const Icon = topicIcon(problem.topicKey);
  const narrow = useNarrow();
  const bench = hasSequences ? <StackBench key={problem.id} input={input} output={output} /> : null;
  const folded = compact || narrow;

  return (
    <article className={cx(styles.problem, compact && styles.compact)} aria-labelledby="problem-title">
      <h1 id="problem-title" className={styles.title}>
        {problem.title}
      </h1>

      <div className={styles.properties}>
        <span className={styles.property}>
          <Icon size={13} aria-hidden />
          {topicLabel(problem.topicKey, problem.topicLabel)}
        </span>
        {problem.difficulty && <span className={styles.property}>{problem.difficulty}</span>}
        <span className={styles.id}>{problem.id}</span>
      </div>

      <p className={styles.statement}>
        <RichText text={problem.statement} />
      </p>

      {bench &&
        (folded ? (
          <details className={styles.benchFold}>
            <summary>自己推一推这道栈</summary>
            {bench}
          </details>
        ) : (
          bench
        ))}
    </article>
  );
}

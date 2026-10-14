import { topicLabel } from "@/lib/labels";
import type { Problem } from "@/lib/types";
import { RichText } from "./ui/RichText";
import styles from "./ProblemStatement.module.css";

/** 题目：像试卷一样排版；后端提供序列时，额外排成对照表方便逐位比对 */
export function ProblemStatement({ problem }: { problem: Problem }) {
  const hasSequences = Boolean(problem.inputSequence?.length && problem.outputSequence?.length);

  return (
    <article className={styles.problem} aria-labelledby="problem-title">
      <p className={styles.meta}>
        <span>{topicLabel(problem.topicKey, problem.topicLabel)}</span>
        {problem.difficulty && <span>{problem.difficulty}</span>}
        <span className={styles.id}>{problem.id}</span>
      </p>
      <h2 id="problem-title" className={styles.title}>
        {problem.title}
      </h2>
      <p className={styles.statement}>
        <RichText text={problem.statement} />
      </p>

      {hasSequences && (
        <table className={styles.sequences}>
          <caption className="sr-only">序列对照</caption>
          <tbody>
            <tr>
              <th scope="row">入栈顺序</th>
              {problem.inputSequence?.map((value, index) => <td key={`in-${index}`}>{value}</td>)}
            </tr>
            <tr>
              <th scope="row">待判序列</th>
              {problem.outputSequence?.map((value, index) => <td key={`out-${index}`}>{value}</td>)}
            </tr>
          </tbody>
        </table>
      )}
    </article>
  );
}

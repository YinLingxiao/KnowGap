import { topicLabel } from "@/lib/labels";
import type { Problem } from "@/lib/types";
import { topicIcon } from "./topicIcon";
import { RichText } from "./ui/RichText";
import styles from "./ProblemStatement.module.css";

/** 题目：标题 + 属性行 + 题干；后端提供序列时排成对照格，方便逐位比对 */
export function ProblemStatement({ problem }: { problem: Problem }) {
  const hasSequences = Boolean(problem.inputSequence?.length && problem.outputSequence?.length);
  const Icon = topicIcon(problem.topicKey);

  return (
    <article className={styles.problem} aria-labelledby="problem-title">
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

      {hasSequences && (
        <table className={styles.sequences}>
          <caption className="sr-only">序列对照</caption>
          <tbody>
            <tr>
              <th scope="row">入栈顺序</th>
              {problem.inputSequence?.map((value, index) => (
                <td key={`in-${index}`}>
                  <span>{value}</span>
                </td>
              ))}
            </tr>
            <tr>
              <th scope="row">待判序列</th>
              {problem.outputSequence?.map((value, index) => (
                <td key={`out-${index}`}>
                  <span className={styles.target}>{value}</span>
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      )}
    </article>
  );
}

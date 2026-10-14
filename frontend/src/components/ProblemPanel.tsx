import { BookOpen, Check, History } from "lucide-react";
import type { Resource } from "@/hooks/useWorkbench";
import type { DataSource } from "@/lib/config";
import { cx } from "@/lib/cx";
import { topicLabel } from "@/lib/labels";
import type { Problem } from "@/lib/types";
import { ErrorNotice } from "./ErrorNotice";
import { plainText } from "./ui/RichText";
import styles from "./ProblemPanel.module.css";

interface ProblemPanelProps {
  source: DataSource;
  problems: Resource<Problem[]>;
  selectedId: string | null;
  memoryCountByTopic: Record<string, number>;
  onSelect: (problemId: string) => void;
  onRetry: () => void;
  disabled?: boolean;
}

export function ProblemPanel({ source, problems, selectedId, memoryCountByTopic, onSelect, onRetry, disabled }: ProblemPanelProps) {
  const { data, loading, error } = problems;

  return (
    <section className={styles.panel} aria-labelledby="problem-panel-title">
      <div className={styles.header}>
        <h2 id="problem-panel-title" className={styles.title}>
          <BookOpen size={16} aria-hidden />
          选择题目
        </h2>
        {source === "mock" && (
          <span className={styles.mockTag} title="题目为前端临时编写的示例，尚未经过教学负责人审定">
            Mock 题目
          </span>
        )}
      </div>
      <p className={styles.sub}>《数据结构》预设演示题 · 栈与队列</p>

      {loading && data.length === 0 ? (
        <ul className={styles.list} aria-busy="true" aria-label="正在加载题目">
          {[0, 1, 2].map((key) => (
            <li key={key} className={styles.skeleton} />
          ))}
        </ul>
      ) : error && data.length === 0 ? (
        <ErrorNotice error={error} compact onRetry={onRetry} />
      ) : data.length === 0 ? (
        <p className={styles.empty}>暂无可用题目。</p>
      ) : (
        <ul className={styles.list}>
          {data.map((problem) => {
            const selected = problem.id === selectedId;
            const related = memoryCountByTopic[problem.topicKey] ?? 0;
            return (
              <li key={problem.id}>
                <button
                  className={cx(styles.card, selected && styles.selected)}
                  onClick={() => onSelect(problem.id)}
                  disabled={disabled}
                  aria-pressed={selected}
                >
                  <span className={styles.cardTop}>
                    <span className={styles.topic}>{topicLabel(problem.topicKey, problem.topicLabel)}</span>
                    {problem.difficulty && <span className={styles.difficulty}>{problem.difficulty}</span>}
                    {selected && (
                      <span className={styles.check} aria-hidden>
                        <Check size={12} strokeWidth={3} />
                      </span>
                    )}
                  </span>
                  <span className={styles.cardTitle}>{problem.title}</span>
                  <span className={styles.preview}>{plainText(problem.statement)}</span>
                  {related > 0 && (
                    <span className={styles.memoryHint}>
                      <History size={12} aria-hidden />
                      该知识点有 {related} 条学习记忆
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

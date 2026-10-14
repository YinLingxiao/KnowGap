import { Check, History } from "lucide-react";
import type { Resource } from "@/hooks/useWorkbench";
import type { DataSource } from "@/lib/config";
import { cx } from "@/lib/cx";
import { topicLabel } from "@/lib/labels";
import type { Problem } from "@/lib/types";
import { ErrorNotice } from "./ErrorNotice";
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

/** 题目目录：一条细线分隔一题，不用卡片 */
export function ProblemPanel({ source, problems, selectedId, memoryCountByTopic, onSelect, onRetry, disabled }: ProblemPanelProps) {
  const { data, loading, error } = problems;

  return (
    <section className={styles.panel} aria-labelledby="problem-panel-title">
      <header className={styles.header}>
        <h2 id="problem-panel-title" className={styles.title}>
          题目
        </h2>
        {source === "mock" && (
          <span className={styles.mockTag} title="题目为前端临时编写的示例，尚未经过教学负责人审定">
            Mock 题目
          </span>
        )}
      </header>
      <p className={styles.sub}>《数据结构》预设演示题</p>

      {loading && data.length === 0 ? (
        <ul className={styles.list} aria-busy="true" aria-label="正在加载题目">
          {[0, 1, 2].map((key) => (
            <li key={key} className={styles.skeleton}>
              <span />
              <span />
            </li>
          ))}
        </ul>
      ) : error && data.length === 0 ? (
        <ErrorNotice error={error} compact onRetry={onRetry} />
      ) : data.length === 0 ? (
        <p className={styles.empty}>暂无可用题目。请确认后端题库已加载后刷新页面。</p>
      ) : (
        <ul className={styles.list}>
          {data.map((problem) => {
            const selected = problem.id === selectedId;
            const related = memoryCountByTopic[problem.topicKey] ?? 0;
            return (
              <li key={problem.id}>
                <button
                  className={cx(styles.row, selected && styles.selected)}
                  onClick={() => onSelect(problem.id)}
                  disabled={disabled}
                  aria-pressed={selected}
                  title={disabled ? "正在处理当前请求，完成后再切换题目" : undefined}
                >
                  <span className={styles.rowTitle}>
                    {problem.title}
                    {selected && <Check size={14} className={styles.check} aria-label="当前题目" />}
                  </span>
                  <span className={styles.rowMeta}>
                    {topicLabel(problem.topicKey, problem.topicLabel)}
                    {problem.difficulty && <> · {problem.difficulty}</>}
                  </span>
                  {related > 0 && (
                    <span className={styles.rowMemory}>
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

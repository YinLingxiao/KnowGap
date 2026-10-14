import { ArrowUpRight } from "lucide-react";
import type { LearningMemory } from "@/lib/types";
import { StatusBadge } from "./ui/StatusBadge";
import styles from "./UsedMemories.module.css";

interface UsedMemoriesProps {
  usedIds: string[];
  memoriesById: Record<string, LearningMemory>;
  onFocus: (memoryId: string) => void;
}

/** 本轮送入教学上下文的历史记忆（跨会话演示的关键对照点） */
export function UsedMemories({ usedIds, memoriesById, onFocus }: UsedMemoriesProps) {
  return (
    <section className={styles.row} aria-label="本轮参考的历史记忆">
      <span className={usedIds.length > 0 ? styles.labelActive : styles.label}>参考</span>
      {usedIds.length === 0 ? (
        <p className={styles.none}>本轮未参考历史记忆。首次学习该知识点，或暂时没有相关记录。</p>
      ) : (
        <div className={styles.content}>
          <p className={styles.title}>
            本轮参考了 <strong>{usedIds.length}</strong> 条历史记忆
          </p>
          <p className={styles.note}>这些记录已送入本轮教学上下文；诊断结论仍以本次作答为准。</p>
          <ul className={styles.list}>
            {usedIds.map((id) => {
              const memory = memoriesById[id];
              return (
                <li key={id}>
                  {memory ? (
                    <button className={styles.link} onClick={() => onFocus(id)} title="在学习记忆中查看">
                      <StatusBadge status={memory.status} size="sm" />
                      <span className={styles.summary}>{memory.summary}</span>
                      <ArrowUpRight size={14} className={styles.arrow} aria-hidden />
                    </button>
                  ) : (
                    <span className={styles.gone}>这条记忆已被删除</span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}

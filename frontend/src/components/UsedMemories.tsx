import { ArrowUpRight, History } from "lucide-react";
import type { LearningMemory } from "@/lib/types";
import { StatusIcon } from "./ui/StatusBadge";
import styles from "./UsedMemories.module.css";

interface UsedMemoriesProps {
  usedIds: string[];
  memoriesById: Record<string, LearningMemory>;
  onFocus: (memoryId: string) => void;
}

/** 本轮送入教学上下文的历史记忆（跨会话演示的关键对照点） */
export function UsedMemories({ usedIds, memoriesById, onFocus }: UsedMemoriesProps) {
  if (usedIds.length === 0) {
    return (
      <p className={styles.none}>
        <History size={13} aria-hidden />
        本轮未参考历史记忆 · 首次学习该知识点，或暂时没有相关记录
      </p>
    );
  }

  return (
    <section className={styles.box} aria-label="本轮参考的历史记忆">
      <p className={styles.title}>
        <History size={14} aria-hidden />
        本轮参考了 {usedIds.length} 条历史记忆
        <span className={styles.note}>已送入教学上下文；诊断仍以本次作答为准</span>
      </p>
      <ul className={styles.list}>
        {usedIds.map((id) => {
          const memory = memoriesById[id];
          return (
            <li key={id}>
              {memory ? (
                <button className={styles.row} onClick={() => onFocus(id)} title="在学习记忆中查看">
                  <StatusIcon status={memory.status} size={13} />
                  <span className={styles.summary}>{memory.summary}</span>
                  <ArrowUpRight size={13} className={styles.arrow} aria-hidden />
                </button>
              ) : (
                <span className={styles.gone}>这条记忆已被删除</span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

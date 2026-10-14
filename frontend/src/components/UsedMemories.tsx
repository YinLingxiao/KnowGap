import { ArrowUpRight, History, Link2 } from "lucide-react";
import type { LearningMemory } from "@/lib/types";
import { StatusBadge } from "./ui/StatusBadge";
import styles from "./UsedMemories.module.css";

interface UsedMemoriesProps {
  usedIds: string[];
  memoriesById: Record<string, LearningMemory>;
  onFocus: (memoryId: string) => void;
}

/** 显示本次教学参考了哪些历史记忆（MVP 演示的关键对照点） */
export function UsedMemories({ usedIds, memoriesById, onFocus }: UsedMemoriesProps) {
  if (usedIds.length === 0) {
    return (
      <div className={styles.none}>
        <History size={14} aria-hidden />
        本次教学未参考历史记忆
        <span className={styles.noneHint}>（首次学习该知识点，或暂无相关记录）</span>
      </div>
    );
  }

  return (
    <section className={styles.banner} aria-label="本次参考的历史记忆">
      <div className={styles.head}>
        <span className={styles.headIcon}>
          <Link2 size={15} aria-hidden />
        </span>
        <div>
          <div className={styles.title}>本次教学参考了 {usedIds.length} 条历史记忆</div>
          <div className={styles.note}>这些记录已送入本轮教学上下文；诊断结论仍以本次作答为准。</div>
        </div>
      </div>
      <ul className={styles.chips}>
        {usedIds.map((id) => {
          const memory = memoriesById[id];
          return (
            <li key={id}>
              {memory ? (
                <button className={styles.chip} onClick={() => onFocus(id)} title="在学习记忆面板中查看">
                  <StatusBadge status={memory.status} size="sm" />
                  <span className={styles.chipText}>{memory.summary}</span>
                  <ArrowUpRight size={14} className={styles.chipArrow} aria-hidden />
                </button>
              ) : (
                <span className={styles.chipGone}>这条记忆已被删除</span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

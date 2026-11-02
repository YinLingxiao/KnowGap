"use client";

import { Sparkles } from "lucide-react";
import { cx } from "@/lib/cx";
import { useI18n } from "@/components/LanguageProvider";
import styles from "./WidgetSkeleton.module.css";

/**
 * 卡片流式生成中的骨架：已知类型先按最终卡片的结构占位，
 * 避免占位块和真正卡片之间来回跳动。
 */
export function WidgetSkeleton({ type }: { type?: string }) {
  const { tx } = useI18n();

  if (type === "step_simulator") {
    return (
      <div className={styles.card} aria-busy="true">
        <span className="sr-only">{tx("正在生成过程步进推演")}</span>
        <div className={styles.visual} aria-hidden="true">
          <div className={styles.head}>
            <div className={cx(styles.block, styles.titleBar)} />
            <div className={cx(styles.block, styles.counterBar)} />
          </div>
          <div className={styles.stateGrid}>
            {[0, 1, 2].map((index) => (
              <div key={index} className={cx(styles.block, styles.stateCell)} />
            ))}
          </div>
          <div className={cx(styles.block, styles.textBar)} />
          <div className={cx(styles.block, styles.textBar, styles.textBarShort)} />
        </div>
      </div>
    );
  }

  if (type === "comparison_matrix") {
    return (
      <div className={styles.card} aria-busy="true">
        <span className="sr-only">{tx("正在生成核心差异对比")}</span>
        <div className={styles.matrixGrid} aria-hidden="true">
          <div className={cx(styles.matrixRow, styles.matrixHead)}>
            {[0, 1, 2].map((index) => (
              <div key={index} className={cx(styles.block, styles.matrixCell)} />
            ))}
          </div>
          {[0, 1, 2].map((row) => (
            <div key={row} className={styles.matrixRow}>
              <div className={cx(styles.block, styles.matrixCell, styles.matrixCellDim)} />
              <div className={cx(styles.block, styles.matrixCell)} />
              <div className={cx(styles.block, styles.matrixCell)} />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (type === "code_playground") {
    return (
      <div className={styles.card} aria-busy="true">
        <span className="sr-only">{tx("正在生成代码实验台")}</span>
        <div className={styles.visual} aria-hidden="true">
          <div className={cx(styles.block, styles.titleBar)} />
          <div className={cx(styles.block, styles.editorBlock)} />
        </div>
      </div>
    );
  }

  // 类型还认不出来时保留原来的一行通用骨架
  return (
    <div className={styles.generic} role="status" aria-busy="true">
      <Sparkles size={14} className={styles.icon} aria-hidden />
      <span>{tx("正在流式构建可交互学习微件…")}</span>
    </div>
  );
}

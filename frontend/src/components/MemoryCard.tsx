"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, Link2 } from "lucide-react";
import { cx } from "@/lib/cx";
import { formatConfidence, formatRelativeTime, shortId, topicLabel } from "@/lib/labels";
import type { LearningMemory } from "@/lib/types";
import { Button } from "./ui/Button";
import { StatusBadge } from "./ui/StatusBadge";
import styles from "./MemoryCard.module.css";

interface MemoryCardProps {
  memory: LearningMemory;
  used: boolean;
  changed: boolean;
  deleting: boolean;
  focusNonce?: number;
  onDelete: (memoryId: string) => Promise<boolean>;
}

/** 一条学习记忆：列表中的一行记录，不做卡片 */
export function MemoryCard({ memory, used, changed, deleting, focusNonce, onDelete }: MemoryCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [flash, setFlash] = useState(false);
  const ref = useRef<HTMLElement>(null);

  // 从「参考」跳转过来时：滚动到可见位置并短暂高亮
  useEffect(() => {
    if (!focusNonce) return;
    ref.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    setFlash(true);
    const timer = window.setTimeout(() => setFlash(false), 1600);
    return () => window.clearTimeout(timer);
  }, [focusNonce]);

  const evidenceId = `evidence-${memory.id}`;

  return (
    <article ref={ref} className={cx(styles.record, used && styles.used, flash && styles.flash)}>
      <div className={styles.top}>
        <StatusBadge status={memory.status} size="sm" />
        {used && (
          <span className={styles.usedTag}>
            <Link2 size={11} aria-hidden />
            本轮参考
          </span>
        )}
        {changed && <span className={styles.changedTag}>刚更新</span>}
        <span className={styles.time}>{formatRelativeTime(memory.updatedAt)}</span>
      </div>

      <p className={styles.summary}>{memory.summary}</p>

      <p className={styles.meta}>
        <span>{topicLabel(memory.topicKey, memory.topicLabel)}</span>
        <span>证据 {memory.evidenceCount} 条</span>
        <span title="启发式置信度，未经校准，不是准确率或掌握程度">启发式 {formatConfidence(memory.confidence)}</span>
      </p>

      <div className={styles.actions}>
        <button
          className={styles.textButton}
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          aria-controls={evidenceId}
        >
          {expanded ? "收起依据" : "查看依据"}
          <ChevronDown size={13} className={cx(styles.chevron, expanded && styles.chevronOpen)} aria-hidden />
        </button>
        {!confirming && (
          <button className={cx(styles.textButton, styles.deleteButton)} onClick={() => setConfirming(true)}>
            删除
          </button>
        )}
      </div>

      {expanded && (
        <ol id={evidenceId} className={styles.refs}>
          {memory.evidenceRefs.length === 0 && <li className={styles.refEmpty}>暂无可展示的证据引用</li>}
          {memory.evidenceRefs.map((ref, index) => (
            <li key={`${ref.sessionId ?? "ref"}-${index}`} className={styles.ref}>
              <span className={styles.refIndex}>{index + 1}</span>
              <div className={styles.refBody}>
                <div className={styles.refLabel}>{ref.label}</div>
                {ref.excerpt && <blockquote className={styles.refExcerpt}>{ref.excerpt}</blockquote>}
                {ref.sessionId && <div className={styles.refMeta}>会话 {shortId(ref.sessionId)}</div>}
              </div>
            </li>
          ))}
        </ol>
      )}

      {confirming && (
        <div className={styles.confirm} role="group" aria-label="确认删除">
          <span>删除后不可恢复，确定删除这条记忆吗？</span>
          <div className={styles.confirmActions}>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)} disabled={deleting}>
              取消
            </Button>
            <Button
              size="sm"
              variant="danger"
              loading={deleting}
              onClick={async () => {
                const ok = await onDelete(memory.id);
                if (!ok) setConfirming(false);
              }}
            >
              确认删除
            </Button>
          </div>
        </div>
      )}
    </article>
  );
}

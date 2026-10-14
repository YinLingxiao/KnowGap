"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronRight, Link2, Trash2 } from "lucide-react";
import { cx } from "@/lib/cx";
import { formatConfidence, formatRelativeTime, shortId, statusMeta, topicLabel } from "@/lib/labels";
import type { LearningMemory } from "@/lib/types";
import { Button } from "./ui/Button";
import { StatusIcon } from "./ui/StatusBadge";
import styles from "./MemoryCard.module.css";

interface MemoryCardProps {
  memory: LearningMemory;
  used: boolean;
  changed: boolean;
  deleting: boolean;
  focusNonce?: number;
  onDelete: (memoryId: string) => Promise<boolean>;
}

/** 一条学习记忆：紧凑的列表行，点击展开证据 */
export function MemoryCard({ memory, used, changed, deleting, focusNonce, onDelete }: MemoryCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [flash, setFlash] = useState(false);
  const ref = useRef<HTMLElement>(null);

  // 从「参考」跳转过来时：滚动到可见位置、展开证据并短暂高亮
  useEffect(() => {
    if (!focusNonce) return;
    ref.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    setExpanded(true);
    setFlash(true);
    const timer = window.setTimeout(() => setFlash(false), 1400);
    return () => window.clearTimeout(timer);
  }, [focusNonce]);

  const evidenceId = `evidence-${memory.id}`;
  const status = statusMeta(memory.status);

  return (
    <article ref={ref} className={cx(styles.record, used && styles.used, flash && styles.flash, expanded && styles.open)}>
      <div className={styles.row}>
        <button
          className={styles.rowButton}
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          aria-controls={evidenceId}
        >
          <span className={styles.status} title={`${status.label}：${status.description}`}>
            <StatusIcon status={memory.status} />
          </span>
          <span className={styles.summary}>{memory.summary}</span>
          <ChevronRight size={13} className={styles.chevron} aria-hidden />
        </button>
        {!confirming && (
          <button className={styles.delete} onClick={() => setConfirming(true)} aria-label="删除这条记忆" title="删除这条记忆">
            <Trash2 size={13} />
          </button>
        )}
      </div>

      <div className={styles.meta}>
        <span className={styles.statusLabel}>{status.label}</span>
        <span>{topicLabel(memory.topicKey, memory.topicLabel)}</span>
        <span>证据 {memory.evidenceCount}</span>
        <span title="启发式置信度，未经校准，不是准确率或掌握程度">启发式 {formatConfidence(memory.confidence)}</span>
        <span className={styles.time}>{formatRelativeTime(memory.updatedAt)}</span>
      </div>

      {(used || changed) && (
        <div className={styles.tags}>
          {used && (
            <span className={styles.usedTag}>
              <Link2 size={11} aria-hidden />
              本轮参考
            </span>
          )}
          {changed && <span className={styles.changedTag}>刚更新</span>}
        </div>
      )}

      {expanded && (
        <ol id={evidenceId} className={styles.refs}>
          {memory.evidenceRefs.length === 0 && <li className={styles.refEmpty}>暂无可展示的证据引用</li>}
          {memory.evidenceRefs.map((ref, index) => (
            <li key={`${ref.sessionId ?? "ref"}-${index}`} className={styles.ref}>
              <div className={styles.refLabel}>
                <span className={styles.refIndex}>{index + 1}</span>
                {ref.label}
              </div>
              {ref.excerpt && <blockquote className={styles.refExcerpt}>{ref.excerpt}</blockquote>}
              {ref.sessionId && <div className={styles.refMeta}>会话 {shortId(ref.sessionId)}</div>}
            </li>
          ))}
        </ol>
      )}

      {confirming && (
        <div className={styles.confirm} role="group" aria-label="确认删除">
          <span>删除后不可恢复，确定删除？</span>
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
              删除
            </Button>
          </div>
        </div>
      )}
    </article>
  );
}

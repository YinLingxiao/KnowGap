"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, Clock, FileSearch, Gauge, Link2, Sparkles, Trash2 } from "lucide-react";
import { cx } from "@/lib/cx";
import { formatConfidence, formatRelativeTime, shortId, topicLabel } from "@/lib/labels";
import type { LearningMemory, MemoryStatus } from "@/lib/types";
import { Button } from "./ui/Button";
import { StatusBadge } from "./ui/StatusBadge";
import styles from "./MemoryCard.module.css";

const TONE: Record<MemoryStatus, string> = {
  suspected: styles.suspected,
  needs_review: styles.review,
  improving: styles.improving,
  resolved: styles.resolved,
};

interface MemoryCardProps {
  memory: LearningMemory;
  used: boolean;
  changed: boolean;
  deleting: boolean;
  focusNonce?: number;
  onDelete: (memoryId: string) => Promise<boolean>;
}

export function MemoryCard({ memory, used, changed, deleting, focusNonce, onDelete }: MemoryCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [flash, setFlash] = useState(false);
  const ref = useRef<HTMLElement>(null);

  // 从「本次参考」跳转过来时：滚动到可见位置并高亮
  useEffect(() => {
    if (!focusNonce) return;
    ref.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    setFlash(true);
    const timer = window.setTimeout(() => setFlash(false), 1600);
    return () => window.clearTimeout(timer);
  }, [focusNonce]);

  const evidenceId = `evidence-${memory.id}`;

  return (
    <article ref={ref} className={cx(styles.card, TONE[memory.status], used && styles.used, flash && styles.flash)}>
      <div className={styles.top}>
        <StatusBadge status={memory.status} size="sm" />
        {used && (
          <span className={styles.usedTag}>
            <Link2 size={11} aria-hidden />
            本次参考
          </span>
        )}
        {changed && (
          <span className={styles.changedTag}>
            <Sparkles size={11} aria-hidden />
            刚更新
          </span>
        )}
        <span className={styles.time}>
          <Clock size={11} aria-hidden />
          {formatRelativeTime(memory.updatedAt)}
        </span>
      </div>

      <div className={styles.topic}>
        {topicLabel(memory.topicKey, memory.topicLabel)}
        <code className={styles.issueKey}>{memory.issueKey}</code>
      </div>
      <p className={styles.summary}>{memory.summary}</p>

      <div className={styles.meta}>
        <span className={styles.metaItem}>
          <FileSearch size={12} aria-hidden />
          证据 {memory.evidenceCount} 条
        </span>
        <span className={styles.metaItem} title="启发式置信度，未经校准，不是概率">
          <Gauge size={12} aria-hidden />
          启发式 {formatConfidence(memory.confidence)}
        </span>
      </div>

      <div className={styles.actions}>
        <button
          className={styles.linkButton}
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          aria-controls={evidenceId}
        >
          <ChevronDown size={14} className={cx(styles.chevron, expanded && styles.chevronOpen)} aria-hidden />
          {expanded ? "收起依据" : "查看依据"}
        </button>
        {!confirming && (
          <button className={styles.deleteButton} onClick={() => setConfirming(true)} aria-label="删除这条记忆" title="删除这条记忆">
            <Trash2 size={14} />
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
              删除
            </Button>
          </div>
        </div>
      )}
    </article>
  );
}

import { Database, Inbox, Info, RefreshCw } from "lucide-react";
import type { Resource } from "@/hooks/useWorkbench";
import { cx } from "@/lib/cx";
import { STATUS_META, STATUS_ORDER } from "@/lib/labels";
import type { LearningMemory } from "@/lib/types";
import { ErrorNotice } from "./ErrorNotice";
import { MemoryCard } from "./MemoryCard";
import { StatusBadge } from "./ui/StatusBadge";
import styles from "./MemoryPanel.module.css";

interface MemoryPanelProps {
  memories: Resource<LearningMemory[]>;
  usedIds: string[];
  changedIds: string[];
  deletingIds: string[];
  focusRequest: { id: string; nonce: number } | null;
  onDelete: (memoryId: string) => Promise<boolean>;
  onRefresh: () => void;
}

export function MemoryPanel({
  memories,
  usedIds,
  changedIds,
  deletingIds,
  focusRequest,
  onDelete,
  onRefresh,
}: MemoryPanelProps) {
  const { data, loading, error } = memories;

  return (
    <section className={styles.panel} aria-labelledby="memory-panel-title">
      <div className={styles.header}>
        <div>
          <h2 id="memory-panel-title" className={styles.title}>
            <Database size={16} aria-hidden />
            学习记忆
            {data.length > 0 && <span className={styles.count}>{data.length}</span>}
          </h2>
          <p className={styles.sub}>只记录有证据支持的学习状态</p>
        </div>
        <button
          className={styles.refresh}
          onClick={onRefresh}
          disabled={loading}
          aria-label="刷新学习记忆"
          title="刷新"
        >
          <RefreshCw size={15} className={cx(loading && styles.spinning)} />
        </button>
      </div>

      <details className={styles.legend}>
        <summary>状态说明</summary>
        <ul>
          {STATUS_ORDER.map((status) => (
            <li key={status}>
              <StatusBadge status={status} size="sm" />
              <span>{STATUS_META[status].description}</span>
            </li>
          ))}
        </ul>
      </details>

      {error && data.length > 0 && <ErrorNotice error={error} compact onRetry={onRefresh} retryLabel="重新加载" />}

      {loading && data.length === 0 ? (
        <div className={styles.list} aria-busy="true" aria-label="正在加载学习记忆">
          {[0, 1].map((key) => (
            <div key={key} className={styles.skeleton} />
          ))}
        </div>
      ) : error && data.length === 0 ? (
        <ErrorNotice error={error} compact onRetry={onRefresh} retryLabel="重新加载" />
      ) : data.length === 0 ? (
        <div className={styles.empty}>
          <span className={styles.emptyIcon}>
            <Inbox size={20} aria-hidden />
          </span>
          <div className={styles.emptyTitle}>还没有学习记忆</div>
          <p>完成一次作答后，有证据支持的误区会出现在这里，并在下次学习同类题时被参考。</p>
        </div>
      ) : (
        <div className={styles.list}>
          {data.map((memory) => (
            <MemoryCard
              key={memory.id}
              memory={memory}
              used={usedIds.includes(memory.id)}
              changed={changedIds.includes(memory.id)}
              deleting={deletingIds.includes(memory.id)}
              focusNonce={focusRequest?.id === memory.id ? focusRequest.nonce : undefined}
              onDelete={onDelete}
            />
          ))}
        </div>
      )}

      <p className={styles.footnote}>
        <Info size={12} aria-hidden />
        当前作答的证据优先于历史记忆；记忆不准确时可以删除。
      </p>
    </section>
  );
}

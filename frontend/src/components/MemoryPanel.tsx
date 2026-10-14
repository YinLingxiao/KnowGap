import { RefreshCw } from "lucide-react";
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
      <header className={styles.header}>
        <h2 id="memory-panel-title" className={styles.title}>
          学习记忆
          {data.length > 0 && <span className={styles.count}>{data.length}</span>}
        </h2>
        <button
          className={styles.refresh}
          onClick={onRefresh}
          disabled={loading}
          aria-label="刷新学习记忆"
          title="刷新"
        >
          <RefreshCw size={14} className={cx(loading && styles.spinning)} />
        </button>
      </header>
      <p className={styles.sub}>只记录有证据支持的学习状态；当前作答的证据优先于历史记忆。</p>

      <details className={styles.legend}>
        <summary>四种状态的含义</summary>
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
            <div key={key} className={styles.skeleton}>
              <span />
              <span />
              <span />
            </div>
          ))}
        </div>
      ) : error && data.length === 0 ? (
        <ErrorNotice error={error} compact onRetry={onRefresh} retryLabel="重新加载" />
      ) : data.length === 0 ? (
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>还没有学习记忆</p>
          <p>完成一次作答后，有证据支持的误区会记在这里，并在你下次学习同类题时被参考。记录不准确时可以删除。</p>
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
    </section>
  );
}

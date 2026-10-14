"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronRight, RefreshCw, Trash2, X } from "lucide-react";
import type { ApiError } from "@/lib/api/errors";
import type { LearnerMemory, LearnerMemoryStatus, MemoryKind, Subject } from "@/lib/chat/types";
import { cx } from "@/lib/cx";
import { formatRelativeTime } from "@/lib/labels";
import { Button } from "../ui/Button";
import styles from "./MemoryDrawer.module.css";

export const KIND_LABEL: Record<MemoryKind, string> = {
  misconception: "可能的误区",
  mastery: "已掌握",
  preference: "学习偏好",
};

export const STATUS_LABEL: Record<LearnerMemoryStatus, string> = {
  suspected: "待确认",
  needs_review: "需要巩固",
  improving: "改善中",
  resolved: "已解决",
  observed: "有依据",
  uncertain: "不确定",
};

const STATUS_OPTIONS: Record<MemoryKind, LearnerMemoryStatus[]> = {
  misconception: ["suspected", "needs_review", "improving", "resolved"],
  mastery: ["observed", "uncertain"],
  preference: ["observed", "uncertain"],
};

type MemoryPatch = { summary?: string; status?: LearnerMemoryStatus; subjectId?: string | null };

interface MemoryDrawerProps {
  memories: LearnerMemory[];
  subjects: Subject[];
  /** 当前所在的 Subject（对话或 Subject 页），用于默认筛选 */
  contextSubjectId: string | null;
  loading: boolean;
  error: ApiError | null;
  focusIds: string[];
  conversationTitles: Record<string, string>;
  onClose: () => void;
  onRefresh: () => void;
  onUpdate: (id: string, patch: MemoryPatch) => Promise<boolean>;
  onDelete: (id: string) => Promise<boolean>;
  onOpenConversation: (id: string) => void;
}

function MemoryItem({
  memory, subjects, focused, conversationTitles, onUpdate, onDelete, onOpenConversation,
}: {
  memory: LearnerMemory;
  subjects: Subject[];
  focused: boolean;
  conversationTitles: Record<string, string>;
  onUpdate: MemoryDrawerProps["onUpdate"];
  onDelete: MemoryDrawerProps["onDelete"];
  onOpenConversation: MemoryDrawerProps["onOpenConversation"];
}) {
  const [open, setOpen] = useState(focused);
  const [mode, setMode] = useState<"view" | "edit" | "confirm">("view");
  const [summary, setSummary] = useState(memory.summary);
  const [status, setStatus] = useState(memory.status);
  const [scope, setScope] = useState(memory.subjectId ?? "");
  const scopeName = memory.subjectId ? subjects.find((subject) => subject.id === memory.subjectId)?.name ?? "已删除的学习空间" : "通用";
  const [working, setWorking] = useState(false);
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!focused) return;
    setOpen(true);
    ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [focused]);

  return (
    <article ref={ref} className={cx(styles.item, focused && styles.focused)}>
      <button className={styles.head} onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span className={cx(styles.kind, styles[memory.kind])}>{KIND_LABEL[memory.kind]}</span>
        <span className={styles.topic}>{memory.topic}</span>
        <span className={cx(styles.scope, !memory.subjectId && styles.scopeGeneral)}>{scopeName}</span>
        <span className={styles.status}>{STATUS_LABEL[memory.status]}</span>
        <ChevronRight size={13} className={cx(styles.chevron, open && styles.chevronOpen)} aria-hidden />
      </button>

      {mode === "edit" ? (
        <div className={styles.edit}>
          <label className={styles.fieldLabel} htmlFor={`summary-${memory.id}`}>描述</label>
          <textarea
            id={`summary-${memory.id}`}
            className={styles.textarea}
            value={summary}
            maxLength={300}
            rows={3}
            onChange={(event) => setSummary(event.target.value)}
          />
          <label className={styles.fieldLabel} htmlFor={`status-${memory.id}`}>状态</label>
          <select
            id={`status-${memory.id}`}
            className={styles.select}
            value={status}
            onChange={(event) => setStatus(event.target.value as LearnerMemoryStatus)}
          >
            {STATUS_OPTIONS[memory.kind].map((option) => (
              <option key={option} value={option}>{STATUS_LABEL[option]}</option>
            ))}
          </select>
          <label className={styles.fieldLabel} htmlFor={`scope-${memory.id}`}>归属</label>
          <select
            id={`scope-${memory.id}`}
            className={styles.select}
            value={scope}
            onChange={(event) => setScope(event.target.value)}
          >
            <option value="">通用（所有学习空间都可参考）</option>
            {subjects.map((subject) => (
              <option key={subject.id} value={subject.id}>{subject.name}</option>
            ))}
          </select>
          <div className={styles.editActions}>
            <Button size="sm" variant="ghost" onClick={() => setMode("view")} disabled={working}>取消</Button>
            <Button
              size="sm"
              variant="primary"
              loading={working}
              disabled={!summary.trim()}
              onClick={async () => {
                setWorking(true);
                const subjectId = scope || null;
                const ok = await onUpdate(memory.id, {
                  summary: summary.trim(), status,
                  ...(subjectId !== memory.subjectId ? { subjectId } : {}),
                });
                setWorking(false);
                if (ok) setMode("view");
              }}
            >
              保存
            </Button>
          </div>
        </div>
      ) : (
        <p className={styles.summary}>{memory.summary}</p>
      )}

      <div className={styles.meta}>
        <span>{memory.origin === "diagnosis" ? "来自旧版作答诊断" : "来自对话"}</span>
        <span>依据 {memory.evidence.length}</span>
        {memory.userCorrected && <span className={styles.corrected}>你修正过</span>}
        <span>{formatRelativeTime(memory.updatedAt)}</span>
      </div>

      {open && (
        <ol className={styles.evidence}>
          {memory.evidence.map((item, index) => (
            <li key={`${item.messageId}-${index}`}>
              <div className={styles.evidenceHead}>
                <span className={cx(styles.signal, item.signal === "contradicts" && styles.counter)}>
                  {item.signal === "supports" ? "支持" : "反例"}
                </span>
                {item.conversationId && item.sourceAvailable ? (
                  <button className={styles.source} onClick={() => onOpenConversation(item.conversationId!)}>
                    {conversationTitles[item.conversationId] ?? "打开来源对话"}
                  </button>
                ) : (
                  <span className={styles.sourceGone}>来源对话已删除</span>
                )}
                <span className={styles.when}>{formatRelativeTime(item.createdAt)}</span>
              </div>
              <blockquote className={styles.quote}>{item.quote}</blockquote>
              <p className={styles.reason}>{item.reason}</p>
            </li>
          ))}
        </ol>
      )}

      {mode === "confirm" ? (
        <div className={styles.confirm}>
          <span>删除后不会再用于之后的对话。</span>
          <div className={styles.editActions}>
            <Button size="sm" variant="ghost" onClick={() => setMode("view")} disabled={working}>取消</Button>
            <Button
              size="sm"
              variant="danger"
              loading={working}
              onClick={async () => {
                setWorking(true);
                if (!(await onDelete(memory.id))) {
                  setWorking(false);
                  setMode("view");
                }
              }}
            >
              删除
            </Button>
          </div>
        </div>
      ) : mode === "view" && (
        <div className={styles.actions}>
          <button onClick={() => { setSummary(memory.summary); setStatus(memory.status); setScope(memory.subjectId ?? ""); setMode("edit"); }}>纠正</button>
          <button className={styles.deleteAction} onClick={() => setMode("confirm")}>
            <Trash2 size={12} aria-hidden />
            删除
          </button>
        </div>
      )}
    </article>
  );
}

type Filter = "all" | "general" | "subject";

export function MemoryDrawer(props: MemoryDrawerProps) {
  const { loading, error, focusIds, contextSubjectId } = props;
  const groups: MemoryKind[] = ["misconception", "mastery", "preference"];
  const contextSubject = props.subjects.find((subject) => subject.id === contextSubjectId) ?? null;
  const [filter, setFilter] = useState<Filter>(contextSubject ? "subject" : "all");
  useEffect(() => {
    setFilter(contextSubject && !focusIds.length ? "subject" : "all");
  }, [contextSubject, focusIds]);
  const memories = props.memories.filter((memory) =>
    filter === "all" ? true : filter === "general" ? memory.subjectId === null : memory.subjectId === contextSubjectId);
  const filters: Array<{ key: Filter; label: string }> = [
    { key: "all", label: "全部" },
    ...(contextSubject ? [{ key: "subject" as Filter, label: contextSubject.name }] : []),
    { key: "general", label: "通用" },
  ];
  return (
    <section className={styles.drawer} aria-labelledby="memory-title">
      <header className={styles.header}>
        <h2 id="memory-title" className={styles.title}>学习记忆</h2>
        <button className={styles.iconButton} onClick={props.onRefresh} disabled={loading} aria-label="刷新" title="刷新">
          <RefreshCw size={14} className={cx(loading && styles.spinning)} />
        </button>
        <button className={styles.iconButton} onClick={props.onClose} aria-label="关闭学习记忆" title="关闭">
          <X size={16} />
        </button>
      </header>
      <p className={styles.intro}>
        只有在对话里出现明确依据时才会记录，例如你说出的某个理解、完成的练习或明确的学习偏好。只问问题不会被记成薄弱点。
        对话会优先参考本学习空间和通用记录，不够时才参考其他学习空间；不准确的可以纠正归属、内容或直接删除。
      </p>
      <div className={styles.filters} role="radiogroup" aria-label="按归属筛选">
        {filters.map((item) => (
          <button
            key={item.key}
            role="radio"
            aria-checked={filter === item.key}
            className={cx(styles.filter, filter === item.key && styles.filterOn)}
            onClick={() => setFilter(item.key)}
          >
            {item.label}
          </button>
        ))}
      </div>
      {error && <p className={styles.error}>{error.message}</p>}
      {!loading && !error && memories.length === 0 && (
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>{props.memories.length ? "这个范围里还没有记录" : "还没有学习记忆"}</p>
          <p>多聊几句、说说你的理解或做一道练习，有依据的情况会出现在这里。</p>
        </div>
      )}
      {groups.map((kind) => {
        const items = memories.filter((memory) => memory.kind === kind);
        if (!items.length) return null;
        return (
          <div key={kind} className={styles.group}>
            <p className={styles.groupLabel}>{KIND_LABEL[kind]} · {items.length}</p>
            {items.map((memory) => (
              <MemoryItem
                key={memory.id}
                memory={memory}
                subjects={props.subjects}
                focused={focusIds.includes(memory.id)}
                conversationTitles={props.conversationTitles}
                onUpdate={props.onUpdate}
                onDelete={props.onDelete}
                onOpenConversation={props.onOpenConversation}
              />
            ))}
          </div>
        );
      })}
    </section>
  );
}

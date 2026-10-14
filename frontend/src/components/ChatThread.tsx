"use client";

import { useEffect, useRef } from "react";
import { Database, MessageCircle, RotateCcw } from "lucide-react";
import type { ThreadMessage } from "@/hooks/useWorkbench";
import { cx } from "@/lib/cx";
import { formatClock } from "@/lib/labels";
import type { MemoryChange } from "@/lib/types";
import { LogoMark } from "./ui/LogoMark";
import { RichText } from "./ui/RichText";
import { StatusBadge } from "./ui/StatusBadge";
import styles from "./ChatThread.module.css";

interface ChatThreadProps {
  messages: ThreadMessage[];
  sending: boolean;
  onRetry: (messageId: string) => void;
}

export function ChatThread({ messages, sending, onRetry }: ChatThreadProps) {
  const endRef = useRef<HTMLDivElement>(null);
  const previousCount = useRef(messages.length);
  const tutorTurns = messages.filter((message) => message.role === "tutor").length;

  // 有新消息时滚动到底部；首轮不滚动，保证诊断卡片可见
  useEffect(() => {
    const grew = messages.length > previousCount.current;
    previousCount.current = messages.length;
    if ((grew || sending) && messages.length > 1) {
      endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [messages.length, sending]);

  return (
    <section className={styles.thread} aria-labelledby="chat-title">
      <div className={styles.head}>
        <h3 id="chat-title" className={styles.title}>
          <MessageCircle size={16} aria-hidden />
          引导式对话
        </h3>
        <span className={styles.turns}>已进行 {tutorTurns} 轮</span>
      </div>

      <ol className={styles.list} aria-live="polite" aria-relevant="additions">
        {messages.map((message) => (
          <li key={message.id} className={cx(styles.row, message.role === "student" ? styles.student : styles.tutor)}>
            {message.role === "tutor" && (
              <span className={styles.avatar} aria-hidden>
                <LogoMark size={30} />
              </span>
            )}
            <div className={styles.stack}>
              <div className={styles.meta}>
                <span className={styles.author}>{message.role === "tutor" ? "KnowGap 导师" : "我"}</span>
                {message.phase === "hint" && <span className={styles.phaseHint}>提示阶段</span>}
                {message.phase === "answer" && <span className={styles.phaseAnswer}>讲解阶段</span>}
                <span className={styles.time}>{formatClock(message.createdAt)}</span>
              </div>
              <div className={cx(styles.bubble, message.delivery === "failed" && styles.failed)}>
                <RichText text={message.content} />
              </div>
              {message.delivery === "sending" && <span className={styles.delivery}>发送中…</span>}
              {message.delivery === "failed" && (
                <button className={styles.retry} onClick={() => onRetry(message.id)}>
                  <RotateCcw size={12} aria-hidden />
                  发送失败，点击重试
                </button>
              )}
              {message.memoryChanges?.map((change) => (
                <MemoryChangeNote key={`${change.memoryId}-${change.action}-${change.toStatus}`} change={change} />
              ))}
            </div>
          </li>
        ))}

        {sending && (
          <li className={cx(styles.row, styles.tutor)}>
            <span className={styles.avatar} aria-hidden>
              <LogoMark size={30} />
            </span>
            <div className={styles.typing} aria-label="导师正在思考">
              <span />
              <span />
              <span />
            </div>
          </li>
        )}
      </ol>
      <div ref={endRef} className={styles.end} />
    </section>
  );
}

function MemoryChangeNote({ change }: { change: MemoryChange }) {
  const sameStatus = change.fromStatus && change.toStatus && change.fromStatus === change.toStatus;
  const action = change.action === "created" ? "新增" : change.action === "deleted" ? "删除" : sameStatus ? "补充证据" : "更新";

  return (
    <div className={styles.change}>
      <Database size={12} aria-hidden />
      <span className={styles.changeAction}>学习记忆{action}</span>
      {change.summary && <span className={styles.changeSummary}>{change.summary}</span>}
      <span className={styles.changeStatus}>
        {change.fromStatus && !sameStatus && (
          <>
            <StatusBadge status={change.fromStatus} size="sm" />
            <span aria-label="变为">→</span>
          </>
        )}
        {change.toStatus && <StatusBadge status={change.toStatus} size="sm" />}
      </span>
    </div>
  );
}

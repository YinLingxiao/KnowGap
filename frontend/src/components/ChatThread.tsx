"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { GraduationCap, RotateCcw } from "lucide-react";
import type { ThreadMessage } from "@/hooks/useWorkbench";
import { cx } from "@/lib/cx";
import { formatClock } from "@/lib/labels";
import type { Diagnosis, MemoryChange } from "@/lib/types";
import { DiagnosisNote, verdictOf, type Verdict } from "./DiagnosisNote";
import { RichText } from "./ui/RichText";
import { StatusBadge } from "./ui/StatusBadge";
import styles from "./ChatThread.module.css";

interface ChatThreadProps {
  submission: { answer: string; reasoning: string };
  submissionDiagnosis: Diagnosis;
  messages: ThreadMessage[];
  sending: boolean;
  onRetry: (messageId: string) => void;
}

/**
 * 教学记录：首次作答 → 导师追问 → 学生回答……
 * 每条学生回答下方是对应的诊断批注，依据在原文中划线标出。
 */
export function ChatThread({ submission, submissionDiagnosis, messages, sending, onRetry }: ChatThreadProps) {
  const endRef = useRef<HTMLDivElement>(null);
  const previousCount = useRef(messages.length);
  const tutorTurns = messages.filter((message) => message.role === "tutor").length;

  // 有新消息时滚动到底部；首轮不滚动，保证作答与批注可见
  useEffect(() => {
    const grew = messages.length > previousCount.current;
    previousCount.current = messages.length;
    if ((grew || sending) && messages.length > 1) {
      endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [messages.length, sending]);

  // 依据只在一处划线：先找答案，再找解题思路
  const quote = submissionDiagnosis.evidence ?? "";
  const quoteInAnswer = Boolean(quote) && submission.answer.includes(quote);
  const quoteInReasoning = Boolean(quote) && !quoteInAnswer && submission.reasoning.includes(quote);
  const submissionVerdict = verdictOf(submissionDiagnosis);

  return (
    <section className={styles.thread} aria-labelledby="thread-title">
      <header className={styles.head}>
        <h3 id="thread-title" className={styles.title}>
          诊断与引导
        </h3>
        <span className={styles.turns}>导师已回应 {tutorTurns} 轮</span>
      </header>

      <ol className={styles.list} aria-live="polite" aria-relevant="additions">
        <li className={cx(styles.entry, styles.student, styles.submission)}>
          <Avatar role="student" />
          <div className={styles.body}>
            <Meta name="我的作答" />
            <div className={styles.studentBox}>
              <p className={styles.answer}>
                {quoteInAnswer ? <Marked text={submission.answer} quote={quote} verdict={submissionVerdict} /> : submission.answer}
              </p>
              {submission.reasoning && (
                <p className={styles.reasoning}>
                  {quoteInReasoning ? (
                    <Marked text={submission.reasoning} quote={quote} verdict={submissionVerdict} />
                  ) : (
                    submission.reasoning
                  )}
                </p>
              )}
            </div>
            <DiagnosisNote diagnosis={submissionDiagnosis} evidenceMarked={quoteInAnswer || quoteInReasoning} />
          </div>
        </li>

        {messages.map((message) =>
          message.role === "tutor" ? (
            <li key={message.id} className={cx(styles.entry, styles.tutor)}>
              <Avatar role="tutor" />
              <div className={styles.body}>
                <Meta
                  name="导师"
                  time={message.createdAt}
                  detail={message.phase === "answer" ? "讲解" : message.phase === "hint" ? "提示" : undefined}
                />
                <p className={styles.tutorText}>
                  <RichText text={message.content} />
                </p>
                {message.memoryChanges?.map((change) => (
                  <MemoryChangeNote key={`${change.memoryId}-${change.action}-${change.toStatus}`} change={change} />
                ))}
              </div>
            </li>
          ) : (
            <StudentEntry key={message.id} message={message} onRetry={onRetry} />
          ),
        )}

        {sending && (
          <li className={cx(styles.entry, styles.tutor)}>
            <Avatar role="tutor" />
            <div className={styles.typing} aria-label="导师正在思考">
              正在思考
              <span className={styles.dots} aria-hidden>
                <span />
                <span />
                <span />
              </span>
            </div>
          </li>
        )}
      </ol>
      <div ref={endRef} className={styles.end} />
    </section>
  );
}

function StudentEntry({ message, onRetry }: { message: ThreadMessage; onRetry: (messageId: string) => void }) {
  const quote = message.diagnosis?.evidence ?? "";
  const marked = Boolean(quote) && message.content.includes(quote);

  return (
    <li className={cx(styles.entry, styles.student, message.delivery === "failed" && styles.failed)}>
      <Avatar role="student" />
      <div className={styles.body}>
        <Meta name="我" time={message.createdAt} />
        <div className={styles.studentBox}>
          <p className={styles.studentText}>
            {marked && message.diagnosis ? (
              <Marked text={message.content} quote={quote} verdict={verdictOf(message.diagnosis)} />
            ) : (
              message.content
            )}
          </p>
        </div>
        {message.delivery === "sending" && <span className={styles.delivery}>发送中…</span>}
        {message.delivery === "failed" && (
          <button className={styles.retry} onClick={() => onRetry(message.id)}>
            <RotateCcw size={12} aria-hidden />
            未送达，点击核对后重试
          </button>
        )}
        {message.diagnosis && <DiagnosisNote diagnosis={message.diagnosis} evidenceMarked={marked} compact />}
      </div>
    </li>
  );
}

function Avatar({ role }: { role: "student" | "tutor" }) {
  return role === "tutor" ? (
    <span className={cx(styles.avatar, styles.avatarTutor)} aria-hidden>
      <GraduationCap size={13} />
    </span>
  ) : (
    <span className={cx(styles.avatar, styles.avatarStudent)} aria-hidden>
      演
    </span>
  );
}

function Meta({ name, time, detail }: { name: string; time?: string; detail?: ReactNode }) {
  return (
    <div className={styles.meta}>
      <span className={styles.metaName}>{name}</span>
      {detail && <span className={styles.metaChip}>{detail}</span>}
      {time && <span className={styles.metaTime}>{formatClock(time)}</span>}
    </div>
  );
}

/** 在原文中给依据划线：错误用波浪线，正确用实线，不确定用点线 */
function Marked({ text, quote, verdict }: { text: string; quote: string; verdict: Verdict }) {
  const start = text.indexOf(quote);
  if (start < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, start)}
      <mark className={cx(styles.evidence, styles[`evidence-${verdict}`])}>{quote}</mark>
      {text.slice(start + quote.length)}
    </>
  );
}

function MemoryChangeNote({ change }: { change: MemoryChange }) {
  const sameStatus = change.fromStatus && change.toStatus && change.fromStatus === change.toStatus;
  const action = change.action === "created" ? "新增" : change.action === "deleted" ? "删除" : sameStatus ? "补充证据" : "更新";

  return (
    <div className={styles.change}>
      <span className={styles.changeAction}>学习记忆 · {action}</span>
      {change.summary && <span className={styles.changeSummary}>{change.summary}</span>}
      <span className={styles.changeStatus}>
        {change.fromStatus && !sameStatus && (
          <>
            <StatusBadge status={change.fromStatus} size="sm" />
            <span className={styles.arrow} aria-label="变为">
              →
            </span>
          </>
        )}
        {change.toStatus && <StatusBadge status={change.toStatus} size="sm" />}
      </span>
    </div>
  );
}

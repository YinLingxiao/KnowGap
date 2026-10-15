"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { ArrowDown, BookOpenCheck, Brain, CircleAlert, CircleStop, Dumbbell, FileText, GitBranch, RotateCcw } from "lucide-react";
import type { StreamPhase } from "@/hooks/useChat";
import type { ChatMessage, LearnerMemory } from "@/lib/chat/types";
import { cx } from "@/lib/cx";
import type { Problem } from "@/lib/types";
import { CopyButton, Markdown } from "./Markdown";
import styles from "./MessageList.module.css";

const ASSESSMENT: Record<string, { label: string; tone: string }> = {
  correct: { label: "判断正确", tone: styles.good },
  incorrect: { label: "还有问题", tone: styles.warn },
  uncertain: { label: "依据还不够", tone: styles.muted },
};

interface MessageListProps {
  conversationId: string;
  messages: ChatMessage[];
  problems: Record<string, Problem>;
  memoriesById: Record<string, LearnerMemory>;
  /** 当前对话所属 Subject，用于标出来自其他 Subject 的记忆 */
  conversationSubjectId: string | null;
  subjectNames: Record<string, string>;
  phase: StreamPhase | null;
  followNonce: number;
  onRegenerate: () => void;
  onStartExercise: (problemId: string) => void;
  onOpenMemories: (ids: string[]) => void;
  onOpenThread?: (messageId: string) => void;
  onOpenSummary?: (threadId: string) => void;
  onDecideTool?: (approvalId: string, allow: boolean) => void;
}

function ExerciseCard({ problem, fallback }: { problem: Problem | undefined; fallback: string }) {
  return (
    <section className={styles.exercise} aria-label="练习题">
      <header className={styles.exerciseHead}>
        <Dumbbell size={14} aria-hidden />
        <span>练习</span>
        {problem && <strong>{problem.title}</strong>}
      </header>
      {problem ? (
        <>
          <p className={styles.exerciseText}>{problem.statement}</p>
          {problem.inputSequence && problem.outputSequence && (
            <dl className={styles.sequences}>
              <div>
                <dt>入栈顺序</dt>
                <dd>{problem.inputSequence.join("  ")}</dd>
              </div>
              <div>
                <dt>目标出栈序列</dt>
                <dd>{problem.outputSequence.join("  ")}</dd>
              </div>
            </dl>
          )}
        </>
      ) : (
        <Markdown text={fallback} />
      )}
      <p className={styles.exerciseHint}>在下方写下你的判断和理由；也可以先提问，或者直接说想看答案。</p>
    </section>
  );
}

export function MessageList({
  conversationId, messages, problems, memoriesById, conversationSubjectId, subjectNames, phase, followNonce,
  onRegenerate, onStartExercise, onOpenMemories, onOpenThread, onOpenSummary, onDecideTool,
}: MessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [showJump, setShowJump] = useState(false);

  const toBottom = useCallback(() => {
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, []);

  const onScroll = () => {
    const element = scrollRef.current;
    if (!element) return;
    const near = element.scrollHeight - element.scrollTop - element.clientHeight < 96;
    following.current = near;
    setShowJump(!near);
  };

  // 只在用户停留在底部附近时跟随新内容；向上阅读时不抢位置
  useLayoutEffect(() => {
    if (following.current) toBottom();
  }, [messages, toBottom]);

  // 发送新消息、切换会话：回到底部
  useLayoutEffect(() => {
    following.current = true;
    setShowJump(false);
    toBottom();
  }, [followNonce, conversationId, toBottom]);

  const last = messages[messages.length - 1];
  const lastUser = [...messages].reverse().find((message) => message.role === "user");

  return (
    <div className={styles.wrap}>
      <div ref={scrollRef} className={styles.scroll} onScroll={onScroll}>
        <div className={styles.list} role="log" aria-live="polite" aria-relevant="additions">
          {messages.map((message) => {
            if (message.kind === "exercise") {
              return (
                <div key={message.id} className={styles.row}>
                  <ExerciseCard problem={message.problemId ? problems[message.problemId] : undefined} fallback={message.content} />
                </div>
              );
            }
            if (message.role === "user") {
              const attempt = message.attempt ? ASSESSMENT[message.attempt.assessment] : null;
              return (
                <div key={message.id} className={cx(styles.row, styles.userRow)}>
                  <div className={styles.userBubble}>{message.content}</div>
                  <div className={styles.userMeta}>
                    {message.attempt && attempt && (
                      <span className={cx(styles.note, attempt.tone)} title={`依据：${message.attempt.evidence}`}>
                        <BookOpenCheck size={12} aria-hidden />
                        练习 · {attempt.label}
                        {message.attempt.issue && <span className={styles.noteDetail}>：{message.attempt.issue}</span>}
                      </span>
                    )}
                    {message.memoryChanges.length > 0 && (
                      <button
                        className={cx(styles.note, styles.memoryNote)}
                        onClick={() => onOpenMemories(message.memoryChanges.map((change) => change.memory.id))}
                        title="查看、纠正或删除"
                      >
                        <Brain size={12} aria-hidden />
                        {message.memoryChanges[0].action === "created" ? "记下了" : "更新了"}：
                        {message.memoryChanges[0].memory.summary}
                        {message.memoryChanges.length > 1 && ` 等 ${message.memoryChanges.length} 条`}
                      </button>
                    )}
                    <CopyButton text={message.content} className={styles.action} />
                    {onOpenThread && message.status === "complete" && (
                      <button className={styles.action} onClick={() => onOpenThread(message.id)}>
                        <GitBranch size={13} aria-hidden />
                        开 Thread
                      </button>
                    )}
                  </div>
                </div>
              );
            }
            if (message.threadSummary) {
              const card = message.threadSummary;
              const related = card.memoryIds.map((id) => memoriesById[id]).filter(Boolean);
              return (
                <div key={message.id} className={styles.row}>
                  <button className={styles.summary} onClick={() => onOpenSummary?.(card.threadId)}>
                    <span className={styles.summaryTitle}>Thread「{card.title}」已解决</span>
                    <span className={styles.summaryBody}>{card.summary}</span>
                    {card.takeaways.length > 0 && (
                      <ul className={styles.takeaways}>
                        {card.takeaways.map((item) => <li key={item}>{item}</li>)}
                      </ul>
                    )}
                    {related.length > 0 && (
                      <span className={styles.summaryMemories}>
                        {related.map((memory) => memory.summary).join(" · ")}
                      </span>
                    )}
                  </button>
                </div>
              );
            }
            const streaming = message.status === "streaming";
            const isLast = message === last && message.replyTo === lastUser?.id;
            const used = message.usedMemoryIds.filter((id) => memoriesById[id]);
            const outside = [...new Set(used.map((id) => memoriesById[id].subjectId)
              .filter((id): id is string => Boolean(id) && id !== conversationSubjectId))];
            const outsideCount = used.filter((id) => outside.includes(memoriesById[id].subjectId ?? "")).length;
            const suggested = message.suggestedProblemId ? problems[message.suggestedProblemId] : undefined;
            return (
              <div key={message.id} className={cx(styles.row, styles.assistantRow)}>
                {message.toolCalls.length > 0 && (
                  <div className={styles.tools}>
                    {message.toolCalls.map((call) => (
                      <details key={call.id} className={styles.tool} open={!call.output}>
                        <summary>{call.name}{call.output ? (call.ok ? "" : " · 未成功") : " · 进行中"}</summary>
                        {call.arguments && <pre>{call.arguments}</pre>}
                        {call.output && <pre>{call.output}</pre>}
                      </details>
                    ))}
                  </div>
                )}
                {message.pendingApproval && onDecideTool && (
                  <div className={styles.approval}>
                    <p>允许执行 {message.pendingApproval.name}？</p>
                    <pre>{message.pendingApproval.arguments}</pre>
                    <div>
                      <button onClick={() => onDecideTool(message.pendingApproval!.id, false)}>拒绝</button>
                      <button onClick={() => onDecideTool(message.pendingApproval!.id, true)}>允许</button>
                    </div>
                  </div>
                )}
                {message.content ? (
                  <div className={cx(streaming && styles.streaming)}>
                    <Markdown text={message.content} />
                  </div>
                ) : streaming ? (
                  <p className={styles.thinking} role="status">
                    <span className={styles.dots} aria-hidden>
                      <i />
                      <i />
                      <i />
                    </span>
                    正在思考
                  </p>
                ) : null}

                {message.status === "failed" && (
                  <div className={styles.failure} role="alert">
                    <CircleAlert size={14} aria-hidden />
                    <div>
                      <p className={styles.failureTitle}>{message.content ? "回复中断" : "没有拿到回复"}</p>
                      <p>{message.error ?? "模型请求失败。"}</p>
                    </div>
                    {isLast && (
                      <button className={styles.inlineButton} onClick={onRegenerate} disabled={phase !== null && phase !== "analyzing"}>
                        <RotateCcw size={13} aria-hidden />
                        重试
                      </button>
                    )}
                  </div>
                )}
                {message.status === "cancelled" && (
                  <p className={styles.stopped}>
                    <CircleStop size={13} aria-hidden />
                    {message.content ? "已停止生成，上面是停止前的部分。" : "已停止生成。"}
                  </p>
                )}
                {message.truncated && <p className={styles.stopped}>回复达到长度上限，可以让我继续说完。</p>}

                {message.sources.length > 0 && (
                  <ul className={styles.sources}>
                    {message.sources.map((source) => (
                      <li key={source.id} title={source.excerpt}>
                        <FileText size={12} aria-hidden />
                        {source.label} · {source.title}
                        {source.page ? ` · 第 ${source.page} 页` : ""}
                      </li>
                    ))}
                  </ul>
                )}

                {!streaming && (
                  <div className={styles.assistantMeta}>
                    {used.length > 0 && (
                      <button className={cx(styles.note, styles.memoryNote)} onClick={() => onOpenMemories(used)}>
                        <Brain size={12} aria-hidden />
                        参考了 {used.length} 条学习记忆
                        {outside.length > 0 &&
                          `（${outsideCount} 条来自「${subjectNames[outside[0]] ?? "其他学习空间"}」${outside.length > 1 ? "等" : ""}）`}
                      </button>
                    )}
                    {suggested && (
                      <button
                        className={cx(styles.note, styles.exerciseNote)}
                        onClick={() => onStartExercise(suggested.id)}
                        disabled={phase !== null && phase !== "analyzing"}
                      >
                        <Dumbbell size={12} aria-hidden />
                        做这道练习：{suggested.title}
                      </button>
                    )}
                    {onOpenThread && message.status === "complete" && (
                      <button className={styles.action} onClick={() => onOpenThread(message.id)}>
                        <GitBranch size={13} aria-hidden />
                        开 Thread
                      </button>
                    )}
                    {message.content && message.status !== "failed" && <CopyButton text={message.content} className={styles.action} />}
                    {isLast && message.status !== "failed" && (
                      <button className={styles.action} onClick={onRegenerate} disabled={phase !== null && phase !== "analyzing"}>
                        <RotateCcw size={13} aria-hidden />
                        <span>重新生成</span>
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {last?.role === "user" && phase === null && (
            <div className={cx(styles.row, styles.assistantRow)}>
              <div className={styles.failure}>
                <CircleAlert size={14} aria-hidden />
                <div>
                  <p className={styles.failureTitle}>这条消息还没有回复</p>
                  <p>生成可能在刷新或断网时中断了。</p>
                </div>
                <button className={styles.inlineButton} onClick={onRegenerate}>
                  <RotateCcw size={13} aria-hidden />
                  生成回复
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
      {showJump && (
        <button className={styles.jump} onClick={() => { following.current = true; setShowJump(false); toBottom(); }}>
          <ArrowDown size={14} aria-hidden />
          回到底部
        </button>
      )}
    </div>
  );
}

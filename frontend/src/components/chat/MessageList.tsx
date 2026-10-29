"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowDown, BookOpenCheck, Brain, CheckCircle2, ChevronDown, ChevronRight, ChevronUp,
  Circle, CircleAlert, CircleDashed, CircleStop, CornerDownRight, Dumbbell, FileDown, FileText, Pin, PinOff,
  RotateCcw, Zap,
} from "lucide-react";
import type { StreamPhase } from "@/hooks/useChat";
import { toApiError } from "@/lib/api/errors";
import { chatApi } from "@/lib/chat/api";
import { parseFileMarkers } from "@/lib/chat/attachments";
import { createMaterialClient } from "@/lib/api/material-client";
import type { ChatMessage, LearnerMemory } from "@/lib/chat/types";
import { cx } from "@/lib/cx";
import { useI18n } from "@/components/LanguageProvider";
import type { MessageKey } from "@/lib/i18n";
import { useSmoothText } from "@/hooks/useSmoothText";
import type { Problem } from "@/lib/types";
import { CopyButton, Markdown } from "./Markdown";
import { FileCard, kindFromName, openFileLibrary, recalledFile, rememberFile, scaleOf } from "./FileCard";
import { SELECTABLE_ATTR, SelectionToolbar } from "./SelectionToolbar";
import { GeneratedFiles } from "./GeneratedFiles";
import { ReasoningBlock } from "./ReasoningBlock";
import { WorkingIndicator } from "./WorkingIndicator";
import { ThreadProposals } from "./ThreadProposals";
import { VisionMarkedText } from "./widgets/ImageMarker";
import type { PlanChange } from "@/lib/chat/plan";
import { AGENDA_TOOLS, AgendaToolCard } from "./AgendaToolCard";
import { hasVisionMarker } from "./widgets/visionData";
import styles from "./MessageList.module.css";

const ASSESSMENT: Record<string, { labelKey: MessageKey; tone: string }> = {
  correct: { labelKey: "messages.assessment.correct", tone: styles.good },
  incorrect: { labelKey: "messages.assessment.incorrect", tone: styles.warn },
  uncertain: { labelKey: "messages.assessment.uncertain", tone: styles.muted },
};

const TOOL_LABELS: Record<string, string> = {
  read: "读取工作区文件",
  write: "写入工作区文件",
  edit: "修改工作区文件",
  bash: "执行终端命令",
  session_search: "检索历史会话",
  memory: "更新长期笔记",
  agenda_list: "查看日程",
  agenda_add: "写入日程",
  agenda_update: "调整日程",
  create_document: "生成文件",
  edit_document: "修改文件",
  read_document: "读取文件",
};

/** 超过该字符数或行数的消息可折叠 */
const FOLD_CHARS = 650;
const FOLD_LINES = 14;
const PIN_KEY_PREFIX = "knowgap.pins.v1.";
const SAVE_TO_PAGE_EVENT = "knowgap:save-to-page";

/** 流式回复先过一道平滑显示，再交给 Markdown 渲染 */
function SmoothMarkdown({ text, live }: { text: string; live: boolean }) {
  return <Markdown text={useSmoothText(text, live)} />;
}

function isLongText(text: string): boolean {
  return text.length > FOLD_CHARS || text.split("\n").length > FOLD_LINES;
}

/** 粗略估算 token：中日韩字符约 0.75 token/字，其余约 4 字符 1 token（非计费口径） */
function estimateTokens(text: string): number {
  const cjk = (text.match(/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\uf900-\ufaff]/g) ?? []).length;
  return Math.max(1, Math.round(cjk * 0.75 + (text.length - cjk) / 4));
}

function readPins(conversationId: string): string[] {
  try {
    const raw = localStorage.getItem(PIN_KEY_PREFIX + conversationId);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function pinPreview(text: string): string {
  const { files, body } = parseFileMarkers(text);
  text = [files.map((file) => file.name).join("、"), body].filter(Boolean).join(" · ");
  const flat = text.replace(/```[\s\S]*?```/g, " ").replace(/[#>*_`~]/g, "").replace(/\s+/g, " ").trim();
  return flat.length > 30 ? `${flat.slice(0, 30)}…` : flat || "（无文字内容）";
}

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
  /** 会话流顶部插槽（如学习空间的 Today 分割线与开场引导） */
  topSlot?: ReactNode;
  onRegenerate: () => void;
  onStartExercise: (problemId: string) => void;
  onOpenMemories: (ids: string[]) => void;
  onOpenSummary?: (threadId: string) => void;
  onConfirmProposal?: (messageId: string, proposalId: string) => Promise<string>;
  onResumeCheckpoint?: (messageId: string) => Promise<void>;
  onDecideTool?: (approvalId: string, allow: boolean) => void;
  onSendText?: (text: string) => void;
  onOpenWeakPoints?: () => void;
  /** 外层若提供导航回调可无刷新打开资料；未提供时复用既有视图恢复机制。 */
  onOpenFile?: (documentId: string, subjectId: string | null) => void;
  collapseLong?: boolean;
  scrollTarget?: { messageId: string | null; threadId: string; nonce: number } | null;
}

const NEXT_LABEL = { quiz: "考考我", schedule: "排进日程", save_note: "存进笔记", weak_points: "看看我的薄弱点" } as const;
const NEXT_TEXT = { quiz: "考考我", schedule: "把接下来的复习排进日程", save_note: "把刚才讲的存进笔记" } as const;

function useSummaryCard() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const read = () => setVisible(Boolean(document.querySelector('[aria-label="学习小结"]')));
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);
  return visible;
}

function ExerciseCard({ problem, fallback }: { problem: Problem | undefined; fallback: string }) {
  const { t } = useI18n();
  return (
    <section className={styles.exercise} aria-label={t("messages.exerciseAria")}>
      <header className={styles.exerciseHead}>
        <Dumbbell size={13} aria-hidden />
        <span>{t("messages.exercise")}</span>
        {problem && <strong>{problem.title}</strong>}
      </header>
      {problem ? (
        <>
          <p className={styles.exerciseText}>{problem.statement}</p>
          {problem.inputSequence && problem.outputSequence && (
            <dl className={styles.sequences}>
              <div>
                <dt>{t("messages.pushOrder")}</dt>
                <dd>{problem.inputSequence.join("  ")}</dd>
              </div>
              <div>
                <dt>{t("messages.popOrder")}</dt>
                <dd>{problem.outputSequence.join("  ")}</dd>
              </div>
            </dl>
          )}
        </>
      ) : (
        <Markdown text={fallback} />
      )}
      <p className={styles.exerciseHint}>{t("messages.exerciseHint")}</p>
    </section>
  );
}

function ResumeCheckpoint({ onResume }: { onResume: () => Promise<void> }) {
  const { t } = useI18n();
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const resume = async () => {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError("");
    try { await onResume(); }
    catch (error) { setError(toApiError(error).message); }
    finally { busy.current = false; setPending(false); }
  };
  return (
    <span>
      <button className={styles.inlineButton} onClick={() => void resume()} disabled={pending} aria-busy={pending}>
        <RotateCcw size={13} aria-hidden />{pending ? t("messages.restoring") : t("messages.resume")}
      </button>
      {error && <span className={styles.resumeError} role="alert">{error}</span>}
    </span>
  );
}

const EXECUTION_LABEL: Record<string, string> = {
  queued: "排队中", working: "进行中", waiting: "待确认", idle: "空闲", failed: "失败", cancelled: "已取消",
};

const PLAN_MARK: Record<string, { label: string; tone: "done" | "ask" | "start" | "skip" }> = {
  done: { label: "完成", tone: "done" },
  awaiting_learner: { label: "等你回答", tone: "ask" },
  in_progress: { label: "开始", tone: "start" },
  skipped: { label: "跳过", tone: "skip" },
};

/** 每个步骤只保留本轮最后一次变化；新增为待开始的步骤不单独标记 */
function planMarksOf(changes: PlanChange[] | undefined) {
  const last = new Map<string, PlanChange>();
  for (const change of changes ?? []) last.set(change.stepId || change.title, change);
  return [...last.entries()]
    .filter(([, change]) => PLAN_MARK[change.to])
    .map(([key, change]) => ({ key, title: change.title, ...PLAN_MARK[change.to] }));
}

export function MessageList({
  conversationId, messages, problems, memoriesById, conversationSubjectId, subjectNames, phase, followNonce, topSlot,
  onRegenerate, onStartExercise, onOpenMemories, onOpenSummary, onDecideTool, onConfirmProposal, onResumeCheckpoint,
  onSendText, onOpenWeakPoints, onOpenFile, collapseLong = true, scrollTarget,
}: MessageListProps) {
  const { t } = useI18n();
  const summaryCard = useSummaryCard();
  const [fileNavigationError, setFileNavigationError] = useState("");
  const [, refreshFileMetadata] = useState(0);
  const missingFileIds = [...new Set(messages.filter((message) => message.role === "user")
    .flatMap((message) => parseFileMarkers(message.content).files.map((file) => file.id)))]
    .filter((id) => !recalledFile(id)).join(",");
  useEffect(() => {
    if (!missingFileIds) return;
    let cancelled = false;
    void createMaterialClient().list(conversationSubjectId ? { subjectId: conversationSubjectId } : { unassigned: true })
      .then((materials) => {
        if (cancelled) return;
        const wanted = new Set(missingFileIds.split(","));
        for (const material of materials) {
          if (!wanted.has(material.id)) continue;
          const kind = kindFromName(material.title);
          rememberFile({ id: material.id, name: material.title, kind, units: material.pageCount,
            unitLabel: kind === "pptx" ? "张幻灯片" : kind === "xlsx" ? "个工作表" : kind === "docx" ? "节" : "页",
            chars: 0, outline: [], subjectId: material.subjectId ?? null, notes: [] });
        }
        refreshFileMetadata((version) => version + 1);
      }).catch(() => { /* 资料服务暂不可用时仍显示文件名与类型 */ });
    return () => { cancelled = true; };
  }, [conversationSubjectId, missingFileIds]);
  const [settledPrompts, setSettledPrompts] = useState<Set<string>>(new Set());
  const [sentActions, setSentActions] = useState<Set<string>>(new Set());
  const decidePreference = (id: string, allow: boolean) => {
    setSettledPrompts((current) => new Set(current).add(id));
    void chatApi.decidePreference(id, allow).catch(() => {
      setSettledPrompts((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    });
  };
  const scrollRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const [foldOverride, setFoldOverride] = useState<Record<string, boolean>>({});
  const [savedId, setSavedId] = useState<string | null>(null);
  const [pinState, setPinState] = useState(() => ({ conversationId, ids: readPins(conversationId) }));
  if (pinState.conversationId !== conversationId) {
    setPinState({ conversationId, ids: readPins(conversationId) });
  }
  const pinnedIds = pinState.conversationId === conversationId ? pinState.ids : [];

  const togglePin = (messageId: string) => {
    const next = pinnedIds.includes(messageId) ? pinnedIds.filter((id) => id !== messageId) : [...pinnedIds, messageId];
    setPinState({ conversationId, ids: next });
    try { localStorage.setItem(PIN_KEY_PREFIX + conversationId, JSON.stringify(next)); } catch { /* ignore */ }
  };

  const jumpToMessage = (messageId: string) => {
    const target = scrollRef.current?.querySelector<HTMLElement>(`[data-msg-id="${CSS.escape(messageId)}"]`);
    if (!target) return;
    following.current = false;
    target.scrollIntoView({ block: "start", behavior: "smooth" });
    target.classList.add(styles.flash);
    window.setTimeout(() => target.classList.remove(styles.flash), 1600);
  };

  const saveToPage = (message: ChatMessage) => {
    window.dispatchEvent(new CustomEvent(SAVE_TO_PAGE_EVENT, { detail: { content: message.content } }));
    setSavedId(message.id);
    window.setTimeout(() => setSavedId((current) => (current === message.id ? null : current)), 1800);
  };

  /** 超长且非流式的消息可折叠；用户长消息默认折叠，AI 回复默认展开 */
  const foldState = (message: ChatMessage) => {
    if (!collapseLong) return { long: false, folded: false };
    const long = message.status !== "streaming" && message.content !== "" && isLongText(message.content);
    const folded = long && (foldOverride[message.id] ?? message.role === "user");
    return { long, folded };
  };
  const toggleFold = (message: ChatMessage, folded: boolean) =>
    setFoldOverride((prev) => ({ ...prev, [message.id]: !folded }));

  const pinnedMessages = pinnedIds
    .map((id) => messages.find((message) => message.id === id))
    .filter((message): message is ChatMessage => Boolean(message));

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

  useLayoutEffect(() => {
    if (following.current) toBottom();
  }, [messages, toBottom]);

  useEffect(() => {
    if (!scrollTarget) return;
    const root = scrollRef.current;
    if (!root) return;
    const byId = scrollTarget.messageId
      ? root.querySelector<HTMLElement>(`[data-msg-id="${CSS.escape(scrollTarget.messageId)}"]`)
      : null;
    const target = byId ?? root.querySelector<HTMLElement>(`[data-thread-summary="${CSS.escape(scrollTarget.threadId)}"]`);
    if (!target) return;
    following.current = false;
    setShowJump(true);
    const reduced = document.documentElement.dataset.motion === "reduced"
      || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    target.scrollIntoView({ block: "center", behavior: reduced ? "auto" : "smooth" });
    target.classList.add(styles.flash);
    const timer = window.setTimeout(() => target.classList.remove(styles.flash), 1600);
    return () => window.clearTimeout(timer);
  }, [scrollTarget]);

  useLayoutEffect(() => {
    following.current = true;
    setShowJump(false);
    toBottom();
  }, [followNonce, conversationId, toBottom]);

  const last = messages[messages.length - 1];
  const lastUser = [...messages].reverse().find((message) => message.role === "user");
  const firstLatestTurnIdx = lastUser
    ? messages.findIndex((m, idx) => idx > messages.indexOf(lastUser) && m.role === "assistant")
    : -1;

  return (
    <div className={styles.wrap}>
      <div ref={scrollRef} className={styles.scroll} onScroll={onScroll}>
        <div className={styles.list} role="log" aria-live="polite" aria-relevant="additions">
          {topSlot}
          {fileNavigationError && <p className={styles.fileNavigationError} role="alert">{fileNavigationError}</p>}
          {pinnedMessages.length > 0 && (
            <nav className={styles.pinBar} aria-label={t("messages.pinBar")}>
              <Pin size={12} className={styles.pinBarIcon} aria-hidden />
              <span className={styles.pinCount}>{String(pinnedMessages.length).padStart(2, "0")}</span>
              {pinnedMessages.map((pinned, pinIdx) => (
                <button
                  key={pinned.id}
                  type="button"
                  className={styles.pinChip}
                  onClick={() => jumpToMessage(pinned.id)}
                  title={pinPreview(pinned.content)}
                >
                  <span className={styles.pinIndex} aria-hidden>{String(pinIdx + 1).padStart(2, "0")}</span>
                  <span className={styles.pinText}>{pinPreview(pinned.content)}</span>
                </button>
              ))}
            </nav>
          )}
          {messages.map((message, index) => {
            if (message.kind === "exercise") {
              return (
                <div key={message.id} className={styles.row}>
                  <ExerciseCard problem={message.problemId ? problems[message.problemId] : undefined} fallback={message.content} />
                </div>
              );
            }
            if (message.role === "user") {
              const { files, body } = parseFileMarkers(message.content);
              const attempt = message.attempt ? ASSESSMENT[message.attempt.assessment] : null;
              // 统计紧随这条用户消息之后的支线进展更新数
              let replyUpdates = 0;
              for (let j = index + 1; j < messages.length; j += 1) {
                if (messages[j].role === "user") break;
                if (messages[j].threadUpdate || messages[j].threadSummary) replyUpdates += 1;
              }
              const userFold = foldState({ ...message, content: body });
              const userPinned = pinnedIds.includes(message.id);
              return (
                <div key={message.id} data-msg-id={message.id} className={cx(styles.row, styles.userRow)}>
                  {files.length > 0 && <div className={styles.userFiles} role="list" aria-label={t("messages.attachments")}>
                    {files.map((file) => {
                      const attachment = recalledFile(file.id);
                      return <FileCard key={file.id} name={attachment?.name ?? file.name} kind={attachment?.kind}
                        scale={attachment ? scaleOf(attachment) : undefined} notes={attachment?.notes} onOpen={() => {
                          if (onOpenFile) { onOpenFile(file.id, conversationSubjectId); return; }
                          if (phase === "connecting" || phase === "streaming") {
                            setFileNavigationError(t("messages.fileNavWait"));
                            return;
                          }
                          try { openFileLibrary(conversationSubjectId); }
                          catch (error) { setFileNavigationError(error instanceof Error ? error.message : t("messages.fileNavFallback")); }
                        }} />;
                    })}
                  </div>}
                  {body && <div className={cx(styles.userBubble, userFold.folded && styles.folded)}>
                    {hasVisionMarker(body) ? <VisionMarkedText text={body} /> : body}
                  </div>}
                  <div className={styles.userMeta}>
                    {userFold.long && (
                      <button className={styles.foldToggle} onClick={() => toggleFold(message, userFold.folded)} aria-expanded={!userFold.folded}>
                        {userFold.folded ? <ChevronDown size={12} aria-hidden /> : <ChevronUp size={12} aria-hidden />}
                        {userFold.folded ? t("messages.expand") : t("messages.collapse")}
                      </button>
                    )}
                    {replyUpdates > 0 && (
                      <span className={styles.replyCount}>
                        <CornerDownRight size={11} aria-hidden />
                        {replyUpdates} {replyUpdates === 1 ? "reply" : "replies"}
                      </span>
                    )}
                    {message.attempt && attempt && (
                      <span className={cx(styles.note, attempt.tone)} title={t("messages.evidenceTitle", { evidence: message.attempt.evidence })}>
                        <BookOpenCheck size={12} aria-hidden />
                        {t("messages.exerciseResult", { label: t(attempt.labelKey) })}
                        {message.attempt.issue && <span className={styles.noteDetail}>{t("messages.issue", { issue: message.attempt.issue })}</span>}
                      </span>
                    )}
                    {message.memoryChanges.length > 0 && (
                      <button
                        className={cx(styles.note, styles.memoryNote)}
                        onClick={() => onOpenMemories(message.memoryChanges.map((change) => change.memory.id))}
                        title={t("messages.viewMemory")}
                      >
                        <Brain size={12} aria-hidden />
                        {message.memoryChanges[0].action === "created" ? t("messages.memoryCreated") : t("messages.memoryUpdated")}
                        {message.memoryChanges[0].memory.summary}
                        {message.memoryChanges.length > 1 && t("messages.memoryMore", { count: message.memoryChanges.length })}
                      </button>
                    )}
                    <button
                      className={cx(styles.action, userPinned && styles.actionOn)}
                      onClick={() => togglePin(message.id)}
                      aria-pressed={userPinned}
                      title={userPinned ? t("messages.unpinTitle") : t("messages.pinTitle")}
                    >
                      {userPinned ? <PinOff size={13} aria-hidden /> : <Pin size={13} aria-hidden />}
                      <span>{userPinned ? t("messages.unpin") : t("messages.pin")}</span>
                    </button>
                    <CopyButton text={message.content} className={styles.action} />
                  </div>
                </div>
              );
            }
            const showNewDivider = index === firstLatestTurnIdx && Boolean(conversationSubjectId);
            if (message.threadUpdate) {
              const card = message.threadUpdate;
              const isIdle = card.status === "idle";
              return (
                <div key={message.id} className={styles.row}>
                  {showNewDivider && (
                    <div className={styles.newLine} aria-hidden>
                      <span>New</span>
                    </div>
                  )}
                  <button
                    type="button"
                    className={styles.threadPill}
                    onClick={() => onOpenSummary?.(card.threadId)}
                    title={card.summary}
                  >
                    <i className={cx(styles.pillDot, isIdle ? styles.dot_hollow : styles[`dot_${card.status}`])} aria-hidden />
                    <span className={styles.pillId}>{EXECUTION_LABEL[card.status] ?? card.status}</span>
                    <span className={styles.pillTitle}>{card.title}</span>
                    {card.summary && <span className={styles.pillSummary}>{card.summary}</span>}
                  </button>
                </div>
              );
            }
            if (message.threadSummary) {
              const card = message.threadSummary;
              return (
                <div key={message.id} data-msg-id={message.id} data-thread-summary={card.threadId} className={styles.row}>
                  {showNewDivider && (
                    <div className={styles.newLine} aria-hidden>
                      <span>New</span>
                    </div>
                  )}
                  <button
                    type="button"
                    className={styles.resolvedThread}
                    onClick={() => onOpenSummary?.(card.threadId)}
                    aria-label={t("messages.threadResolvedAria", { title: card.title })}
                    title={card.title}
                  >
                    <CheckCircle2 size={16} aria-hidden />
                    <span className={styles.resolvedThreadTitle}>{card.title}</span>
                  </button>
                </div>
              );
            }
            const streaming = message.status === "streaming";
            const isLast = message === last && message.replyTo === lastUser?.id;
            // 计划属于整段对话，由输入框上方的计划条展示；这里只在发生变化的回复里留一行时间线标记
            const planMarks = planMarksOf(message.planChanges);
            const visibleTools = message.toolCalls.filter((call) => ![
              "dispatch_thread", "propose_threads", "report_progress", "exercise_reference", "plan_steps", "update_plan",
            ].includes(call.name) && !AGENDA_TOOLS.has(call.name));
            const runningTool = streaming ? visibleTools.find((call) => !call.output) : undefined;
            const agendaCalls = message.toolCalls.filter((call) => AGENDA_TOOLS.has(call.name) && call.name !== "agenda_list");
            const used = message.usedMemoryIds.filter((id) => memoriesById[id]);
            const outside = [...new Set(used.map((id) => memoriesById[id].subjectId)
              .filter((id): id is string => Boolean(id) && id !== conversationSubjectId))];
            const outsideCount = used.filter((id) => outside.includes(memoriesById[id].subjectId ?? "")).length;
            const suggested = message.suggestedProblemId ? problems[message.suggestedProblemId] : undefined;
            const fold = foldState(message);
            const pinned = pinnedIds.includes(message.id);
            const finished = message.status === "complete" && message.content !== "";
            return (
              <div key={message.id} data-msg-id={message.id} className={cx(styles.row, styles.assistantRow)}>
                {showNewDivider && (
                  <div className={styles.newLine} aria-hidden>
                    <span>New</span>
                  </div>
                )}
                {planMarks.length > 0 && (
                  <div className={styles.planMarks} role="status">
                    {planMarks.map((mark) => (
                      <span key={mark.key} className={cx(styles.planMark, styles[`planMark_${mark.tone}`])}>
                        {mark.tone === "done" ? <CheckCircle2 size={12} aria-hidden />
                          : mark.tone === "ask" ? <CircleAlert size={12} aria-hidden />
                            : <Circle size={12} aria-hidden />}
                        <span>{mark.label}：{mark.title}</span>
                      </span>
                    ))}
                  </div>
                )}
                {agendaCalls.map((call) => <AgendaToolCard key={call.id} call={call} />)}
                {visibleTools.length > 0 && (
                  <div className={cx(styles.toolChecklist, styles.traceBox)}>
                    <div className={styles.traceHead}>
                      <span className={styles.traceTitle}>{t("messages.toolCalls")}</span>
                      <span className={styles.traceBadge}>
                        {t("messages.toolSteps", { done: visibleTools.filter((call) => Boolean(call.output)).length, total: visibleTools.length })}
                      </span>
                    </div>
                    {visibleTools.map((call) => {
                      const done = Boolean(call.output);
                      return (
                        <details key={call.id} className={styles.toolCheckItem}>
                          <summary>
                            <ChevronRight size={12} className={styles.traceChevron} aria-hidden />
                            {done ? (
                              call.ok ? (
                                <CheckCircle2 size={14} className={styles.toolIconDone} aria-hidden />
                              ) : (
                                <CircleAlert size={14} className={styles.toolIconFail} aria-hidden />
                              )
                            ) : (
                              <CircleDashed size={14} className={styles.toolIconSpin} aria-hidden />
                            )}
                            <span className={styles.toolName}>{TOOL_LABELS[call.name] ?? call.name}</span>
                            <span className={styles.toolStatus}>{done ? (call.ok ? t("messages.toolDone") : t("messages.toolStatusFailed")) : t("messages.toolRunningShort")}</span>
                          </summary>
                          {call.arguments && <pre>{call.arguments}</pre>}
                          {call.output && <pre>{call.output}</pre>}
                        </details>
                      );
                    })}
                  </div>
                )}
                {message.pendingApproval && onDecideTool && (
                  <div className={styles.approval}>
                    <p>{t("messages.allowTool", { name: TOOL_LABELS[message.pendingApproval.name] ?? message.pendingApproval.name })}</p>
                    <pre>{message.pendingApproval.arguments}</pre>
                    <div>
                      <button onClick={() => onDecideTool(message.pendingApproval!.id, false)}>{t("messages.deny")}</button>
                      <button className={styles.approvalPrimary} onClick={() => onDecideTool(message.pendingApproval!.id, true)}>{t("messages.allow")}</button>
                    </div>
                  </div>
                )}
                {message.reasoning && (
                  <ReasoningBlock text={message.reasoning} streaming={streaming} answering={message.content !== ""} />
                )}
                {message.content ? (
                  <>
                    <div
                      className={cx(streaming && styles.streaming, fold.folded && styles.folded)}
                      {...(!streaming && { [SELECTABLE_ATTR]: "" })}
                      {...(finished && message.content.length >= 80 ? { "data-coachmark": "select" } : {})}
                    >
                      <SmoothMarkdown text={message.content} live={streaming} />
                    </div>
                    {fold.long && (
                      <button
                        className={cx(styles.foldToggle, styles.foldToggleBlock)}
                        onClick={() => toggleFold(message, fold.folded)}
                        aria-expanded={!fold.folded}
                      >
                        {fold.folded ? <ChevronDown size={12} aria-hidden /> : <ChevronUp size={12} aria-hidden />}
                        {fold.folded ? t("messages.expand") : t("messages.collapse")}
                      </button>
                    )}
                  </>
                ) : streaming && !message.reasoning ? (
                  <WorkingIndicator label={runningTool ? t("messages.thinkingTool", { name: TOOL_LABELS[runningTool.name] ?? runningTool.name }) : t("messages.thinking")} />
                ) : null}

                {message.files && message.files.length > 0 && <GeneratedFiles files={message.files} />}

                {message.threadProposals && message.threadProposals.length > 0 && (
                  <ThreadProposals
                    proposals={message.threadProposals}
                    disabled={message.status !== "complete"}
                    onConfirm={onConfirmProposal ? (id) => onConfirmProposal(message.id, id) : undefined}
                    onOpen={onOpenSummary}
                  />
                )}

                {message.status === "failed" && (
                  <div className={styles.failure} role="alert">
                    <CircleAlert size={14} aria-hidden />
                    <div>
                      <p className={styles.failureTitle}>{message.content ? t("messages.interrupted") : t("messages.noResponse")}</p>
                      <p>{message.error ?? t("messages.modelFailed")}</p>
                      {message.checkpointBlockedReason && <p>{message.checkpointBlockedReason}</p>}
                    </div>
                    {message.checkpointAvailable && onResumeCheckpoint ? (
                      <ResumeCheckpoint onResume={() => onResumeCheckpoint(message.id)} />
                    ) : isLast && !message.checkpointBlockedReason && (
                      <button className={styles.inlineButton} onClick={onRegenerate} disabled={phase !== null && phase !== "analyzing"}>
                        <RotateCcw size={13} aria-hidden />
                        {t("common.retry")}                      </button>
                    )}
                  </div>
                )}
                {message.status === "cancelled" && (
                  <p className={styles.stopped}>
                    <CircleStop size={13} aria-hidden />
                    {message.content ? t("messages.stoppedPartial") : t("messages.stopped")}
                  </p>
                )}
                {message.truncated && <p className={styles.stopped}>{t("messages.truncated")}</p>}

                {finished && (message.preferencePrompt || message.nextActions?.length > 0) && (
                  <div className={styles.nudges}>
                    {message.preferencePrompt && !settledPrompts.has(message.preferencePrompt.id) && (
                      <p className={styles.nudge}>
                        <span>{message.preferencePrompt.text}</span>
                        <button type="button" onClick={() => decidePreference(message.preferencePrompt!.id, true)}>{t("messages.rememberPreference")}</button>
                        <button type="button" onClick={() => decidePreference(message.preferencePrompt!.id, false)}>{t("messages.dismissPreference")}</button>
                      </p>
                    )}
                    <div className={styles.nudge}>
                      {(message.nextActions ?? []).filter((action) => {
                        if (sentActions.has(`${message.id}:${action}`)) return false;
                        if ((action === "schedule" || action === "save_note") && summaryCard) return false;
                        if (action === "weak_points") return Boolean(onOpenWeakPoints);
                        return Boolean(onSendText);
                      }).map((action) => (
                        <button
                          key={action}
                          type="button"
                          className={styles.nextBtn}
                          onClick={() => {
                            setSentActions((current) => new Set(current).add(`${message.id}:${action}`));
                            if (action === "weak_points") onOpenWeakPoints?.();
                            else onSendText?.(NEXT_TEXT[action]);
                          }}
                        >
                          {NEXT_LABEL[action]}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {message.sources.length > 0 && (
                  <ul className={styles.sources}>
                    {message.sources.map((source) => (
                      <li key={source.id} title={source.excerpt}>
                        <FileText size={12} aria-hidden />
                        {source.label} · {source.title}
                        {source.page ? t("messages.sourcePage", { page: source.page }) : ""}
                      </li>
                    ))}
                  </ul>
                )}

                {!streaming && (
                  <div className={cx(styles.assistantMeta, styles.metaBar)}>
                    {used.length > 0 && (
                      <button className={cx(styles.note, styles.memoryNote)} onClick={() => onOpenMemories(used)}>
                        <Brain size={12} aria-hidden />
                        {t("messages.memoryUsed", { count: used.length })}
                        {outside.length > 0 &&
                          t("messages.memoryOutside", {
                            count: outsideCount,
                            name: subjectNames[outside[0]] ?? t("memory.general"),
                            more: outside.length > 1 ? t("messages.memoryOutsideMore") : "",
                          })}
                      </button>
                    )}
                    {suggested && (
                      <button
                        className={cx(styles.note, styles.exerciseNote)}
                        onClick={() => onStartExercise(suggested.id)}
                        disabled={phase !== null && phase !== "analyzing"}
                      >
                        <Dumbbell size={12} aria-hidden />
                        {t("messages.exerciseSuggest", { title: suggested.title })}
                      </button>
                    )}
                    {message.content && message.status !== "failed" && (
                      <div className={styles.actionGroup} role="group" aria-label={t("messages.messageActions")}>
                        <CopyButton text={message.content} className={styles.action} />
                        <button
                          className={cx(styles.action, pinned && styles.actionOn)}
                          onClick={() => togglePin(message.id)}
                          aria-pressed={pinned}
                          title={pinned ? t("messages.unpinTitle") : t("messages.pinTitle")}
                        >
                          {pinned ? <PinOff size={13} aria-hidden /> : <Pin size={13} aria-hidden />}
                          <span>{pinned ? t("messages.unpin") : t("messages.pin")}</span>
                        </button>
                        {finished && (
                          <button
                            className={cx(styles.action, savedId === message.id && styles.actionOn)}
                            onClick={() => saveToPage(message)}
                            title={t("messages.saveToNotesTitle")}
                          >
                            <FileDown size={13} aria-hidden />
                            <span>{savedId === message.id ? t("messages.savedToNotes") : t("messages.saveToNotes")}</span>
                          </button>
                        )}
                      </div>
                    )}
                    {isLast && message.status !== "failed" && (
                      <button className={styles.action} onClick={onRegenerate} disabled={phase !== null && phase !== "analyzing"}>
                        <RotateCcw size={13} aria-hidden />
                        <span>{t("messages.regenerate")}</span>
                      </button>
                    )}
                    {finished && (
                      <span className={styles.tokenNote} title={t("messages.tokenNote")}>
                        <Zap size={11} aria-hidden />
                        ~{estimateTokens(message.content)} tokens
                        {message.toolCalls.length > 0 && t("messages.toolCountSuffix", { count: message.toolCalls.length })}
                      </span>
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
                  <p className={styles.failureTitle}>{t("messages.noReplyTitle")}</p>
                  <p>{t("messages.noReplyBody")}</p>
                </div>
                <button className={styles.inlineButton} onClick={onRegenerate}>
                  <RotateCcw size={13} aria-hidden />
                  {t("messages.generateReply")}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
      <SelectionToolbar
        scopeRef={scrollRef}
        conversationId={conversationId}
        canSaveToPage={Boolean(conversationSubjectId)}
        canSend={phase === null || phase === "analyzing"}
      />
      {showJump && (
        <button className={styles.jump} onClick={() => { following.current = true; setShowJump(false); toBottom(); }}>
          <ArrowDown size={14} aria-hidden />
          {t("messages.backToBottom")}
        </button>
      )}
    </div>
  );
}

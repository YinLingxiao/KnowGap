"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Brain, CheckCircle2, ChevronDown, ChevronRight, FileText, Folder, GraduationCap, History, ListTodo,
  Maximize2, MessagesSquare, Mic, Minimize2, MoreHorizontal,
  PanelLeftOpen, Plus, RotateCcw, Settings, SlidersHorizontal, Trash2, Upload, X,
} from "lucide-react";
import { WIDGET_ASK_EVENT } from "./LearningWidget";
import type { ChatController } from "@/hooks/useChat";
import { createMaterialClient } from "@/lib/api/material-client";
import { toApiError } from "@/lib/api/errors";
import { chatApi } from "@/lib/chat/api";
import { levelLabel, plainText } from "@/lib/chat/space";
import type { ConversationSummary, LearnerMemory, Subject, SpaceUsage, TokenUsage } from "@/lib/chat/types";
import { API_BASE_URL } from "@/lib/config";
import { cx } from "@/lib/cx";
import type { CourseMaterial, Problem } from "@/lib/types";
import { Button } from "../ui/Button";
import { Composer } from "./Composer";
import { MemoryItem } from "./MemoryDrawer";
import { MessageList } from "./MessageList";
import { UsageStats } from "./UsageStats";
import styles from "./SubjectPage.module.css";

type Panel =
  | { mode: "list" }
  | { mode: "thread"; id: string }
  | { mode: "info"; section: "about" | "files" | "memory" };

function readPanel(subjectId: string): Panel {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(`knowgap.space.panel.v1:${API_BASE_URL}:${subjectId}`) ?? "null");
    if (!parsed || typeof parsed !== "object" || !("mode" in parsed)) return { mode: "list" };
    if (parsed.mode === "thread" && "id" in parsed && typeof parsed.id === "string") return { mode: "thread", id: parsed.id };
    if (parsed.mode === "info" && "section" in parsed && (parsed.section === "about" || parsed.section === "files" || parsed.section === "memory")) {
      return { mode: "info", section: parsed.section };
    }
  } catch { /* fall back to the thread list */ }
  return { mode: "list" };
}

export function SubjectPage({
  subject, chat, narrow, sidebarOpen, memoriesById, problemsById, subjectNames, onOpenSidebar, onEdit, onDelete,
}: {
  subject: Subject;
  chat: ChatController;
  narrow: boolean;
  sidebarOpen: boolean;
  memoriesById: Record<string, LearnerMemory>;
  problemsById: Record<string, Problem>;
  subjectNames: Record<string, string>;
  onOpenSidebar: () => void;
  onEdit: () => void;
  onDelete: () => Promise<boolean>;
}) {
  const mainId = subject.mainConversationId;
  const { loadConversation, loadSubjects, loadMemories, threadDispatch } = chat;
  const [panel, setPanel] = useState<Panel>({ mode: "list" });
  const [panelReady, setPanelReady] = useState(false);
  const [overlay, setOverlay] = useState(false);
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const [panelExpanded, setPanelExpanded] = useState(false);
  const [threads, setThreads] = useState<ConversationSummary[]>([]);
  const [usage, setUsage] = useState<SpaceUsage | null>(null);
  const [menu, setMenu] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [instructions, setInstructions] = useState(subject.instructions);
  const [instructionsSaved, setInstructionsSaved] = useState(false);
  const [resolveFor, setResolveFor] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ title: string; summary: string; takeaways: string } | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const showPanel = (next: Panel) => {
    setPanel(next);
    setPanelCollapsed(false);
    setOverlay(true);
  };

  useEffect(() => {
    const saved = readPanel(subject.id);
    setPanel(saved);
    setOverlay(saved.mode !== "list");
    setPanelCollapsed(false);
    setPanelReady(true);
    setMenu(false);
    setConfirmDelete(false);
  }, [subject.id]);

  useEffect(() => {
    setInstructions(subject.instructions);
  }, [subject.instructions]);

  useEffect(() => {
    if (!panelReady) return;
    try {
      localStorage.setItem(`knowgap.space.panel.v1:${API_BASE_URL}:${subject.id}`, JSON.stringify(panel));
    } catch { /* convenience only */ }
  }, [panel, panelReady, subject.id]);

  const refreshThreads = useCallback(async () => {
    try {
      const [items, stats] = await Promise.all([
        chatApi.listThreads(subject.id), chatApi.spaceUsage(subject.id).catch(() => null),
      ]);
      setThreads(items);
      setUsage(stats);
    } catch { /* keep the last list */ }
  }, [subject.id]);

  useEffect(() => {
    if (mainId) void loadConversation(mainId);
    void refreshThreads();
  }, [loadConversation, mainId, refreshThreads]);

  const main = mainId ? chat.messagesFor(mainId) : null;
  const threadId = panel.mode === "thread" ? panel.id : null;
  useEffect(() => {
    if (threadId) void loadConversation(threadId);
  }, [loadConversation, threadId]);
  const thread = threadId ? chat.messagesFor(threadId) : null;
  const threadSummary = threads.find((item) => item.id === threadId) ?? null;
  const mainPhase = mainId ? chat.streamFor(mainId)?.phase ?? null : null;
  const localThreadPhase = threadId ? chat.streamFor(threadId)?.phase ?? null : null;
  const threadPhase = localThreadPhase ?? (
    threadSummary?.executionStatus === "working" || threadSummary?.executionStatus === "queued" ||
    thread?.messages.some((message) => message.status === "streaming") ? "streaming" : null
  );
  const threadStateKey = threads.map((item) => `${item.id}:${item.executionStatus}:${item.threadStatus}`).join("|");

  useEffect(() => {
    if (!threadDispatch || threadDispatch.mainId !== mainId) return;
    setPanel({ mode: "thread", id: threadDispatch.threadId });
    setPanelCollapsed(false);
    setOverlay(true);
    void refreshThreads();
  }, [mainId, refreshThreads, threadDispatch]);

  useEffect(() => {
    void loadSubjects();
    void loadMemories();
  }, [threadStateKey, loadSubjects, loadMemories]);

  useEffect(() => {
    if (!mainId) return;
    let fetching = false;
    const timer = window.setInterval(async () => {
      if (fetching || document.hidden) return;
      fetching = true;
      try {
        await Promise.all([
          refreshThreads(),
          ...(!mainPhase ? [loadConversation(mainId)] : []),
          ...(threadId && !localThreadPhase ? [loadConversation(threadId)] : []),
        ]);
      } finally { fetching = false; }
    }, 1500);
    return () => window.clearInterval(timer);
  }, [mainId, mainPhase, threadId, localThreadPhase, loadConversation, refreshThreads]);

  useEffect(() => {
    if (!mainId || mainPhase) return;
    if (!main?.messages.some((message) => message.status === "streaming")) return;
    const timer = window.setTimeout(() => void loadConversation(mainId), 1500);
    return () => window.clearTimeout(timer);
  }, [loadConversation, main, mainId, mainPhase]);

  const openThread = (id: string) => {
    showPanel({ mode: "thread", id });
    void chat.loadConversation(id);
  };

  const beginResolve = async (id: string) => {
    setResolveFor(id);
    setDraft(null);
    setDraftError(null);
    setDrafting(true);
    try {
      const result = await chatApi.draftResolution(id);
      setDraft({ title: result.title, summary: result.summary, takeaways: result.takeaways.join("\n") });
    } catch (error) {
      setDraftError(toApiError(error).message);
    } finally {
      setDrafting(false);
    }
  };

  const confirmResolve = async () => {
    if (!resolveFor || !draft || saving) return;
    setSaving(true);
    try {
      await chatApi.resolveThread(resolveFor, {
        title: draft.title.trim(),
        summary: draft.summary.trim(),
        takeaways: draft.takeaways.split("\n").map((item) => item.trim()).filter(Boolean).slice(0, 4),
      });
      setResolveFor(null);
      if (mainId) void chat.loadConversation(mainId);
      void chat.loadConversation(resolveFor);
      void refreshThreads();
      void chat.loadSubjects();
      void chat.loadMemories();
    } catch (error) {
      setDraftError(toApiError(error).message);
    } finally {
      setSaving(false);
    }
  };

  const reopen = async (id: string) => {
    await chatApi.reopenThread(id);
    void chat.loadConversation(id);
    void refreshThreads();
    void chat.loadSubjects();
  };

  const saveInstructions = async () => {
    if (instructions.trim() === subject.instructions) return;
    const ok = await chat.updateSubject(subject.id, { instructions });
    if (ok) {
      setInstructionsSaved(true);
      window.setTimeout(() => setInstructionsSaved(false), 1600);
    }
  };

  const openThreads = threads.filter((item) => item.threadStatus !== "resolved");
  const doneThreads = threads.filter((item) => item.threadStatus === "resolved");
  const spaceMemories = useMemo(
    () => chat.memories.filter((memory) => memory.subjectId === subject.id),
    [chat.memories, subject.id],
  );
  const conversationTitles = useMemo(
    () => Object.fromEntries(chat.conversations.map((item) => [item.id, item.title])),
    [chat.conversations],
  );
  const failureFor = (id: string | null) => chat.sendFailure?.conversationId === id ? chat.sendFailure : null;
  const panelVisible = (!narrow && !panelCollapsed) || overlay;
  const isOverviewOn = panelVisible && panel.mode === "info" && panel.section === "about";

  return (
    <div className={cx(styles.page, !panelVisible && styles.pageSingle, panelVisible && panelExpanded && styles.pageExpanded)}>
      <section className={styles.main}>
        <header className={styles.header}>
          {!sidebarOpen && (
            <button className={styles.icon} onClick={onOpenSidebar} aria-label="展开侧栏" title="展开侧栏">
              <PanelLeftOpen size={16} />
            </button>
          )}
          <span className={styles.spaceIcon} style={{ color: subject.color }} aria-hidden>
            <GraduationCap size={16} />
          </span>
          <div className={styles.heading}>
            <h1>{subject.name}</h1>
            {levelLabel(subject.level) && <span className={styles.tag}>{levelLabel(subject.level)}</span>}
          </div>

          <div className={styles.tools} role="group" aria-label="空间操作">
            <button
              type="button"
              className={cx(styles.overviewBtn, isOverviewOn && styles.overviewBtnOn)}
              onClick={() => {
                if (isOverviewOn) {
                  showPanel({ mode: "list" });
                } else {
                  showPanel({ mode: "info", section: "about" });
                }
              }}
            >
              <SlidersHorizontal size={13} aria-hidden />
              <span>概览</span>
            </button>
            {!panelVisible && (
              <button
                type="button"
                className={styles.overviewBtn}
                onClick={() => showPanel({ mode: "list" })}
              >
                <MessagesSquare size={13} aria-hidden />
                <span>Threads</span>
                {openThreads.length > 0 && <span className={styles.tabCount}>{openThreads.length}</span>}
              </button>
            )}
            <button className={styles.icon} aria-label="空间设置" title="编辑学习空间" onClick={onEdit}>
              <Settings size={15} />
            </button>
            <button className={styles.icon} aria-label="更多" title="更多操作" onClick={() => setMenu((open) => !open)}>
              <MoreHorizontal size={16} />
            </button>
          </div>
          {menu && (
            <div className={styles.menu}>
              <button onClick={() => { setMenu(false); onEdit(); }}>编辑空间</button>
              <button className={styles.danger} onClick={() => { setMenu(false); setConfirmDelete(true); }}>删除空间</button>
            </div>
          )}
        </header>

        {confirmDelete && (
          <div className={styles.confirm} role="group">
            <span>删除后，主对话和 Thread 会变成普通对话，记忆改为通用。</span>
            <button onClick={() => setConfirmDelete(false)}>取消</button>
            <button className={styles.danger} onClick={() => void onDelete()}>删除</button>
          </div>
        )}

        {mainId && main ? (
          <MessageList
            conversationId={mainId}
            messages={main.messages}
            problems={problemsById}
            memoriesById={memoriesById}
            conversationSubjectId={subject.id}
            subjectNames={subjectNames}
            phase={chat.streamFor(mainId)?.phase ?? null}
            followNonce={chat.followNonceFor(mainId)}
            topSlot={(
              <div className={styles.streamIntro}>
                <div className={styles.todayLine} aria-hidden>
                  <span>今天</span>
                </div>
                <div className={styles.welcomeBlock}>
                  <p className={styles.welcomeGreeting}>准备好开始学习「{subject.name}」了。</p>
                  <p className={styles.welcomeSub}>
                    {subject.goal
                      ? `当前目标：${subject.goal}。你可以直接提问，或从以下方式开始：`
                      : "主对话负责规划整体路线，具体卡点与练习会在右侧开启并行 Thread。你可以从以下方式开始："}
                  </p>
                  <div className={styles.starterPills}>
                    <button
                      type="button"
                      className={styles.starterPill}
                      onClick={() => void chat.sendTo(mainId, `请先用直观的例子帮我梳理「${subject.name}」最核心的知识点，并出 1 道诊断小题检验我的理解。`)}
                    >
                      <History size={13} aria-hidden />
                      <span>梳理核心概念</span>
                    </button>
                    <button
                      type="button"
                      className={styles.starterPill}
                      onClick={() => void chat.sendTo(mainId, `请结合我的学习目标，帮我制定「${subject.name}」的分阶段学习计划。`)}
                    >
                      <ListTodo size={13} aria-hidden />
                      <span>制定学习计划</span>
                    </button>
                    <button
                      type="button"
                      className={styles.starterPill}
                      onClick={() =>
                        void chat.sendTo(
                          mainId,
                          `我想用费曼学习法自测「${subject.name}」的核心概念：请开启一个 Thread，由我讲给你听，你来挑刺追问我。`,
                        )
                      }
                    >
                      <Mic size={13} aria-hidden />
                      <span>费曼反转自测</span>
                    </button>
                    <button
                      type="button"
                      className={styles.starterPill}
                      onClick={() => showPanel({ mode: "info", section: "files" })}
                    >
                      <Plus size={13} aria-hidden />
                      <span>添加课程资料</span>
                    </button>
                  </div>
                </div>
              </div>
            )}
            onRegenerate={() => void chat.regenerate(mainId)}
            onStartExercise={(problemId) => void chat.sendTo(mainId, `请安排练习「${problemsById[problemId]?.title ?? problemId}」，在 Thread 中带我完成。`)}
            onOpenMemories={() => showPanel({ mode: "info", section: "memory" })}
            onOpenSummary={openThread}
            onConfirmProposal={async (messageId, proposalId) => {
              const id = await chatApi.confirmProposal(mainId, messageId, proposalId);
              void loadConversation(mainId);
              void refreshThreads();
              void loadSubjects();
              return id;
            }}
            onDecideTool={(approvalId, allow) => void chat.decideTool(approvalId, allow)}
          />
        ) : (
          <div className={styles.center}><p>正在读取主对话…</p></div>
        )}
        {mainId && (
          <div className={styles.dock}>
            {failureFor(mainId) && <p className={styles.error}>{failureFor(mainId)?.error.message}</p>}
            <Composer
              value={chat.draftFor(mainId)}
              onChange={(value) => chat.setDraftFor(mainId, value)}
              onSend={() => void chat.sendTo(mainId, chat.draftFor(mainId))}
              onStop={() => void chat.stop(mainId)}
              phase={chat.streamFor(mainId)?.phase ?? null}
              busy={false}
              problems={[]}
              onStartExercise={(problemId) => void chat.sendTo(mainId, `请安排练习「${problemsById[problemId]?.title ?? problemId}」，在 Thread 中带我完成。`)}
              autoFocusKey={mainId}
              placeholder="描述学习需求、补充条件，或直接提问…"
            />
          </div>
        )}
      </section>

      {panelVisible && (
        <aside className={cx(styles.panel, narrow && styles.overlay)}>
          {/* 右侧面板顶栏：列表态为 Tab 栏，进入具体 Thread 时切换为面包屑顶栏（Threads › 标题） */}
          <header className={styles.panelBar}>
            {panel.mode === "thread" && threadId ? (
              <div className={styles.breadcrumbBar}>
                <button
                  type="button"
                  className={styles.crumbRoot}
                  onClick={() => setPanel({ mode: "list" })}
                >
                  Threads
                </button>
                <ChevronRight size={13} className={styles.crumbSep} aria-hidden />
                <strong className={styles.crumbCurrent} title={threadSummary?.title ?? "Thread"}>
                  {threadSummary?.title ?? "Thread"}
                </strong>
                {threadSummary?.executionStatus && (
                  <span className={styles.crumbStatus} role="status">
                    {executionLabel[threadSummary.executionStatus]}
                  </span>
                )}
              </div>
            ) : (
              <div className={styles.panelTabs} role="tablist" aria-label="右侧面板视图">
                <button
                  type="button"
                  role="tab"
                  aria-selected={panel.mode === "list"}
                  className={cx(styles.panelTabPill, panel.mode === "list" && styles.panelTabActive)}
                  onClick={() => setPanel({ mode: "list" })}
                >
                  <MessagesSquare size={13} aria-hidden />
                  <span>Threads</span>
                  {openThreads.length > 0 && <span className={styles.tabCount}>{openThreads.length}</span>}
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={panel.mode === "info" && panel.section === "files"}
                  className={cx(styles.panelIconTab, panel.mode === "info" && panel.section === "files" && styles.panelTabActive)}
                  onClick={() => setPanel({ mode: "info", section: "files" })}
                  aria-label="课程资料"
                  title="课程资料"
                >
                  <FileText size={14} />
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={panel.mode === "info" && panel.section === "memory"}
                  className={cx(styles.panelIconTab, panel.mode === "info" && panel.section === "memory" && styles.panelTabActive)}
                  onClick={() => setPanel({ mode: "info", section: "memory" })}
                  aria-label="空间学习记忆"
                  title={`空间学习记忆 (${spaceMemories.length})`}
                >
                  <Brain size={14} />
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={panel.mode === "info" && panel.section === "about"}
                  className={cx(styles.panelIconTab, panel.mode === "info" && panel.section === "about" && styles.panelTabActive)}
                  onClick={() => setPanel({ mode: "info", section: "about" })}
                  aria-label="空间概览与教学说明"
                  title="空间概览与教学说明"
                >
                  <SlidersHorizontal size={14} />
                </button>
              </div>
            )}

            <div className={styles.panelActions}>
              {panel.mode === "thread" && threadId ? (
                <>
                  {threadSummary?.threadStatus === "resolved" ? (
                    <button
                      type="button"
                      className={styles.panelActionBtn}
                      onClick={() => void reopen(threadId)}
                      aria-label="重新打开 Thread"
                      title="重新打开 Thread"
                    >
                      <RotateCcw size={14} />
                    </button>
                  ) : (
                    <button
                      type="button"
                      className={styles.panelActionBtn}
                      disabled={Boolean(threadPhase)}
                      onClick={() => void beginResolve(threadId)}
                      aria-label="标记为已解决并合并回主对话"
                      title="已解决（合并小结回主对话）"
                    >
                      <CheckCircle2 size={15} />
                    </button>
                  )}
                  <UsageStats usage={usage?.conversations[threadId]} label="用量" align="right" />
                </>
              ) : (
                <UsageStats usage={usage?.total} label="用量" align="right" />
              )}
              {!narrow && (
                <button
                  type="button"
                  className={styles.panelActionBtn}
                  onClick={() => setPanelExpanded((v) => !v)}
                  aria-label={panelExpanded ? "恢复默认宽度" : "加宽面板"}
                  title={panelExpanded ? "恢复默认宽度" : "加宽面板"}
                >
                  {panelExpanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
                </button>
              )}
              <button
                type="button"
                className={styles.panelActionBtn}
                onClick={() => {
                  if (narrow) setOverlay(false);
                  else setPanelCollapsed(true);
                }}
                aria-label="关闭右侧面板"
                title="关闭面板"
              >
                <X size={15} />
              </button>
            </div>
          </header>

          {panel.mode === "list" && (
            <ThreadList
              subjectName={subject.name}
              openThreads={openThreads}
              doneThreads={doneThreads}
              usage={usage?.conversations ?? {}}
              onOpen={openThread}
            />
          )}
          {panel.mode === "thread" && threadId && (
            <div className={styles.thread}>
              {thread && (
                <MessageList
                  conversationId={threadId}
                  messages={thread.messages}
                  problems={problemsById}
                  memoriesById={memoriesById}
                  conversationSubjectId={subject.id}
                  subjectNames={subjectNames}
                  phase={threadPhase}
                  followNonce={chat.followNonceFor(threadId)}
                  topSlot={(
                    <div className={styles.todayLine} aria-hidden>
                      <span>今天</span>
                    </div>
                  )}
                  onRegenerate={() => void chat.regenerate(threadId)}
                  onResumeCheckpoint={async (messageId) => {
                    await chatApi.resumeThread(threadId, messageId);
                    void loadConversation(threadId);
                    void refreshThreads();
                  }}
                  onStartExercise={(problemId) => void chat.startExerciseOn(threadId, problemId)}
                  onOpenMemories={() => showPanel({ mode: "info", section: "memory" })}
                  onDecideTool={(approvalId, allow) => void chat.decideTool(approvalId, allow)}
                />
              )}
              <div className={styles.dock}>
                {failureFor(threadId) && <p className={styles.error}>{failureFor(threadId)?.error.message}</p>}
                <Composer
                  inputId="thread-composer"
                  value={chat.draftFor(threadId)}
                  onChange={(value) => chat.setDraftFor(threadId, value)}
                  onSend={() => void chat.sendTo(threadId, chat.draftFor(threadId))}
                  onStop={() => void chat.stop(threadId)}
                  phase={threadPhase}
                  busy={false}
                  problems={chat.problems}
                  onStartExercise={(problemId) => void chat.startExerciseOn(threadId, problemId)}
                  autoFocusKey={threadId}
                  placeholder="引导或追问这个 Thread…"
                />
              </div>
            </div>
          )}
          {panel.mode === "info" && (
            <div className={styles.info}>
              <header className={styles.threadSubHead}>
                <strong>{panel.section === "about" ? "空间概览与教学说明" : panel.section === "files" ? "课程资料" : "空间学习记忆"}</strong>
              </header>
              {panel.section === "about" && (
                <div className={styles.about}>
                  <div className={styles.aboutMeta}>
                    <div><span>目标</span><p>{subject.goal || "未填写"}</p></div>
                    {levelLabel(subject.level) && <div><span>基础</span><p>{levelLabel(subject.level)}</p></div>}
                    {subject.deadline && <div><span>截止</span><p>{subject.deadline}</p></div>}
                  </div>
                  <label className={styles.aboutField}>
                    <div className={styles.aboutLabel}>
                      <span>教学说明（失焦自动保存）</span>
                      {instructionsSaved && <em className={styles.saved}>已保存</em>}
                    </div>
                    <textarea
                      value={instructions}
                      maxLength={4000}
                      placeholder="告诉模型在这个空间里怎么教你…"
                      onChange={(event) => setInstructions(event.target.value)}
                      onBlur={() => void saveInstructions()}
                    />
                  </label>

                  {/* 零成本足迹式知识看板（不耗额外 Token，自动聚合本空间卡点、已掌握与已解决 Thread） */}
                  <div className={styles.footprintSection}>
                    <span className={styles.footprintTitle}>空间知识足迹（自动聚合）</span>
                    <div className={styles.footprintStats}>
                      <div className={styles.footprintStat}>
                        <strong>{spaceMemories.filter((m) => m.kind === "misconception" && m.status !== "resolved").length}</strong>
                        <span>待巩固卡点</span>
                      </div>
                      <div className={styles.footprintStat}>
                        <strong>{openThreads.length}</strong>
                        <span>进行中 Thread</span>
                      </div>
                      <div className={styles.footprintStat}>
                        <strong>{spaceMemories.filter((m) => m.kind === "mastery" || m.status === "resolved").length + doneThreads.length}</strong>
                        <span>已攻克归档</span>
                      </div>
                    </div>

                    {spaceMemories.filter((m) => m.kind === "misconception" && m.status !== "resolved").length > 0 && (
                      <div className={styles.footprintGroup}>
                        <p className={styles.footprintGroupHead}>🔴 待攻克薄弱点</p>
                        {spaceMemories
                          .filter((m) => m.kind === "misconception" && m.status !== "resolved")
                          .map((m) => (
                            <div key={m.id} className={styles.footprintCard}>
                              <div className={styles.footprintCardBody}>
                                <strong>{m.topic}</strong>
                                <p>{m.summary}</p>
                              </div>
                              {mainId && (
                                <button
                                  type="button"
                                  className={styles.footprintActionBtn}
                                  onClick={() =>
                                    void chat.sendTo(
                                      mainId,
                                      `针对我之前在「${m.topic}」上的薄弱点（${m.summary}），请开启一个专项巩固 Thread 带我彻底搞懂并做一道题验证。`,
                                    )
                                  }
                                >
                                  专项攻克 →
                                </button>
                              )}
                            </div>
                          ))}
                      </div>
                    )}

                    {(doneThreads.length > 0 || spaceMemories.some((m) => m.kind === "mastery" || m.status === "resolved")) && (
                      <div className={styles.footprintGroup}>
                        <p className={styles.footprintGroupHead}>🟢 已掌握与已归档</p>
                        {doneThreads.map((t) => (
                          <button
                            key={t.id}
                            type="button"
                            className={styles.footprintDoneRow}
                            onClick={() => openThread(t.id)}
                          >
                            <CheckCircle2 size={13} className={styles.footprintDoneIcon} aria-hidden />
                            <span>Thread · {t.title}</span>
                          </button>
                        ))}
                        {spaceMemories
                          .filter((m) => m.kind === "mastery" || m.status === "resolved")
                          .map((m) => (
                            <div key={m.id} className={styles.footprintDoneRow}>
                              <CheckCircle2 size={13} className={styles.footprintDoneIcon} aria-hidden />
                              <span>{m.topic}：{m.summary}</span>
                            </div>
                          ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
              {panel.section === "files" && <Files subjectId={subject.id} onChange={() => void chat.loadSubjects()} />}
              {panel.section === "memory" && (
                <div className={styles.memoriesPane}>
                  {spaceMemories.length === 0 ? (
                    <p className={styles.muted}>还没有属于这里的记忆。</p>
                  ) : (
                    spaceMemories.map((memory) => (
                      <MemoryItem
                        key={memory.id}
                        memory={memory}
                        subjects={chat.subjects}
                        conversationTitles={conversationTitles}
                        onUpdate={chat.updateMemory}
                        onDelete={chat.deleteMemory}
                        onOpenConversation={(convId) => {
                          if (threads.some((t) => t.id === convId)) openThread(convId);
                        }}
                      />
                    ))
                  )}
                </div>
              )}
            </div>
          )}
        </aside>
      )}
      {resolveFor && (
        <div className={styles.backdrop} onMouseDown={() => setResolveFor(null)}>
          <div className={styles.resolve} role="dialog" aria-modal="true" aria-label="合并小结" onMouseDown={(event) => event.stopPropagation()}>
            <h2>合并回主对话</h2>
            {drafting && <p className={styles.muted}>正在起草小结…</p>}
            {draftError && <p className={styles.error}>{draftError}</p>}
            {draft && (
              <>
                <label className={styles.resolveField}>
                  <span>标题</span>
                  <input value={draft.title} maxLength={60} aria-label="小结标题" onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
                </label>
                <label className={styles.resolveField}>
                  <span>小结</span>
                  <textarea value={draft.summary} aria-label="小结" onChange={(event) => setDraft({ ...draft, summary: event.target.value })} />
                </label>
                <label className={styles.resolveField}>
                  <span>要点（每行一条）</span>
                  <textarea value={draft.takeaways} aria-label="要点，每行一条" placeholder="要点，每行一条" onChange={(event) => setDraft({ ...draft, takeaways: event.target.value })} />
                </label>
              </>
            )}
            <footer>
              <Button onClick={() => setResolveFor(null)}>取消</Button>
              <Button variant="primary" disabled={!draft?.title.trim() || !draft.summary.trim()} loading={saving} onClick={() => void confirmResolve()}>
                合并
              </Button>
            </footer>
          </div>
        </div>
      )}
    </div>
  );
}

const executionLabel = { queued: "已排队", working: "正在执行", waiting: "等待你", idle: "本轮完成", failed: "执行失败", cancelled: "已停止" };

function ThreadList({
  subjectName, openThreads, doneThreads, usage, onOpen,
}: {
  subjectName: string;
  openThreads: ConversationSummary[];
  doneThreads: ConversationSummary[];
  usage: Record<string, TokenUsage>;
  onOpen: (id: string) => void;
}) {
  const workingCount = openThreads.filter((item) => item.executionStatus === "working").length;
  const isEmpty = openThreads.length + doneThreads.length === 0;

  return (
    <div className={styles.listPane}>
      <div className={styles.panelWelcome}>
        <div className={styles.panelWelcomeTop}>
          <h2>欢迎进入「{subjectName}」</h2>
          {workingCount > 0 && <span className={styles.slotHint}>{Math.min(2, workingCount)}/2 执行中</span>}
        </div>
        <p>
          当主对话开始拆解问题时，KnowGap 会在这里追踪每个 Thread 的实时状态：哪些正在执行、哪些等待你回应、哪些已解决。
        </p>
      </div>

      {isEmpty ? (
        <div className={styles.emptyThreadsCenter}>
          <MessagesSquare size={22} strokeWidth={1.5} aria-hidden />
          <p>开始对话后，你的 Thread 会显示在这里。</p>
        </div>
      ) : (
        <>
          {[
            { label: "等待你", items: openThreads.filter((item) => item.executionStatus === "waiting" || item.executionStatus === "failed") },
            { label: "正在执行", items: openThreads.filter((item) => item.executionStatus === "working" || item.executionStatus === "queued") },
            { label: "空闲", items: openThreads.filter((item) => !item.executionStatus || item.executionStatus === "idle" || item.executionStatus === "cancelled") },
          ].filter((group) => group.items.length > 0).map((group) => (
            <section key={group.label}>
              <p className={styles.group}>{group.label} · {group.items.length}</p>
              <ul>{group.items.map((item) => (
                <li key={item.id}>
                  <button onClick={() => onOpen(item.id)}>
                    <span className={styles.threadTitle}>
                      <i className={cx(styles.state, styles[`state_${item.executionStatus ?? "idle"}`])} aria-hidden />
                      <span className={styles.threadTitleText}>{item.title}</span>
                    </span>
                    <small>{item.executionStatus ? executionLabel[item.executionStatus] : "空闲"}{item.preview ? ` · ${plainText(item.preview)}` : ""}</small>
                  </button>
                  {usage[item.id] && <div className={styles.threadUsage}><UsageStats usage={usage[item.id]} align="right" /></div>}
                </li>
              ))}</ul>
            </section>
          ))}
          {doneThreads.length > 0 && <p className={styles.group}>已解决 · {doneThreads.length}</p>}
          <ul className={styles.done}>
            {doneThreads.map((item) => (
              <li key={item.id}>
                <button onClick={() => onOpen(item.id)}>
                  <span className={styles.threadTitleText}>{item.title}</span>
                  {item.preview && <small>{plainText(item.preview)}</small>}
                </button>
                {usage[item.id] && <div className={styles.threadUsage}><UsageStats usage={usage[item.id]} align="right" /></div>}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function Files({ subjectId, onChange }: { subjectId: string; onChange: () => void }) {
  const client = useMemo(() => createMaterialClient(), []);
  const input = useRef<HTMLInputElement>(null);
  const [documents, setDocuments] = useState<CourseMaterial[]>([]);
  const [wsTree, setWsTree] = useState<{
    workspace: string;
    name: string;
    entries: Array<{ name: string; path: string; kind: "dir" | "file"; children?: Array<{ name: string; path: string; kind: "dir" | "file" }> }>;
  }>({ workspace: "", name: "", entries: [] });
  const [openDirs, setOpenDirs] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      setDocuments(await client.list({ subjectId }));
      setError(null);
    } catch (failure) {
      setError(toApiError(failure).message);
    }
  }, [client, subjectId]);
  const refreshWs = useCallback(async () => {
    try {
      setWsTree(await chatApi.workspaceTree());
    } catch { /* ignore */ }
  }, []);
  useEffect(() => {
    void refresh();
    void refreshWs();
    const onEnv = () => void refreshWs();
    window.addEventListener("knowgap:agent-env", onEnv);
    return () => window.removeEventListener("knowgap:agent-env", onEnv);
  }, [refresh, refreshWs]);
  const upload = async (file: File) => {
    try {
      await client.upload(file, subjectId);
      await refresh();
      onChange();
    } catch (failure) {
      setError(toApiError(failure).message);
    }
  };
  const remove = async (id: string) => {
    await client.remove(id);
    await refresh();
    onChange();
  };
  return (
    <div className={styles.files}>
      <div className={styles.filesBlock}>
        <div className={styles.filesBlockHead}>
          <span className={styles.filesBlockTitle}>空间上传讲义 ({documents.length})</span>
          <button className={styles.uploadBtn} onClick={() => input.current?.click()}>
            <Upload size={12} aria-hidden />上传资料
          </button>
        </div>
        <input ref={input} hidden type="file" accept=".pdf,.txt,.md" onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file); }} />
        {error && <p className={styles.error}>{error}</p>}
        <ul>
          {documents.map((document) => (
            <li key={document.id}>
              <FileText size={13} aria-hidden />
              <span>{document.title}</span>
              <button aria-label={`删除 ${document.title}`} onClick={() => void remove(document.id)}><Trash2 size={12} /></button>
            </li>
          ))}
          {documents.length === 0 && <li className={styles.muted}>还没有上传空间专属讲义。</li>}
        </ul>
      </div>

      {/* 参照 LobeHub 图 1 右栏：本地工作区文件夹目录树 */}
      <div className={styles.filesBlock}>
        <div className={styles.filesBlockHead}>
          <span className={styles.filesBlockTitle}>
            本地工作区文件树 {wsTree.name ? `(${wsTree.name})` : ""}
          </span>
        </div>
        {!wsTree.workspace ? (
          <p className={styles.muted}>尚未绑定本地工作区目录。可在输入框左下方点击「未选择工作区」绑定本地文件夹。</p>
        ) : wsTree.entries.length === 0 ? (
          <p className={styles.muted}>该工作区文件夹为空。</p>
        ) : (
          <ul className={styles.wsTreeList}>
            {wsTree.entries.map((entry) => (
              <li key={entry.path} className={styles.wsTreeItem}>
                {entry.kind === "dir" ? (
                  <>
                    <button
                      type="button"
                      className={styles.wsTreeRow}
                      onClick={() => setOpenDirs((old) => ({ ...old, [entry.path]: !old[entry.path] }))}
                    >
                      {openDirs[entry.path] ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
                      <Folder size={13} className={styles.wsFolderIcon} aria-hidden />
                      <span>{entry.name}</span>
                    </button>
                    {openDirs[entry.path] && entry.children && entry.children.length > 0 && (
                      <ul className={styles.wsSubList}>
                        {entry.children.map((sub) => (
                          <li key={sub.path}>
                            <button
                              type="button"
                              className={styles.wsTreeRow}
                              onClick={() => {
                                if (sub.kind === "file") {
                                  window.dispatchEvent(
                                    new CustomEvent<string>(WIDGET_ASK_EVENT, {
                                      detail: `请读取工作区文件「${sub.path}」并帮我分析其中的核心内容：`,
                                    }),
                                  );
                                }
                              }}
                            >
                              {sub.kind === "dir" ? (
                                <Folder size={12} className={styles.wsFolderIcon} aria-hidden />
                              ) : (
                                <FileText size={12} aria-hidden />
                              )}
                              <span>{sub.name}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                ) : (
                  <button
                    type="button"
                    className={styles.wsTreeRow}
                    onClick={() =>
                      window.dispatchEvent(
                        new CustomEvent<string>(WIDGET_ASK_EVENT, {
                          detail: `请读取工作区文件「${entry.path}」并帮我分析其中的核心内容：`,
                        }),
                      )
                    }
                    title="点击将此文件带入输入框"
                  >
                    <FileText size={13} aria-hidden />
                    <span>{entry.name}</span>
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

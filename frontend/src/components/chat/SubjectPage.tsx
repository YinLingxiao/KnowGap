"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Brain, CalendarDays, CheckCircle2, ChevronLeft, ChevronRight, Download, GraduationCap, History, Library as LibraryIcon, Link2, ListTodo,
  LoaderCircle, Maximize2, MessagesSquare, Mic, Minimize2, MoreHorizontal,
  PanelLeftOpen, Plus, RotateCcw, Settings, SlidersHorizontal, Target, Waypoints, X, Zap,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ChatController } from "@/hooks/useChat";
import { useI18n } from "@/components/LanguageProvider";
import { useSlidingThumb } from "@/hooks/useSlidingThumb";
import { toApiError } from "@/lib/api/errors";
import { chatApi } from "@/lib/chat/api";
import { levelLabel, plainText } from "@/lib/chat/space";
import type { ConversationSummary, LearnerMemory, Subject, SpaceUsage, TokenUsage } from "@/lib/chat/types";
import { API_BASE_URL } from "@/lib/config";
import { SPACE_PAGES_EVENT, spacePagesKey } from "@/lib/spacePages";
import { cx } from "@/lib/cx";
import type { Problem } from "@/lib/types";
import { Button } from "../ui/Button";
import { CHEATSHEET_OPENED_EVENT, GUIDES_RESET_EVENT, OPEN_SPACE_PANEL_EVENT, coachSeenKey } from "../onboarding/coach";
import { CheatSheet } from "./CheatSheet";
import { ConceptGraph, type AttackTarget } from "./ConceptGraph";
import { SpaceTasks } from "../agenda/SpaceTasks";
import { Composer } from "./Composer";
import { Markdown } from "./Markdown";
import { MemoryItem } from "./MemoryDrawer";
import { Library } from "./Library";
import { MessageList } from "./MessageList";
import { UsageStats } from "./UsageStats";
import styles from "./SubjectPage.module.css";

type Panel =
  | { mode: "list" }
  | { mode: "pages" }
  | { mode: "graph" }
  | { mode: "tasks" }
  | { mode: "thread"; id: string }
  | { mode: "info"; section: "about" | "files" | "memory" };

const SAVE_TO_PAGE_EVENT = "knowgap:save-to-page";
const PRIOR_PREFIX = "先验技能：";
const LAYER_PREFIX_RE = /^\[(Identity|Preference|Context|Activity|Experience)\]\s*/i;

const TRANSFER_ANCHORS: Array<{ label: string; skills: string[]; text: string }> = [
  { label: "会 C/C++", skills: ["C / C++"], text: "C/C++" },
  { label: "会 Python", skills: ["Python"], text: "Python" },
  { label: "会 Java/JS", skills: ["Java / JS"], text: "Java/JS" },
  { label: "学过微积分/线代", skills: ["高等数学", "线性代数"], text: "微积分/线代" },
  { label: "学过电路/大物", skills: ["电路原理", "大学物理"], text: "电路/大物" },
];

function readPages(subjectId: string) {
  try {
    return localStorage.getItem(spacePagesKey(subjectId)) ?? "";
  } catch {
    return "";
  }
}

/** 把先验技能合并进 USER 的「先验技能：」条目（与设置 → 记忆中的锚点栏同一条目）。 */
async function syncPriorSkills(skills: string[]) {
  const notes = await chatApi.agentNotes();
  const entries = notes.user.split(/\s*§\s*/).map((item) => item.trim()).filter(Boolean);
  const strip = (entry: string) => entry.replace(LAYER_PREFIX_RE, "");
  const existing = entries.find((entry) => strip(entry).startsWith(PRIOR_PREFIX));
  const current = existing
    ? strip(existing).slice(PRIOR_PREFIX.length).split(/[、，,;；]+/).map((item) => item.trim()).filter(Boolean)
    : [];
  const merged = [...current, ...skills.filter((skill) => !current.includes(skill))];
  const kept = entries.filter((entry) => !strip(entry).startsWith(PRIOR_PREFIX));
  await chatApi.saveAgentNote("user", [...kept, `${PRIOR_PREFIX}${merged.join("、")}`].join("\n§\n"));
}

function readPanel(subjectId: string): Panel {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(`knowgap.space.panel.v1:${API_BASE_URL}:${subjectId}`) ?? "null");
    if (!parsed || typeof parsed !== "object" || !("mode" in parsed)) return { mode: "list" };
    if (parsed.mode === "pages") return { mode: "pages" };
    if (parsed.mode === "graph") return { mode: "graph" };
    if (parsed.mode === "tasks") return { mode: "tasks" };
    if (parsed.mode === "thread" && "id" in parsed && typeof parsed.id === "string") return { mode: "thread", id: parsed.id };
    if (parsed.mode === "info" && "section" in parsed && (parsed.section === "about" || parsed.section === "files" || parsed.section === "memory")) {
      return { mode: "info", section: parsed.section };
    }
  } catch { /* fall back to the thread list */ }
  return { mode: "list" };
}

export function SubjectPage({
  subject, chat, narrow, sidebarOpen, memoriesById, problemsById, subjectNames, userId, onOpenSidebar, onEdit, onDelete,
}: {
  subject: Subject;
  chat: ChatController;
  narrow: boolean;
  sidebarOpen: boolean;
  memoriesById: Record<string, LearnerMemory>;
  problemsById: Record<string, Problem>;
  subjectNames: Record<string, string>;
  userId: string;
  onOpenSidebar: () => void;
  onEdit: () => void;
  onDelete: () => Promise<boolean>;
}) {
  const { lang } = useI18n();
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
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [mergeNotice, setMergeNotice] = useState<{ threadId: string; messageId: string | null } | null>(null);
  const [scrollTarget, setScrollTarget] = useState<{ messageId: string | null; threadId: string; nonce: number } | null>(null);
  const [pages, setPages] = useState<{ id: string; text: string }>({ id: "", text: "" });
  const [pagesView, setPagesView] = useState<"edit" | "split" | "preview">("split");
  const [pagesNotice, setPagesNotice] = useState<string | null>(null);
  const [customAnchor, setCustomAnchor] = useState("");
  const [cheatSheetOpen, setCheatSheetOpen] = useState(false);
  const [fogReady, setFogReady] = useState(false);

  const showPanel = (next: Panel) => {
    setPanel(next);
    setPanelCollapsed(false);
    setOverlay(true);
  };

  useEffect(() => {
    const sync = () => setFogReady(localStorage.getItem(coachSeenKey(userId, "sheet")) === "1");
    sync();
    window.addEventListener(GUIDES_RESET_EVENT, sync);
    return () => window.removeEventListener(GUIDES_RESET_EVENT, sync);
  }, [subject.id, userId]);

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
    const onPanel = (event: Event) => {
      const detail = (event as CustomEvent<{ mode?: string; subjectId?: string }>).detail;
      if (detail?.subjectId && detail.subjectId !== subject.id) return;
      if (detail?.mode === "graph") showPanel({ mode: "graph" });
      if (detail?.mode === "cheatsheet") {
        setCheatSheetOpen(true);
        window.dispatchEvent(new Event(CHEATSHEET_OPENED_EVENT));
      }
    };
    window.addEventListener(OPEN_SPACE_PANEL_EVENT, onPanel);
    return () => window.removeEventListener(OPEN_SPACE_PANEL_EVENT, onPanel);
  }, [subject.id]);

  useEffect(() => {
    setPages({ id: subject.id, text: readPages(subject.id) });
    setPagesNotice(null);
  }, [subject.id]);

  useEffect(() => {
    if (pages.id !== subject.id) return;
    try {
      localStorage.setItem(spacePagesKey(subject.id), pages.text);
    } catch { /* convenience only */ }
  }, [pages, subject.id]);

  useEffect(() => {
    let timer: number | undefined;
    const onSave = (event: Event) => {
      const content = (event as CustomEvent<{ content?: string }>).detail?.content?.trim();
      if (!content) return;
      setPages((prev) => {
        const base = prev.id === subject.id ? prev.text : readPages(subject.id);
        return { id: subject.id, text: base.trim() ? `${base.replace(/\s+$/, "")}\n\n---\n\n${content}\n` : `${content}\n` };
      });
      setPanel({ mode: "pages" });
      setPanelCollapsed(false);
      setOverlay(true);
      setPagesNotice("已存入空间笔记");
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setPagesNotice(null), 2400);
    };
    window.addEventListener(SAVE_TO_PAGE_EVENT, onSave);
    return () => {
      window.removeEventListener(SAVE_TO_PAGE_EVENT, onSave);
      window.clearTimeout(timer);
    };
  }, [subject.id]);

  useEffect(() => {
    const onRefresh = (event: Event) => {
      const subjectId = (event as CustomEvent<{ subjectId?: string }>).detail?.subjectId;
      if (subjectId !== subject.id) return;
      setPages({ id: subject.id, text: readPages(subject.id) });
    };
    window.addEventListener(SPACE_PAGES_EVENT, onRefresh);
    return () => window.removeEventListener(SPACE_PAGES_EVENT, onRefresh);
  }, [subject.id]);

  const exportPages = () => {
    const blob = new Blob([pages.text], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${subject.name.replace(/[\\/:*?"<>|]/g, "_") || "空间笔记"}-笔记.md`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const startTransfer = (anchorText: string, skills: string[]) => {
    if (!mainId) return;
    void syncPriorSkills(skills).catch(() => { /* 画像同步失败不阻塞开讲 */ });
    void chat.sendTo(
      mainId,
      `我已经掌握了「${anchorText}」基础，接下来学习「${subject.name}」时，请优先用对比迁移学习法，将新概念与我熟悉的「${anchorText}」做映射对比，并提醒我容易混淆的负迁移误区。`,
    );
  };

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

  const attackFromGraph = async (target: AttackTarget) => {
    const title = `专项：${target.label}`.trim().slice(0, 60);
    const prompt = target.kind === "misconception"
      ? `针对我之前在「${target.label}」上的薄弱点（${target.summary}），请开启一个巩固支线，带我彻底搞懂并做一道题验证。`
      : `请围绕待解锁概念「${target.label}」（${target.summary}）开启专项学习，从我已经掌握的内容往前推进一步，并做一道题验证。`;
    const anchorMessageId = [...(main?.messages ?? [])].reverse().find((message) => message.id)?.id;
    const thread = await chatApi.createThread(subject.id, {
      title,
      clientRequestId: globalThis.crypto.randomUUID(),
      ...(anchorMessageId ? { anchorMessageId } : {}),
    });
    await chat.loadConversation(thread.id);
    openThread(thread.id);
    void refreshThreads();
    void chat.sendTo(thread.id, prompt);
  };

  const finishResolve = async (id: string, messageId: string | null) => {
    setResolveFor(null);
    setDraft(null);
    setDraftError(null);
    setMergeNotice({ threadId: id, messageId });
    if (mainId) await chat.loadConversation(mainId);
    void chat.loadConversation(id);
    void refreshThreads();
    void chat.loadSubjects();
    void chat.loadMemories();
  };

  const beginResolve = async (id: string) => {
    if (resolvingId) return;
    setResolvingId(id);
    setDraftError(null);
    let drafted: { title: string; summary: string; takeaways: string } | null = null;
    try {
      const result = await chatApi.draftResolution(id);
      drafted = { title: result.title, summary: result.summary, takeaways: result.takeaways.join("\n") };
      const resolved = await chatApi.resolveThread(id, {
        title: result.title.trim(),
        summary: result.summary.trim(),
        takeaways: result.takeaways.map((item) => item.trim()).filter(Boolean).slice(0, 4),
      });
      await finishResolve(id, resolved.messageId);
    } catch (error) {
      setResolveFor(id);
      setDraft(drafted);
      setDraftError(toApiError(error).message);
      setDrafting(false);
    } finally {
      setResolvingId(null);
    }
  };

  const confirmResolve = async () => {
    if (!resolveFor || !draft || saving) return;
    setSaving(true);
    try {
      const resolved = await chatApi.resolveThread(resolveFor, {
        title: draft.title.trim(),
        summary: draft.summary.trim(),
        takeaways: draft.takeaways.split("\n").map((item) => item.trim()).filter(Boolean).slice(0, 4),
      });
      await finishResolve(resolveFor, resolved.messageId);
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
  const weakReady = spaceMemories.filter((memory) => memory.kind === "misconception").length >= 3;
  const threadSignal = threads.length > 0 || Boolean(main?.messages.some((message) => (
    message.threadUpdate || message.threadSummary || (message.threadProposals?.length ?? 0) > 0
  )));
  const conversationTitles = useMemo(
    () => Object.fromEntries(chat.conversations.map((item) => [item.id, item.title])),
    [chat.conversations],
  );
  const failureFor = (id: string | null) => chat.sendFailure?.conversationId === id ? chat.sendFailure : null;
  const panelVisible = (!narrow && !panelCollapsed) || overlay;
  const isOverviewOn = panelVisible && panel.mode === "info" && panel.section === "about";
  const libraryOpen = panel.mode === "pages" || (panel.mode === "info" && panel.section === "files");
  // 只有选中的标签显示名字，其余只留图标（名字放在悬停提示和无障碍标签里）
  const tabs: Array<{
    key: string; icon: LucideIcon; label: string; title: string; active: boolean; open: () => void;
    count?: number; coachmark?: string;
  }> = [
    { key: "list", icon: MessagesSquare, label: "支线", title: "支线", active: panel.mode === "list",
      open: () => setPanel({ mode: "list" }), count: openThreads.length, coachmark: threadSignal ? "thread" : undefined },
    { key: "library", icon: LibraryIcon, label: "资料库", title: "资料库：课程资料与空间笔记", active: libraryOpen,
      open: () => setPanel({ mode: "info", section: "files" }) },
    { key: "graph", icon: Waypoints, label: "图谱", title: "知识迷雾拓扑图", active: panel.mode === "graph",
      open: () => setPanel({ mode: "graph" }), coachmark: weakReady && fogReady ? "fog" : undefined },
    { key: "tasks", icon: ListTodo, label: "任务", title: "这个空间的日程任务", active: panel.mode === "tasks",
      open: () => setPanel({ mode: "tasks" }) },
    { key: "memory", icon: Brain, label: "记忆", title: `空间学习记忆 (${spaceMemories.length})`,
      active: panel.mode === "info" && panel.section === "memory", open: () => setPanel({ mode: "info", section: "memory" }) },
    { key: "about", icon: SlidersHorizontal, label: "概览", title: "空间概览与教学说明",
      active: panel.mode === "info" && panel.section === "about", open: () => setPanel({ mode: "info", section: "about" }) },
  ];
  const tabsRef = useRef<HTMLDivElement>(null);
  const tabThumb = useSlidingThumb(tabsRef, [panel.mode, panel.mode === "info" ? panel.section : null, openThreads.length, panelVisible]);

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
            <GraduationCap size={13} />
          </span>
          <div className={styles.heading}>
            <h1>{subject.name}</h1>
            {levelLabel(subject.level, lang) && <span className={styles.tag}>{levelLabel(subject.level, lang)}</span>}
            {subject.deadline && (
              <span className={styles.metaPill} title={`截止 ${subject.deadline}`}>
                <CalendarDays size={11} aria-hidden />
                <span>{subject.deadline}</span>
              </span>
            )}
            {subject.goal && (
              <span className={cx(styles.metaPill, styles.metaGoal)} title={`目标：${subject.goal}`}>
                <Target size={11} aria-hidden />
                <span>{subject.goal}</span>
              </span>
            )}
          </div>

          <div className={styles.tools} role="group" aria-label="空间操作">
            <button type="button" className={styles.overviewBtn} data-coachmark={weakReady ? "sheet" : undefined} onClick={() => { setCheatSheetOpen(true); window.dispatchEvent(new Event(CHEATSHEET_OPENED_EVENT)); }} title="生成考前急救一页纸">
              <Zap size={13} aria-hidden />
              <span>考前一页纸</span>
            </button>
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
                data-coachmark={threadSignal ? "thread" : undefined}
                onClick={() => showPanel({ mode: "list" })}
              >
                <MessagesSquare size={13} aria-hidden />
                <span>支线</span>
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

        {cheatSheetOpen && (
          <CheatSheet subject={subject} notes={pages.id === subject.id ? pages.text : ""} onClose={() => setCheatSheetOpen(false)} />
        )}

        {confirmDelete && (
          <div className={styles.confirm} role="group">
            <span>删除后，主线和支线会变成普通对话，记忆改为通用。</span>
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
                      : "主线负责规划整体路线，具体卡点与练习会在右侧开启并行支线。你可以从以下方式开始："}
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
                          `我想用费曼学习法自测「${subject.name}」的核心概念：请开启一个支线，由我讲给你听，你来挑刺追问我。`,
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
                {main.messages.length === 0 && (
                  <section className={styles.anchorCard} aria-label="迁移学习先验锚点">
                    <div className={styles.anchorHead}>
                      <Link2 size={13} aria-hidden />
                      <strong>迁移学习先验锚点</strong>
                    </div>
                    <p className={styles.anchorDesc}>
                      选一个你已经掌握的旧知，AI 会把「{subject.name}」的新概念与它做对比映射，并提醒负迁移误区。
                    </p>
                    <div className={styles.anchorPills} role="group" aria-label="先验基础">
                      {TRANSFER_ANCHORS.map((anchor) => (
                        <button
                          key={anchor.label}
                          type="button"
                          className={styles.anchorPill}
                          disabled={Boolean(mainPhase)}
                          onClick={() => startTransfer(anchor.text, anchor.skills)}
                        >
                          {anchor.label}
                        </button>
                      ))}
                    </div>
                    <form
                      className={styles.anchorForm}
                      onSubmit={(event) => {
                        event.preventDefault();
                        const text = customAnchor.trim();
                        if (!text || mainPhase) return;
                        startTransfer(text, [text]);
                        setCustomAnchor("");
                      }}
                    >
                      <input
                        value={customAnchor}
                        maxLength={30}
                        aria-label="自定义先验基础"
                        placeholder="或输入其他旧知，如「离散数学」"
                        onChange={(event) => setCustomAnchor(event.target.value)}
                      />
                      <button type="submit" className={styles.anchorGo} disabled={!customAnchor.trim() || Boolean(mainPhase)}>
                        用对比迁移法开讲 →
                      </button>
                    </form>
                  </section>
                )}
              </div>
            )}
            onRegenerate={() => void chat.regenerate(mainId)}
            onStartExercise={(problemId) => void chat.sendTo(mainId, `请安排练习「${problemsById[problemId]?.title ?? problemId}」，在支线中带我完成。`)}
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
            onSendText={(text) => void chat.sendTo(mainId, text)}
            onOpenWeakPoints={() => showPanel({ mode: "graph" })}
            scrollTarget={scrollTarget}
          />
        ) : (
          <div className={styles.center}><p>正在读取主线…</p></div>
        )}
        {mainId && (
          <div className={styles.dock}>
            {mergeNotice && (
              <div className={styles.mergeNotice} role="status">
                <CheckCircle2 size={14} aria-hidden />
                <span>已合并到主线</span>
                <button
                  type="button"
                  className={styles.mergeAction}
                  onClick={() => setScrollTarget({ messageId: mergeNotice.messageId, threadId: mergeNotice.threadId, nonce: Date.now() })}
                >
                  查看
                </button>
                <button
                  type="button"
                  className={styles.mergeAction}
                  onClick={() => {
                    const id = mergeNotice.threadId;
                    void reopen(id).then(() => {
                      setMergeNotice(null);
                      openThread(id);
                    });
                  }}
                >
                  重新打开
                </button>
                <button type="button" className={styles.mergeDismiss} aria-label="关闭提示" onClick={() => setMergeNotice(null)}>
                  <X size={13} />
                </button>
              </div>
            )}
            {failureFor(mainId) && <p className={styles.error}>{failureFor(mainId)?.error.message}</p>}
            <Composer
              conversationId={mainId}
              messages={main?.messages}
              value={chat.draftFor(mainId)}
              onChange={(value) => chat.setDraftFor(mainId, value)}
              onSend={() => void chat.sendTo(mainId, chat.draftFor(mainId))}
              onStop={() => void chat.stop(mainId)}
              phase={chat.streamFor(mainId)?.phase ?? null}
              busy={false}
              problems={[]}
              onStartExercise={(problemId) => void chat.sendTo(mainId, `请安排练习「${problemsById[problemId]?.title ?? problemId}」，在支线中带我完成。`)}
              autoFocusKey={mainId}
              placeholder="描述学习需求、补充条件，或直接提问…"
              modelKey={chat.modelKeyFor(mainId)}
              onModelKeyChange={(key) => chat.setConversationModel(mainId, key)}
            />
          </div>
        )}
      </section>

      {panelVisible && (
        <aside className={cx(styles.panel, narrow && styles.overlay)}>
          {/* 右侧面板顶栏：列表态为 Tab 栏，进入具体支线时切换为面包屑顶栏（支线 › 标题） */}
          <header className={styles.panelBar}>
            {panel.mode === "thread" && threadId ? (
              <div className={styles.breadcrumbBar}>
                <button
                  type="button"
                  className={styles.crumbRoot}
                  data-coachmark={threadSignal ? "thread" : undefined}
                  onClick={() => setPanel({ mode: "list" })}
                >
                  支线
                </button>
                <ChevronRight size={13} className={styles.crumbSep} aria-hidden />
                <strong className={styles.crumbCurrent} title={threadSummary?.title ?? "支线"}>
                  {threadSummary?.title ?? "支线"}
                </strong>
                {threadSummary?.executionStatus && (
                  <span className={styles.crumbStatus} role="status">
                    {executionLabel[threadSummary.executionStatus]}
                  </span>
                )}
              </div>
            ) : (
              <div ref={tabsRef} className={styles.panelTabs} role="tablist" aria-label="右侧面板视图">
                {tabThumb && (
                  <span
                    className={cx(styles.panelThumb, tabThumb.animate && styles.panelThumbSlide)}
                    style={{ width: tabThumb.width, transform: `translateX(${tabThumb.x}px)` }}
                    aria-hidden
                  />
                )}
                {tabs.map((tab) => (
                  <button
                    key={tab.key}
                    type="button"
                    role="tab"
                    aria-selected={tab.active}
                    aria-label={tab.label}
                    title={tab.title}
                    className={cx(styles.panelTab, tab.active && styles.panelTabActive)}
                    data-coachmark={tab.coachmark}
                    onClick={tab.open}
                  >
                    <tab.icon size={14} aria-hidden />
                    {tab.active && <span className={styles.tabLabel}>{tab.label}</span>}
                    {tab.active && tab.count !== undefined && tab.count > 0 && <span className={styles.tabCount}>{tab.count}</span>}
                  </button>
                ))}
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
                      aria-label="重新打开支线"
                      title="重新打开支线"
                    >
                      <RotateCcw size={14} />
                    </button>
                  ) : (
                    <button
                      type="button"
                      className={styles.panelActionBtn}
                      disabled={Boolean(threadPhase) || resolvingId === threadId}
                      aria-busy={resolvingId === threadId || undefined}
                      onClick={() => void beginResolve(threadId)}
                      aria-label="标记为已解决并合并回主线"
                      title="已解决（合并小结回主线）"
                    >
                      {resolvingId === threadId ? <LoaderCircle className={styles.spin} size={15} /> : <CheckCircle2 size={15} />}
                    </button>
                  )}
                  <span className={styles.usageSlot}>
                    <UsageStats usage={usage?.conversations[threadId]} label="用量" align="right" />
                  </span>
                </>
              ) : (
                <span className={styles.usageSlot}><UsageStats usage={usage?.total} label="用量" align="right" /></span>
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
                  setOverlay(false);
                  setPanelCollapsed(true);
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
              onResolve={(id) => void beginResolve(id)}
              resolvingId={resolvingId}
              onReopen={(id) => void reopen(id)}
            />
          )}
          {panel.mode === "tasks" && (
            <SpaceTasks
              subject={{ id: subject.id, name: subject.name, color: subject.color, deadline: subject.deadline ?? null }}
              subjects={chat.subjects.map((item) => ({ id: item.id, name: item.name, color: item.color }))}
              onOpenThread={openThread}
            />
          )}
          {panel.mode === "graph" && (
            <ConceptGraph
              subjectId={subject.id}
              subjectName={subject.name}
              onAttack={attackFromGraph}
              onOpenThread={openThread}
              onStart={() => showPanel({ mode: "list" })}
            />
          )}
          {panel.mode === "pages" && (
            <div className={styles.pagesPane}>
              <header className={styles.pagesBar}>
                <button type="button" className={styles.pagesBack} onClick={() => setPanel({ mode: "info", section: "files" })}>
                  <ChevronLeft size={14} aria-hidden />资料库
                </button>
                <strong>空间笔记</strong>
                <div className={styles.pagesViews} role="group" aria-label="笔记视图">
                  {([["edit", "编辑"], ["split", "分栏"], ["preview", "预览"]] as const).map(([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      aria-pressed={pagesView === id}
                      className={cx(styles.pagesViewBtn, pagesView === id && styles.pagesViewOn)}
                      onClick={() => setPagesView(id)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <button type="button" className={styles.pagesExport} disabled={!pages.text.trim()} onClick={exportPages}>
                  <Download size={12} aria-hidden />
                  <span>[⬇ 导出为 .md 文件]</span>
                </button>
              </header>
              {pagesNotice && <p className={styles.pagesNotice} role="status">{pagesNotice}</p>}
              <div className={styles.pagesBody}>
                {pagesView !== "preview" && (
                  <textarea
                    className={styles.pagesEditor}
                    value={pages.id === subject.id ? pages.text : ""}
                    aria-label="空间笔记（Markdown）"
                    placeholder="在这里记录本空间的笔记，支持 Markdown。对话里点「存入空间笔记」会自动追加到这里。"
                    onChange={(event) => setPages({ id: subject.id, text: event.target.value })}
                  />
                )}
                {pagesView !== "edit" && (
                  <div className={styles.pagesPreview}>
                    {pages.text.trim() ? <Markdown text={pages.text} /> : <p className={styles.muted}>暂无内容，预览会实时显示在这里。</p>}
                  </div>
                )}
              </div>
            </div>
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
                  collapseLong={false}
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
                  onSendText={(text) => void chat.sendTo(threadId, text)}
                  onOpenWeakPoints={() => showPanel({ mode: "graph" })}
                />
              )}
              <div className={styles.dock}>
                {failureFor(threadId) && <p className={styles.error}>{failureFor(threadId)?.error.message}</p>}
                <Composer
                  inputId="thread-composer"
                  conversationId={threadId}
                  messages={thread?.messages}
                  value={chat.draftFor(threadId)}
                  onChange={(value) => chat.setDraftFor(threadId, value)}
                  onSend={() => void chat.sendTo(threadId, chat.draftFor(threadId))}
                  onStop={() => void chat.stop(threadId)}
                  phase={threadPhase}
                  busy={false}
                  problems={chat.problems}
                  onStartExercise={(problemId) => void chat.startExerciseOn(threadId, problemId)}
                  autoFocusKey={threadId}
                  placeholder="引导或追问这个支线…"
                  modelKey={chat.modelKeyFor(threadId, threadSummary?.modelKey ?? null)}
                  onModelKeyChange={(key) => chat.setConversationModel(threadId, key)}
                />
              </div>
            </div>
          )}
          {panel.mode === "info" && (
            <div className={styles.info}>
              {panel.section !== "files" && (
                <header className={styles.threadSubHead}>
                  <strong>{panel.section === "about" ? "空间概览与教学说明" : "空间学习记忆"}</strong>
                </header>
              )}
              {panel.section === "about" && (
                <div className={styles.about}>
                  <div className={styles.aboutMeta}>
                    <div><span>目标</span><p>{subject.goal || "未填写"}</p></div>
                    {levelLabel(subject.level, lang) && <div><span>基础</span><p>{levelLabel(subject.level, lang)}</p></div>}
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

                  {/* 零成本足迹式知识看板（不耗额外 Token，自动聚合本空间卡点、已掌握与已解决支线） */}
                  <div className={styles.footprintSection}>
                    <span className={styles.footprintTitle}>空间知识足迹（自动聚合）</span>
                    <div className={styles.footprintStats}>
                      <div className={styles.footprintStat}>
                        <strong>{spaceMemories.filter((m) => m.kind === "misconception" && m.status !== "resolved").length}</strong>
                        <span>待巩固卡点</span>
                      </div>
                      <div className={styles.footprintStat}>
                        <strong>{openThreads.length}</strong>
                        <span>进行中支线</span>
                      </div>
                      <div className={styles.footprintStat}>
                        <strong>{spaceMemories.filter((m) => m.kind === "mastery" || m.status === "resolved").length + doneThreads.length}</strong>
                        <span>已攻克归档</span>
                      </div>
                    </div>

                    {spaceMemories.filter((m) => m.kind === "misconception" && m.status !== "resolved").length > 0 && (
                      <div className={styles.footprintGroup}>
                        <p className={styles.footprintGroupHead}>
                          <i className={cx(styles.headDot, styles.headDotRed)} aria-hidden />
                          待攻克薄弱点
                        </p>
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
                                      `针对我之前在「${m.topic}」上的薄弱点（${m.summary}），请开启一个巩固支线，带我彻底搞懂并做一道题验证。`,
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
                        <p className={styles.footprintGroupHead}>
                          <i className={cx(styles.headDot, styles.headDotGreen)} aria-hidden />
                          已掌握与已归档
                        </p>
                        {doneThreads.map((t) => (
                          <button
                            key={t.id}
                            type="button"
                            className={styles.footprintDoneRow}
                            onClick={() => openThread(t.id)}
                          >
                            <CheckCircle2 size={13} className={styles.footprintDoneIcon} aria-hidden />
                            <span>支线 · {t.title}</span>
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
              {panel.section === "files" && (
                <Library
                  subjectId={subject.id}
                  notesChars={pages.id === subject.id ? pages.text.trim().length : 0}
                  onOpenNotes={() => setPanel({ mode: "pages" })}
                  onChange={() => void chat.loadSubjects()}
                />
              )}
              {panel.section === "memory" && (
                <div className={styles.memoriesPane}>
                  {spaceMemories.length === 0 ? (
                    <div className={styles.muted}>
                      <p>这个空间的误区和掌握会出现在这里。</p>
                      <button type="button" onClick={() => showPanel({ mode: "list" })}>去主线讲一讲</button>
                    </div>
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
            <h2>合并回主线</h2>
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

type RingKind = "idle" | "working" | "waiting" | "failed" | "done";

function ringKind(status: ConversationSummary["executionStatus"], resolved: boolean): RingKind {
  if (resolved) return "done";
  if (status === "working" || status === "queued") return "working";
  if (status === "waiting") return "waiting";
  if (status === "failed") return "failed";
  return "idle";
}

/** Linear 式状态圆环：进行中蓝色弧环、已完成绿色实心勾、空闲虚线环。 */
function StatusRing({ kind }: { kind: RingKind }) {
  return (
    <svg className={cx(styles.ring, styles[`ring_${kind}`])} width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      {kind === "done" ? (
        <>
          <circle cx="8" cy="8" r="7" fill="currentColor" />
          <path d="M4.8 8.2 7 10.4l4.2-4.6" stroke="var(--bg-panel)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </>
      ) : kind === "working" ? (
        <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeDasharray="28 10" transform="rotate(-90 8 8)" />
      ) : kind === "idle" ? (
        <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2.4 2.6" />
      ) : (
        <>
          <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.6" />
          <path d="M8 5v3.4M8 10.6v.1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </>
      )}
    </svg>
  );
}

function shortTime(iso: string, now = Date.now()): string {
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return "";
  const minutes = Math.floor(Math.max(0, now - time) / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

function ThreadList({
  subjectName, openThreads, doneThreads, usage, onOpen, onResolve, resolvingId, onReopen,
}: {
  subjectName: string;
  openThreads: ConversationSummary[];
  doneThreads: ConversationSummary[];
  usage: Record<string, TokenUsage>;
  onOpen: (id: string) => void;
  onResolve: (id: string) => void;
  resolvingId: string | null;
  onReopen: (id: string) => void;
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
          当主线开始拆解问题时，KnowGap 会在这里追踪每个支线的实时状态：哪些正在执行、哪些等待你回应、哪些已解决。
        </p>
      </div>

      {isEmpty ? (
        <div className={styles.emptyThreadsCenter}>
          <MessagesSquare size={22} strokeWidth={1.5} aria-hidden />
          <p>开始对话后，你的支线会显示在这里。</p>
        </div>
      ) : (
        <>
          {[
            { label: "等待你", items: openThreads.filter((item) => item.executionStatus === "waiting" || item.executionStatus === "failed") },
            { label: "正在执行", items: openThreads.filter((item) => item.executionStatus === "working" || item.executionStatus === "queued") },
            { label: "空闲", items: openThreads.filter((item) => !item.executionStatus || item.executionStatus === "idle" || item.executionStatus === "cancelled") },
          ].filter((group) => group.items.length > 0).map((group) => (
            <section key={group.label}>
              <p className={styles.group}>
                <span>{group.label}</span>
                <span className={styles.groupCount}>{group.items.length}</span>
              </p>
              <ul className={styles.rowList}>{group.items.map((item) => {
                const kind = ringKind(item.executionStatus, false);
                const running = kind === "working";
                return (
                  <li key={item.id} className={styles.row}>
                    <button type="button" className={styles.rowMain} onClick={() => onOpen(item.id)}>
                      <StatusRing kind={kind} />
                      <span className={styles.rowBody}>
                        <span className={styles.rowTitle}>{item.title}</span>
                        {item.preview && <span className={styles.rowSummary}>{plainText(item.preview)}</span>}
                      </span>
                      <span className={styles.rowMeta}>
                        <span className={cx(styles.badge, styles[`badge_${item.executionStatus ?? "idle"}`])}>
                          {item.executionStatus ? executionLabel[item.executionStatus] : "空闲"}
                        </span>
                        <span className={styles.rowTime}>{shortTime(item.updatedAt)}</span>
                      </span>
                    </button>
                    <div className={styles.rowActions}>
                      <button
                        type="button"
                        className={styles.rowAction}
                        disabled={running || resolvingId === item.id}
                        aria-busy={resolvingId === item.id || undefined}
                        onClick={() => onResolve(item.id)}
                        title={running ? "执行中，完成后可归档" : "已解决（合并小结回主线）"}
                      >
                        {resolvingId === item.id ? "合并中…" : "归档总结"}
                      </button>
                    </div>
                    {usage[item.id] && <div className={styles.threadUsage}><UsageStats usage={usage[item.id]} align="right" /></div>}
                  </li>
                );
              })}</ul>
            </section>
          ))}
          {doneThreads.length > 0 && (
            <p className={styles.group}>
              <span>已解决</span>
              <span className={styles.groupCount}>{doneThreads.length}</span>
            </p>
          )}
          <ul className={styles.rowList}>
            {doneThreads.map((item) => (
              <li key={item.id} className={cx(styles.row, styles.rowDone)}>
                <button type="button" className={styles.rowMain} onClick={() => onOpen(item.id)}>
                  <StatusRing kind="done" />
                  <span className={styles.rowBody}>
                    <span className={styles.rowTitle}>{item.title}</span>
                    {item.preview && <span className={styles.rowSummary}>{plainText(item.preview)}</span>}
                  </span>
                  <span className={styles.rowMeta}>
                    <span className={cx(styles.badge, styles.badge_done)}>已解决</span>
                    <span className={styles.rowTime}>{shortTime(item.updatedAt)}</span>
                  </span>
                </button>
                <div className={styles.rowActions}>
                  <button type="button" className={styles.rowAction} onClick={() => onReopen(item.id)}>
                    重新开启
                  </button>
                </div>
                {usage[item.id] && <div className={styles.threadUsage}><UsageStats usage={usage[item.id]} align="right" /></div>}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}


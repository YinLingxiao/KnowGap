"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import {
  ArrowLeftRight, Brain, ChevronRight, CircleAlert, Dumbbell, FileText, Folder,
  FolderKanban, Mic, PanelLeftOpen, RotateCcw, X,
} from "lucide-react";
import { useChat } from "@/hooks/useChat";
import type { HealthState } from "@/hooks/useWorkbench";
import { getAIConfig, type AIConfigStatus } from "@/lib/api/ai-config";
import { API_BASE_URL, DATA_SOURCE } from "@/lib/config";
import { cx } from "@/lib/cx";
import type { Problem } from "@/lib/types";
import { createMaterialClient } from "@/lib/api/material-client";
import { chatApi } from "@/lib/chat/api";
import type { SpaceInput } from "@/lib/chat/types";
import { studiedLabel } from "@/lib/chat/space";
import type { AuthUser } from "@/lib/api/auth";
import { applyAppearance, readAppearance } from "@/lib/appearance";
import { AuthView } from "../auth/AuthView";
import authStyles from "../auth/AuthView.module.css";
import { useAuth } from "../auth/useAuth";
import { MaterialLibrary } from "../MaterialLibrary";
import type { ModelSignal } from "../settings/ModelAccessCard";
import { SettingsDialog, type SettingsTab } from "../settings/SettingsDialog";
import { Toaster, useToasts } from "../ui/Toaster";
import { COMPOSER_ID, Composer } from "./Composer";
import { ConversationSidebar } from "./ConversationSidebar";
import { MemoryDrawer } from "./MemoryDrawer";
import { MessageList } from "./MessageList";
import { CreateSpaceDialog } from "./CreateSpaceDialog";
import { OnboardingStage } from "./OnboardingStage";
import { SpacesPage } from "./SpacesPage";
import { AgendaPage } from "../agenda/AgendaPage";
import { OPEN_AGENDA_EVENT } from "./AgendaToolCard";
import { SubjectPage } from "./SubjectPage";
import { SubjectPicker } from "./SubjectPicker";
import { FocusCapsule } from "../focus/FocusCapsule";
import styles from "./ChatApp.module.css";

const NARROW = "(max-width: 860px)";
function viewKey(userId: string) {
  return `${userId}:knowgap.chat.view.v1:${API_BASE_URL}`;
}

const STARTERS = [
  { icon: ArrowLeftRight, label: "对比迁移学习", color: "#f43f5e", text: "我之前学过 [某基础]，请用对比迁移的方式帮我理解当前概念，并列出异同点：" },
  { icon: Mic, label: "费曼反转自测", color: "#3b82f6", text: "我想用费曼学习法自测：请你扮演有疑惑的同桌听我讲，并在我讲漏边界条件时追问我：" },
  { icon: Dumbbell, label: "联网搜真题练习", color: "#10b981", text: "请帮我搜几道关于「在此填写知识点」的经典真题或母题来练手：" },
  { icon: FileText, label: "编程代码实验台", color: "#f59e0b", text: "请先讲清「在此填写编程/算法概念」的核心原理，然后给我一个带 TODO 挖空的 `code_playground` 代码实验台让我动手补全并运行：" },
];

function formatZhDate(iso: string): string {
  const m = Number(iso.slice(5, 7));
  const d = Number(iso.slice(8, 10));
  if (Number.isFinite(m) && Number.isFinite(d) && m > 0 && d > 0) return `${m}月${d}日`;
  return iso.slice(5, 10);
}

/** 首次登录前置破冰访谈的 3 轮辅助快捷回答胶囊 */
const ONBOARDING_QUICK_REPLIES: string[][] = [
  [
    "我正在学一门课程，想把基础概念弄清楚",
    "我正在准备考试，希望围绕薄弱点练习",
    "我在自主探索新领域，目标还在慢慢明确",
  ],
  [
    "先给我一个具体的例子或直观类比，顺着例子理解概念最容易懂",
    "先给核心结论和对比表格，再展开细节，别铺垫太长",
    "推导过程要严谨，把前因后果和适用边界一步步讲透",
  ],
  [
    "做题时先给一小步提示让我自己想，别直接泄底完整答案",
    "讲完核心概念后随手考我 1 道小题，帮我检验是不是真懂了",
    "卡住时直接给我正误对比和完整解析，这样效率最高",
  ],
];

/** 主区域显示什么：对话、学习空间总览、某个学习空间，或通用资料 */
type View = { type: "chat" } | { type: "subject"; id: string } | { type: "materials" } | { type: "spaces" } | { type: "agenda" };

function readView(userId: string): View {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(viewKey(userId)) ?? "null");
    if (parsed && typeof parsed === "object" && "type" in parsed) {
      if (parsed.type === "subject" && "id" in parsed && typeof parsed.id === "string") return { type: "subject", id: parsed.id };
      if (parsed.type === "materials") return { type: "materials" };
      if (parsed.type === "spaces") return { type: "spaces" };
      if (parsed.type === "agenda") return { type: "agenda" };
    }
  } catch { /* unavailable storage falls back to the chat view */ }
  return { type: "chat" };
}

function greeting(name: string, hour = new Date().getHours()): string {
  if (hour < 5) return `夜深了，${name}`;
  if (hour < 11) return `早上好，${name}`;
  if (hour < 13) return `中午好，${name}`;
  if (hour < 18) return `下午好，${name}`;
  return `晚上好，${name}`;
}

function isTyping(target: EventTarget | null) {
  return target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
}

function AuthenticatedChat({ user, onLogout, onRename }: {
  user: AuthUser;
  onLogout: () => void;
  onRename: (name: string) => Promise<void>;
}) {
  const { toasts, push, dismiss } = useToasts();
  const chat = useChat(push, user.id);
  const [narrow, setNarrow] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [zen, setZen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [memoryFocus, setMemoryFocus] = useState<string[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("general");
  const openSettings = useCallback((tab: SettingsTab = "general") => {
    setSettingsTab(tab);
    setSettingsOpen(true);
  }, []);
  const [view, setViewState] = useState<View>({ type: "chat" });
  const [spaceDialog, setSpaceDialog] = useState<null | { editId?: string; select: boolean }>(null);
  const [viewRestored, setViewRestored] = useState(false);
  const [health, setHealth] = useState<HealthState>("checking");
  const [modelConfigured, setModelConfigured] = useState<boolean | null>(null);
  const [onboardingMode, setOnboardingMode] = useState(false);
  const [onboardingConvId, setOnboardingConvId] = useState<string | null>(null);
  const [interview, setInterview] = useState<Awaited<ReturnType<typeof chatApi.onboardingStatus>> | null>(null);
  const [profileEntries, setProfileEntries] = useState<Record<string, string>>({});
  const [interviewError, setInterviewError] = useState("");
  const [profileSaving, setProfileSaving] = useState(false);

  useEffect(() => {
    const query = window.matchMedia(NARROW);
    const apply = () => {
      setNarrow(query.matches);
      setSidebarOpen(!query.matches);
    };
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, []);

  useEffect(() => {
    applyAppearance(readAppearance(user.id));
  }, [user.id]);

  const checkHealth = useCallback(async () => {
    setHealth("checking");
    try {
      const response = await fetch(`${API_BASE_URL}/health`, { cache: "no-store" });
      setHealth(response.ok ? "online" : "offline");
    } catch {
      setHealth("offline");
    }
  }, []);

  useEffect(() => {
    void checkHealth();
    getAIConfig()
      .then((config) => {
        setModelConfigured(config.configured);
      })
      .catch(() => setModelConfigured(null));
  }, [checkHealth]);

  const closeOverlays = useCallback(() => {
    if (narrow) setSidebarOpen(false);
  }, [narrow]);

  const setView = useCallback((next: View) => {
    setViewState(next);
    try {
      localStorage.setItem(viewKey(user.id), JSON.stringify(next));
    } catch { /* per-viewer convenience only */ }
  }, [user.id]);

  const { openConversation } = chat;
  const openSpace = useCallback((id: string) => {
    setView({ type: "subject", id });
  }, [setView]);

  useEffect(() => {
    const saved = readView(user.id);
    if (saved.type !== "chat") setViewState(saved);
    setViewRestored(true);
  }, [user.id]);

  // 首次登录检测：若尚未完成前置破冰引导（onboarded === false），自动进入 AI 主动发问的三问三答对话
  useEffect(() => {
    if (DATA_SOURCE !== "api") return;
    let cancelled = false;
    chatApi.onboardingStatus()
      .then(async (status) => {
        if (cancelled) return;
        setInterview(status);
        if (cancelled || status.status === "completed" || status.status === "skipped") return;
        const conv = await chatApi.startOnboarding();
        if (cancelled) return;
        setOnboardingConvId(conv.id);
        setOnboardingMode(true);
        setSidebarOpen(false);
        setView({ type: "chat" });
        openConversation(conv.id);
        void chat.refreshList();
      })
      .catch(() => setInterviewError("无法读取初识进度，请刷新重试。"));
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once per authenticated user
  }, [user.id]);

  const finishOnboarding = useCallback(async (openCreateSpace = false) => {
    if (!interview || profileSaving) return;
    setProfileSaving(true);
    try {
      if (interview.ready) await chatApi.completeOnboarding(interview.version, profileEntries);
      else await chatApi.skipOnboarding();
    } catch (error) {
      setInterviewError(error instanceof Error ? error.message : "保存失败，请重试。");
      setProfileSaving(false);
      return;
    }
    setProfileSaving(false);
    setOnboardingMode(false);
    if (!narrow) setSidebarOpen(true);
    chat.newChat();
    if (openCreateSpace) {
      setSpaceDialog({ select: false });
    }
  }, [chat, narrow, interview, profileEntries, profileSaving]);

  useEffect(() => {
    if (!onboardingMode || !onboardingConvId || chat.streams[onboardingConvId]) return;
    let cancelled = false;
    chatApi.onboardingStatus().then((next) => {
      if (cancelled) return;
      setInterview(next);
      setProfileEntries(Object.fromEntries(Object.entries(next.draft)
        .filter(([, item]) => !item.declined).map(([key, item]) => [key, item.value])));
    }).catch(() => setInterviewError("进度同步失败，请刷新重试。"));
    return () => { cancelled = true; };
  }, [onboardingMode, onboardingConvId, chat.streams]);

  const subjectMissing = view.type === "subject" && viewRestored && !chat.listLoading
    && !chat.subjects.some((subject) => subject.id === view.id);
  useEffect(() => {
    if (!subjectMissing) return;
    const timer = window.setTimeout(() => setView({ type: "chat" }), 1500);
    return () => window.clearTimeout(timer);
  }, [subjectMissing, setView]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMemoryOpen(false);
        if (narrow) setSidebarOpen(false);
        return;
      }
      if (settingsOpen || event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return;
      if (event.key === "/") {
        event.preventDefault();
        document.getElementById(COMPOSER_ID)?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [narrow, settingsOpen]);

  const problemsById = useMemo(
    () => Object.fromEntries(chat.problems.map((problem) => [problem.id, problem])) as Record<string, Problem>,
    [chat.problems],
  );
  const memoriesById = useMemo(() => Object.fromEntries(chat.memories.map((memory) => [memory.id, memory])), [chat.memories]);
  const subjectNames = useMemo(
    () => Object.fromEntries(chat.subjects.map((subject) => [subject.id, subject.name])) as Record<string, string>,
    [chat.subjects],
  );
  const conversationTitles = useMemo(
    () => Object.fromEntries(chat.conversations.map((item) => [item.id, item.title])),
    [chat.conversations],
  );
  const generatingIds = useMemo(
    () => Object.entries(chat.streams).filter(([, handle]) => handle.phase !== "analyzing").map(([id]) => id),
    [chat.streams],
  );

  const recentSpaces = useMemo(
    () => [...chat.subjects]
      .sort((a, b) => (b.progress.lastStudiedAt ?? b.updatedAt).localeCompare(a.progress.lastStudiedAt ?? a.updatedAt))
      .slice(0, 3),
    [chat.subjects],
  );

  const recentTopics = useMemo(
    () => chat.conversations
      .filter((c) => (c.kind ?? "chat") === "chat" && c.title !== "初识引导 · 定制你的学习画像")
      .slice(0, 5),
    [chat.conversations],
  );

  const reviewTarget = useMemo(
    () => chat.memories.find((m) => m.kind === "misconception" && (m.status === "suspected" || m.status === "needs_review")) ?? null,
    [chat.memories],
  );

  const messages = chat.activeThread?.messages ?? [];
  const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant" && message.kind === "text");
  const signalAt = lastAssistant ? Date.parse(lastAssistant.createdAt) : 0;
  const modelSignal: ModelSignal = lastAssistant?.status === "failed"
    ? { state: "unavailable", at: signalAt, detail: lastAssistant.error ?? undefined }
    : lastAssistant?.status === "complete" ? { state: "ok", at: signalAt } : { state: "unknown" };

  const handleConfigChange = useCallback((config: AIConfigStatus) => {
    setModelConfigured(config.configured);
  }, []);

  const openMemories = (ids: string[] = []) => {
    setMemoryFocus(ids);
    setMemoryOpen(true);
    void chat.loadMemories();
  };

  const showConversation = (id: string) => {
    setView({ type: "chat" });
    openConversation(id);
    closeOverlays();
  };
  // AI 回复里「已加入日程」卡片的「在日程中查看」
  useEffect(() => {
    const open = () => { setView({ type: "agenda" }); closeOverlays(); };
    window.addEventListener(OPEN_AGENDA_EVENT, open);
    return () => window.removeEventListener(OPEN_AGENDA_EVENT, open);
  });
  // 桌面端 Spotlight 快问浮窗「在主窗口打开」：主进程把对话 id 发到这里
  const showConversationRef = useRef(showConversation);
  showConversationRef.current = showConversation;
  useEffect(() => window.knowgap?.onOpenConversation?.((id) => showConversationRef.current(id)), []);

  if (DATA_SOURCE !== "api") {
    return (
      <div className={styles.mockNotice}>
        <h1>自由对话需要连接后端</h1>
        <p>
          在 <code>frontend/.env.local</code> 中设置 <code>NEXT_PUBLIC_DATA_SOURCE=api</code>，启动 FastAPI 后端后重启前端。
          聊天不会使用模拟数据伪造回复。
        </p>
      </div>
    );
  }

  const phase = chat.activeStream?.phase ?? null;
  const materialsOpen = view.type === "materials";
  const pageSubject = view.type === "subject" ? chat.subjects.find((subject) => subject.id === view.id) ?? null : null;
  const contextSubjectId = view.type === "subject"
    ? view.id
    : chat.activeId ? chat.activeConversation?.subjectId ?? null : chat.draftSubjectId;
  const contextSubjectName = contextSubjectId ? subjectNames[contextSubjectId] ?? null : null;
  const title = chat.activeConversation?.title ?? (chat.activeId ? "加载中…" : "新对话");
  const thread = chat.activeThread;
  const isOnboardingChat = Boolean(
    onboardingMode && chat.activeId && (chat.activeId === onboardingConvId || title.startsWith("初识引导")),
  );
  const lastThreadMsg = thread?.messages[thread.messages.length - 1];
  const onboardingFinished = isOnboardingChat
    && Boolean(interview?.ready)
    && phase === null
    && lastThreadMsg?.role === "assistant"
    && lastThreadMsg?.status === "complete";
  const quickReplies = isOnboardingChat && !onboardingFinished && phase === null
    ? ONBOARDING_QUICK_REPLIES[["background", "explanation", "interaction"].indexOf(interview?.stage ?? "background")] ?? []
    : [];
  const failure = chat.sendFailure && chat.sendFailure.conversationId === chat.activeId ? chat.sendFailure : null;
  const blankFailure = chat.sendFailure && !chat.activeId ? chat.sendFailure : null;
  const shownFailure = failure ?? blankFailure;
  const failureBar = shownFailure && (
    <div className={styles.sendFailure} role="alert">
      <CircleAlert size={14} aria-hidden />
      <span className={styles.sendFailureText}>
        发送失败：{shownFailure.error.message}
        {shownFailure.error.kind !== "conflict" && "（输入还在）"}
      </span>
      {shownFailure.error.kind === "conflict" && chat.activeId ? (
        <button onClick={() => { chat.dismissSendFailure(); void chat.loadConversation(chat.activeId!); }}>刷新对话</button>
      ) : (
        <button onClick={() => void chat.sendMessage()}>重试</button>
      )}
      <button className={styles.dismiss} onClick={chat.dismissSendFailure} aria-label="关闭提示">
        <X size={13} />
      </button>
    </div>
  );

  return (
    <div className={cx(styles.app, (!sidebarOpen || zen) && styles.sidebarClosed, narrow && styles.narrow, zen && styles.zen)}>
      {narrow && (
        <button
          className={cx(styles.backdrop, sidebarOpen && styles.backdropOpen)}
          aria-label="关闭侧栏"
          tabIndex={sidebarOpen ? 0 : -1}
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <aside className={styles.sidebar} aria-hidden={!sidebarOpen || undefined} inert={!sidebarOpen || undefined}>
        <div className={styles.sidebarInner}>
          <ConversationSidebar
            conversations={chat.conversations}
            loading={chat.listLoading}
            error={chat.listError}
            subjects={chat.subjects}
            activeId={view.type === "chat" ? chat.activeId : null}
            activeSubjectId={view.type === "subject" ? view.id : null}
            generatingIds={generatingIds}
            memoryCount={chat.memories.length}
            modelIssue={modelConfigured === false}
            materialsActive={materialsOpen}
            onNewChat={() => { setView({ type: "chat" }); chat.newChat(); closeOverlays(); }}
            onOpen={showConversation}
            onOpenSubject={(id) => { openSpace(id); closeOverlays(); }}
            onOpenSpaces={() => { setView({ type: "spaces" }); closeOverlays(); }}
            onCreateSpace={() => setSpaceDialog({ select: false })}
            spacesActive={view.type === "spaces"}
            onOpenAgenda={() => { setView({ type: "agenda" }); closeOverlays(); }}
            agendaActive={view.type === "agenda"}
            focusSlot={<FocusCapsule zen={zen} onZenChange={setZen} contextSubjectId={contextSubjectId} />}
            onRename={chat.renameConversation}
            onDelete={chat.deleteConversation}
            onRetry={() => void chat.refreshList()}
            onOpenMemory={() => { openMemories(); closeOverlays(); }}
            onOpenMaterials={() => { setView({ type: "materials" }); closeOverlays(); }}
            onOpenSettings={() => { openSettings(modelConfigured === false ? "models" : "general"); closeOverlays(); }}
            onCollapse={() => setSidebarOpen(false)}
            displayName={user.displayName}
            avatarText={user.avatarText}
          />
        </div>
      </aside>

      <main className={styles.main}>
        {!onboardingMode && interviewError && <p role="alert">{interviewError}<button onClick={() => window.location.reload()}>刷新重试</button></p>}
        {materialsOpen ? (
          <MaterialLibrary
            enabled
            unassigned
            subjects={chat.subjects}
            sidebarOpen={sidebarOpen}
            onOpenSidebar={() => setSidebarOpen(true)}
            onBack={() => setView({ type: "chat" })}
          />
        ) : view.type === "agenda" ? (
          <AgendaPage
            subjects={chat.subjects}
            sidebarOpen={sidebarOpen}
            onOpenSidebar={() => setSidebarOpen(true)}
            onOpenThread={(threadId, subjectId) => {
              if (!subjectId) return showConversation(threadId);
              // 学习空间页挂载时会恢复上次打开的面板，预先写入即可直接打开这个 Thread
              try {
                localStorage.setItem(`knowgap.space.panel.v1:${API_BASE_URL}:${subjectId}`,
                  JSON.stringify({ mode: "thread", id: threadId }));
              } catch { /* 存储不可用时只打开空间 */ }
              openSpace(subjectId);
            }}
            onNotify={push}
          />
        ) : view.type === "spaces" ? (
          <SpacesPage
            subjects={chat.subjects}
            sidebarOpen={sidebarOpen}
            onOpenSidebar={() => setSidebarOpen(true)}
            onOpen={(id) => setView({ type: "subject", id })}
            onCreate={() => setSpaceDialog({ select: false })}
            onEdit={(id) => setSpaceDialog({ editId: id, select: false })}
            onDelete={chat.deleteSubject}
          />
        ) : view.type === "subject" ? (
          pageSubject ? (
            <SubjectPage
              subject={pageSubject}
              chat={chat}
              narrow={narrow}
              sidebarOpen={sidebarOpen}
              memoriesById={memoriesById}
              problemsById={problemsById}
              subjectNames={subjectNames}
              onOpenSidebar={() => setSidebarOpen(true)}
              onEdit={() => setSpaceDialog({ editId: pageSubject.id, select: false })}
              onDelete={async () => {
                const ok = await chat.deleteSubject(pageSubject.id);
                if (ok) setView({ type: "spaces" });
                return ok;
              }}
            />
          ) : (
            <div className={styles.center}>
              <p className={styles.muted}>{subjectMissing ? "这个学习空间已不存在。" : "正在读取学习空间…"}</p>
            </div>
          )
        ) : chat.activeId && isOnboardingChat ? (
          <OnboardingStage
            messages={thread?.messages ?? []}
            stage={interview?.stage ?? "background"}
            ready={onboardingFinished}
            phase={phase}
            modelConfigured={modelConfigured}
            quickReplies={quickReplies}
            profileEntries={profileEntries}
            profileSaving={profileSaving}
            error={interviewError || shownFailure?.error.message || thread?.error?.message || ""}
            onChangeProfile={(key, value) => setProfileEntries((old) => ({ ...old, [key]: value }))}
            onSendAnswer={(text) => {
              setInterviewError("");
              return chat.sendTo(chat.activeId!, text);
            }}
            onConfirm={(createSpace) => void finishOnboarding(createSpace)}
            onSkip={() => {
              void chatApi.skipOnboarding().then(() => {
                setOnboardingMode(false);
                chat.newChat();
                setSidebarOpen(!narrow);
              }).catch(() => setInterviewError("跳过失败，请重试。"));
            }}
            onOpenModelSettings={() => openSettings("models")}
            onOpenMemories={() => openMemories()}
          />
        ) : chat.activeId ? (
          <>
              <header className={styles.topbar}>
                {!sidebarOpen && (
                  <button className={styles.iconButton} onClick={() => setSidebarOpen(true)} aria-label="展开侧栏" title="展开侧栏">
                    <PanelLeftOpen size={16} />
                  </button>
                )}
                <h1 className={styles.title}>
                  {contextSubjectId && contextSubjectName && (
                    <>
                      <button className={styles.crumb} onClick={() => openSpace(contextSubjectId)} title="打开学习空间">
                        <Folder size={13} aria-hidden />
                        {contextSubjectName}
                      </button>
                      <ChevronRight size={13} className={styles.crumbSep} aria-hidden />
                    </>
                  )}
                  <span className={styles.titleText}>{title}</span>
                </h1>
                <div className={styles.topbarActions}>
                  <button
                    className={cx(styles.iconButton, memoryOpen && styles.iconButtonOn)}
                    onClick={() => (memoryOpen ? setMemoryOpen(false) : openMemories())}
                    aria-expanded={memoryOpen}
                    aria-label="学习记忆"
                    title="学习记忆"
                  >
                    <Brain size={16} aria-hidden />
                  </button>
                </div>
              </header>
            {thread && (thread.messages.length > 0 || !thread.loading) ? (
              thread.error && thread.messages.length === 0 ? (
                <div className={styles.center}>
                  <p className={styles.loadError}>{thread.error.message}</p>
                  <button className={styles.textButton} onClick={() => void chat.loadConversation(chat.activeId!)}>
                    <RotateCcw size={13} aria-hidden />
                    重新加载
                  </button>
                </div>
              ) : thread.messages.length === 0 ? (
                <div className={styles.center}>
                  <p className={styles.muted}>这个对话还没有消息，在下面输入第一句吧。</p>
                </div>
              ) : (
                <MessageList
                  conversationId={chat.activeId}
                  messages={thread.messages}
                  problems={problemsById}
                  memoriesById={memoriesById}
                  conversationSubjectId={chat.activeConversation?.subjectId ?? null}
                  subjectNames={subjectNames}
                  phase={phase}
                  followNonce={chat.followNonceFor(chat.activeId)}
                  onRegenerate={() => void chat.regenerate(chat.activeId!)}
                  onStartExercise={(problemId) => void chat.startExercise(problemId)}
                  onOpenMemories={openMemories}
                  onDecideTool={(approvalId, allow) => void chat.decideTool(approvalId, allow)}
                />
              )
            ) : (
              <div className={styles.center}>
                <p className={styles.muted}>正在读取对话…</p>
              </div>
            )}

            <div className={styles.dock}>
              {failureBar}
                  <Composer
                    conversationId={chat.activeId}
                    messages={thread?.messages}
                    value={chat.draft}
                    onChange={chat.setDraft}
                    onSend={() => void chat.sendMessage()}
                    onStop={() => chat.activeId && void chat.stop(chat.activeId)}
                    phase={phase}
                    busy={chat.creating}
                    problems={chat.problems}
                    onStartExercise={(problemId) => void chat.startExercise(problemId)}
                    autoFocusKey={chat.activeId}
                  />
                  <p className={styles.disclaimer}>回答由模型生成，可能出错，重要内容请自行核实。</p>
            </div>
          </>
        ) : (
          <div className={styles.home}>
            {!sidebarOpen && (
              <button className={cx(styles.iconButton, styles.floatingToggle)} onClick={() => setSidebarOpen(true)} aria-label="展开侧栏" title="展开侧栏">
                <PanelLeftOpen size={16} />
              </button>
            )}
            <div className={styles.homeTopRight}>
              <button
                type="button"
                className={cx(styles.iconButton, memoryOpen && styles.iconButtonOn)}
                onClick={() => (memoryOpen ? setMemoryOpen(false) : openMemories())}
                aria-label="学习记忆"
                title="学习记忆"
              >
                <Brain size={15} aria-hidden />
              </button>
            </div>

            <div className={styles.homeInner}>
              <div className={styles.heroHead}>
                <div className={styles.brandLine}>
                  <Image src="/brand/knowgap-logo-v1.png" alt="" width={20} height={20} className={styles.greetingLogo} />
                  <span>KnowGap AI</span>
                </div>
                <h2 className={styles.greeting}>
                  <span>{greeting(user.displayName)}。</span>
                </h2>
              </div>

              {failureBar}
              <Composer
                hero
                value={chat.draft}
                onChange={chat.setDraft}
                onSend={async () => {
                  const spaceId = chat.draftSubjectId;
                  const ok = await chat.sendMessage();
                  if (ok && spaceId) setView({ type: "subject", id: spaceId });
                }}
                onStop={() => undefined}
                phase={null}
                busy={chat.creating}
                problems={chat.problems}
                onStartExercise={async (problemId) => {
                  const spaceId = chat.draftSubjectId;
                  const ok = await chat.startExercise(problemId);
                  if (ok && spaceId) setView({ type: "subject", id: spaceId });
                }}
                autoFocusKey="new"
                placeholder={contextSubjectName ? `在「${contextSubjectName}」里提问、演练或启动任务` : "提问、创建学习空间或启动自测任务"}
              />

              {/* LobeHub 风格：输入框正下方的细长水平快捷条 */}
              <div className={styles.lobeStrip}>
                <div className={styles.stripLeft}>
                  <span className={styles.stripLabel}>快捷</span>
                  {STARTERS.map(({ icon: Icon, label, color, text }) => (
                    <button
                      key={label}
                      type="button"
                      className={styles.stripItem}
                      onClick={() => {
                        chat.setDraft(text);
                        document.getElementById(COMPOSER_ID)?.focus();
                      }}
                    >
                      <span className={styles.stripIconBadge} style={{ background: color }} aria-hidden>
                        <Icon size={10} />
                      </span>
                      <span>{label}</span>
                    </button>
                  ))}
                </div>
                <div className={styles.stripRight}>
                  <SubjectPicker
                    subjects={chat.subjects}
                    value={chat.draftSubjectId}
                    onChange={(subjectId) => chat.newChat(subjectId)}
                    onCreate={() => setSpaceDialog({ select: true })}
                  />
                  {modelConfigured === false && (
                    <button className={cx(styles.cockpitHeadBtn, styles.modelMissing)} onClick={() => openSettings("models")}>
                      <CircleAlert size={12} aria-hidden />
                      <span>未配置模型</span>
                    </button>
                  )}
                </div>
              </div>

              {/* 间隔重温微追问提醒（P1-5 Spaced Micro-Review） */}
              {reviewTarget && !chat.draft && (
                <div className={styles.spacedReviewBanner}>
                  <div className={styles.spacedReviewBody}>
                    <span className={styles.spacedReviewTag}>待巩固闪回</span>
                    <span className={styles.spacedReviewText}>
                      <strong>{reviewTarget.topic}</strong>：{reviewTarget.summary}
                    </span>
                  </div>
                  <button
                    type="button"
                    className={styles.spacedReviewBtn}
                    onClick={() => {
                      chat.setDraft(
                        `针对我之前在「${reviewTarget.topic}」上的易错点（${reviewTarget.summary}），请出 1 道简短的随堂微测题检验我是否已经想通。`,
                      );
                      document.getElementById(COMPOSER_ID)?.focus();
                    }}
                  >
                    1 分钟靶向自测 →
                  </button>
                </div>
              )}

              {/* LobeHub 风格：最近话题双行列表 */}
              {!chat.draftSubjectId && recentTopics.length > 0 && (
                <section className={styles.resume} aria-labelledby="recent-topics-title">
                  <div className={styles.resumeHead}>
                    <h3 id="recent-topics-title" className={styles.resumeTitle}>
                      <span>最近话题</span>
                      <span className={styles.resumeCountBadge}>{recentTopics.length}</span>
                    </h3>
                  </div>
                  <ul className={styles.resumeList} data-stagger>
                    {recentTopics.map((item) => (
                      <li key={item.id}>
                        <button className={styles.lobeRow} onClick={() => showConversation(item.id)}>
                          <span className={styles.lobeRowIcon} aria-hidden>
                            <Image src="/brand/knowgap-logo-v1.png" alt="" width={16} height={16} />
                          </span>
                          <div className={styles.lobeRowBody}>
                            <div className={styles.lobeRowTop}>
                              <span className={styles.lobeRowTitle}>{item.title}</span>
                              <span className={styles.lobeRowDate}>{formatZhDate(item.updatedAt)}</span>
                            </div>
                            {item.preview && <p className={styles.lobeRowPreview}>{item.preview}</p>}
                          </div>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {/* LobeHub 风格：继续学习空间双行列表 */}
              {!chat.draftSubjectId && recentSpaces.length > 0 && (
                <section className={styles.resume} aria-labelledby="resume-title">
                  <div className={styles.resumeHead}>
                    <h3 id="resume-title" className={styles.resumeTitle}>
                      <span>学习空间</span>
                      <span className={styles.resumeCountBadge}>{chat.subjects.length}</span>
                    </h3>
                    <button type="button" className={styles.cockpitHeadBtn} onClick={() => setView({ type: "spaces" })}>
                      <span>查看全部 →</span>
                    </button>
                  </div>
                  <ul className={styles.resumeList} data-stagger>
                    {recentSpaces.map((subject) => (
                      <li key={subject.id}>
                        <button className={styles.lobeRow} onClick={() => openSpace(subject.id)}>
                          <span
                            className={styles.lobeRowIcon}
                            style={{ background: `color-mix(in srgb, ${subject.color} 16%, transparent)`, color: subject.color }}
                            aria-hidden
                          >
                            <FolderKanban size={13} />
                          </span>
                          <div className={styles.lobeRowBody}>
                            <div className={styles.lobeRowTop}>
                              <span className={styles.lobeRowTitle}>{subject.name}</span>
                              <span className={styles.lobeRowDate}>{studiedLabel(subject.progress.lastStudiedAt)}</span>
                            </div>
                            <p className={styles.lobeRowPreview}>
                              {subject.goal || `${subject.progress.openThreads} 个进行中 Thread · ${subject.progress.toReview} 个待巩固认知`}
                            </p>
                          </div>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </div>
          </div>
        )}
      </main>

      {memoryOpen && (
        <>
          {narrow && <button className={cx(styles.backdrop, styles.backdropOpen)} aria-label="关闭学习记忆" onClick={() => setMemoryOpen(false)} />}
          <aside className={styles.drawer}>
            <MemoryDrawer
              memories={chat.memories}
              subjects={chat.subjects}
              contextSubjectId={contextSubjectId}
              loading={chat.memoriesLoading}
              error={chat.memoriesError}
              focusIds={memoryFocus}
              conversationTitles={conversationTitles}
              onClose={() => setMemoryOpen(false)}
              onRefresh={() => void chat.loadMemories()}
              onUpdate={chat.updateMemory}
              onDelete={chat.deleteMemory}
              onOpenConversation={(id) => { showConversation(id); if (narrow) setMemoryOpen(false); }}
              onStartOnboarding={async () => {
                try {
                  const conv = await chatApi.startOnboarding();
                  setOnboardingConvId(conv.id);
                  setOnboardingMode(true);
                  setMemoryOpen(false);
                  setView({ type: "chat" });
                  openConversation(conv.id);
                  setSidebarOpen(false);
                } catch {
                  push({ tone: "error", title: "无法继续完善画像，请重试" });
                }
              }}
            />
          </aside>
        </>
      )}

      {settingsOpen && (
        <SettingsDialog
          source={DATA_SOURCE}
          health={health}
          studentId={user.id}
          user={user}
          initialTab={settingsTab}
          modelSignal={modelSignal}
          onCheckHealth={() => void checkHealth()}
          onConfigChange={handleConfigChange}
          onLogout={onLogout}
          onRename={onRename}
          onRestartOnboarding={async () => {
            const conv = await chatApi.restartOnboarding();
            setOnboardingConvId(conv.id);
            setOnboardingMode(true);
            setSettingsOpen(false);
            setView({ type: "chat" });
            openConversation(conv.id);
            setSidebarOpen(false);
            void chat.refreshList();
          }}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {spaceDialog && (
        <CreateSpaceDialog
          subject={spaceDialog.editId ? chat.subjects.find((item) => item.id === spaceDialog.editId) ?? null : null}
          onClose={() => setSpaceDialog(null)}
          onCreate={async (input: SpaceInput & { name: string }, files: File[]) => {
            const subject = await chat.createSubject(input);
            if (!subject) return false;
            if (files.length) {
              const client = createMaterialClient();
              for (const file of files) {
                try {
                  await client.upload(file, subject.id);
                } catch {
                  push({ tone: "error", title: `${file.name} 没有传上` });
                }
              }
              void chat.loadSubjects();
            }
            if (spaceDialog.select) chat.newChat(subject.id);
            else setView({ type: "subject", id: subject.id });
            return true;
          }}
          onUpdate={(id, input) => chat.updateSubject(id, input)}
        />
      )}
      <Toaster toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}

export function ChatApp() {
  const auth = useAuth();
  if (DATA_SOURCE === "api" && auth.status !== "ready") {
    if (auth.status === "loading") {
      return <div className={authStyles.canvas}><p className={authStyles.loading}>正在确认登录状态</p></div>;
    }
    return (
      <AuthView
        error={auth.error}
        onLogin={auth.login}
        onRegister={auth.register}
        onDemo={auth.enterDemo}
      />
    );
  }
  if (!auth.user) return null;
  return <AuthenticatedChat key={auth.user.id} user={auth.user} onLogout={() => void auth.logout()} onRename={auth.rename} />;
}

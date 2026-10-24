"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import {
  ArrowLeftRight, Brain, ChevronRight, CircleAlert, Dumbbell, FileText, Folder,
  Mic, PanelLeftOpen, RotateCcw, X,
} from "lucide-react";
import { useChat } from "@/hooks/useChat";
import type { HealthState } from "@/hooks/useWorkbench";
import { getAIConfig, testAIConfig, type AIConfigStatus } from "@/lib/api/ai-config";
import { API_BASE_URL, DATA_SOURCE } from "@/lib/config";
import { cx } from "@/lib/cx";
import type { Problem } from "@/lib/types";
import { createMaterialClient } from "@/lib/api/material-client";
import { chatApi } from "@/lib/chat/api";
import type { SpaceInput } from "@/lib/chat/types";
import type { AuthUser } from "@/lib/api/auth";
import { applyAppearance, readAppearance } from "@/lib/appearance";
import { AuthView } from "../auth/AuthView";
import authStyles from "../auth/AuthView.module.css";
import { useAuth } from "../auth/useAuth";
import { MaterialLibrary } from "../MaterialLibrary";
import type { ModelSignal } from "../settings/ModelAccessCard";
import { DesktopBridge } from "../desktop/DesktopBridge";
import { SettingsDialog, type SettingsTab } from "../settings/SettingsDialog";
import { Toaster, useToasts } from "../ui/Toaster";
import { COMPOSER_ID, Composer } from "./Composer";
import { OPEN_SETTINGS_EVENT } from "./ModelPicker";
import { ConversationSidebar } from "./ConversationSidebar";
import { MemoryDrawer } from "./MemoryDrawer";
import { MessageList } from "./MessageList";
import { CreateSpaceDialog } from "./CreateSpaceDialog";
import { CoachmarkHost } from "../onboarding/Coachmark";
import { GettingStarted } from "../onboarding/GettingStarted";
import { HelpCenter, type HelpAction } from "../onboarding/HelpCenter";
import { ModelGate, Welcome } from "../onboarding/Welcome";
import { CHEATSHEET_OPENED_EVENT, OPEN_SPACE_PANEL_EVENT, cheatsheetSeenKey } from "../onboarding/coach";
import { SpacesPage } from "./SpacesPage";
import { AgendaPage } from "../agenda/AgendaPage";
import { ReminderScheduler } from "../agenda/ReminderScheduler";
import { TaskComposer } from "../agenda/TaskComposer";
import { OPEN_AGENDA_EVENT } from "./AgendaToolCard";
import { SubjectPage } from "./SubjectPage";
import { SubjectPicker } from "./SubjectPicker";
import { TodayPanel } from "../home/TodayPanel";
import todayStyles from "../home/TodayPanel.module.css";
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

function modelNotReady(message?: string | null) {
  return Boolean(message && message.includes("模型未配置"));
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
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [memoryFocus, setMemoryFocus] = useState<string[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("general");
  const openSettings = useCallback((tab: SettingsTab = "general") => {
    setSettingsTab(tab);
    setSettingsOpen(true);
  }, []);
  useEffect(() => {
    const onOpen = (event: Event) => {
      const tab = (event as CustomEvent<{ tab?: SettingsTab }>).detail?.tab;
      openSettings(tab ?? "models");
    };
    window.addEventListener(OPEN_SETTINGS_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_SETTINGS_EVENT, onOpen);
  }, [openSettings]);
  const [view, setViewState] = useState<View>({ type: "chat" });
  const [spaceDialog, setSpaceDialog] = useState<null | { editId?: string; select: boolean }>(null);
  const [viewRestored, setViewRestored] = useState(false);
  const [health, setHealth] = useState<HealthState>("checking");
  const [modelConfigured, setModelConfigured] = useState<boolean | null>(null);
  const [modelError, setModelError] = useState("");
  const [modelChecking, setModelChecking] = useState(true);
  const needsModelTest = useRef(false);
  const [gate, setGate] = useState<"checking" | "welcome" | "app">("checking");
  const [helpOpen, setHelpOpen] = useState(false);
  const [welcomeBusy, setWelcomeBusy] = useState(false);
  const [welcomeError, setWelcomeError] = useState("");
  const [hiddenModelFail, setHiddenModelFail] = useState<string | null>(null);

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

  const checkModel = useCallback(async (fromSave = false) => {
    setModelChecking(true);
    setModelError("");
    try {
      const config = await getAIConfig();
      if (!config.configured) {
        needsModelTest.current = true;
        setModelConfigured(false);
        if (fromSave) setModelError("默认模型还不可用。请确认服务商已启用，并且密钥或 ChatGPT 套餐已授权。");
        return;
      }
      if (needsModelTest.current) {
        await testAIConfig({ baseUrl: config.baseUrl, model: config.model, apiKey: "" });
        needsModelTest.current = false;
        setSettingsOpen(false);
      }
      setModelConfigured(true);
    } catch (error: unknown) {
      setModelError(error instanceof Error && error.message ? error.message : "无法确认模型连接，请检查后端是否启动、模型配置是否可用，然后重试。");
    } finally {
      setModelChecking(false);
    }
  }, []);

  useEffect(() => {
    void checkHealth();
    void checkModel();
  }, [checkHealth, checkModel]);

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

  useEffect(() => {
    const mark = () => localStorage.setItem(cheatsheetSeenKey(user.id), "1");
    window.addEventListener(CHEATSHEET_OPENED_EVENT, mark);
    return () => window.removeEventListener(CHEATSHEET_OPENED_EVENT, mark);
  }, [user.id]);

  const checkOnboarding = useCallback(async () => {
    setWelcomeError("");
    try {
      const status = await chatApi.onboardingStatus();
      setGate(status.status === "not_started" ? "welcome" : "app");
    } catch {
      setWelcomeError("无法读取学习进度，请检查后端是否启动，然后重试。");
    }
  }, [user.id]);

  useEffect(() => {
    if (DATA_SOURCE === "api") void checkOnboarding();
  }, [checkOnboarding]);

  const enterSpace = useCallback(async (subjectId: string, conversationId: string, opener?: string) => {
    await chat.loadSubjects();
    setView({ type: "subject", id: subjectId });
    setGate("app");
    if (!narrow) setSidebarOpen(true);
    await chat.openConversation(conversationId);
    if (opener) await chat.sendTo(conversationId, opener);
  }, [chat, narrow, setView]);

  const answerWelcome = useCallback(async (text: string) => {
    if (welcomeBusy) return;
    setWelcomeBusy(true);
    setWelcomeError("");
    try {
      const result = await chatApi.welcome(text);
      await enterSpace(result.subjectId, result.conversationId, result.opener);
    } catch (error) {
      setWelcomeError(error instanceof Error ? error.message : "没能建好空间，请重试。");
    } finally {
      setWelcomeBusy(false);
    }
  }, [enterSpace, welcomeBusy]);

  const browseDemo = useCallback(async () => {
    if (welcomeBusy) return;
    setWelcomeBusy(true);
    setWelcomeError("");
    try {
      const seeded = await chatApi.seedDemo();
      await chatApi.ackOnboarding();
      await enterSpace(seeded.subjectId, seeded.conversationId);
    } catch (error) {
      setWelcomeError(error instanceof Error ? error.message : "演示空间没能打开，请重试。");
    } finally {
      setWelcomeBusy(false);
    }
  }, [enterSpace, welcomeBusy]);

  const skipWelcome = useCallback(async () => {
    if (welcomeBusy) return;
    setWelcomeBusy(true);
    setWelcomeError("");
    try {
      await chatApi.skipOnboarding();
      setGate("app");
      if (!narrow) setSidebarOpen(true);
    } catch (error) {
      setWelcomeError(error instanceof Error ? error.message : "跳过失败，请重试。");
    } finally {
      setWelcomeBusy(false);
    }
  }, [narrow, welcomeBusy]);

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
      if (modelConfigured !== true || gate !== "app" || settingsOpen || event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return;
      if (event.key === "/") {
        event.preventDefault();
        document.getElementById(COMPOSER_ID)?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [narrow, settingsOpen, modelConfigured, gate]);

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

  const handleConfigChange = useCallback((config: AIConfigStatus, saved: boolean) => {
    if (!config.configured) {
      needsModelTest.current = true;
      setModelConfigured(false);
    } else if (saved) {
      void checkModel(true);
    }
  }, [checkModel]);

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
  // 首页开始输入后只留问候和输入框
  const composing = chat.draft.length > 0;
  const title = chat.activeConversation?.title ?? (chat.activeId ? "加载中…" : "新对话");
  const thread = chat.activeThread;
  const spaceMainId = pageSubject?.mainConversationId ?? null;
  const spaceMessages = spaceMainId ? chat.messagesFor(spaceMainId)?.messages ?? [] : [];
  const failure = chat.sendFailure && chat.sendFailure.conversationId === chat.activeId ? chat.sendFailure : null;
  const blankFailure = chat.sendFailure && !chat.activeId ? chat.sendFailure : null;
  const spaceFailure = spaceMainId && chat.sendFailure?.conversationId === spaceMainId ? chat.sendFailure : null;
  const shownFailure = failure ?? blankFailure ?? spaceFailure;
  const watched = view.type === "subject" ? spaceMessages : messages;
  const latestAssistant = [...watched].reverse().find((message) => message.role === "assistant");
  const failedReply = latestAssistant?.status === "failed" && modelNotReady(latestAssistant.error)
    && hiddenModelFail !== latestAssistant.id ? latestAssistant : null;
  const replyGap = !shownFailure ? failedReply : null;
  const failureMessage = shownFailure?.error.message ?? replyGap?.error ?? "";
  const offerSettings = modelNotReady(failureMessage);
  const modelBanner = modelConfigured === false ? (
    <div className={styles.modelBanner} role="status">
      <span>还没连上 AI 模型，回复会失败</span>
      <button type="button" onClick={() => openSettings("models")}>去设置</button>
    </div>
  ) : null;
  const failureBar = (shownFailure || replyGap) && (
    <div className={styles.sendFailure} role="alert">
      <CircleAlert size={14} aria-hidden />
      <span className={styles.sendFailureText}>
        发送失败：{failureMessage}
        {shownFailure && shownFailure.error.kind !== "conflict" && "（输入还在）"}
      </span>
      {offerSettings && (
        <button type="button" onClick={() => openSettings("models")}>去设置</button>
      )}
      {shownFailure?.error.kind === "conflict" && chat.activeId ? (
        <button onClick={() => { chat.dismissSendFailure(); void chat.loadConversation(chat.activeId!); }}>刷新对话</button>
      ) : (
        <button onClick={() => {
          if (replyGap) void chat.regenerate(replyGap.conversationId);
          else void chat.sendMessage();
        }}>重试</button>
      )}
      <button
        className={styles.dismiss}
        onClick={() => {
          if (replyGap) setHiddenModelFail(replyGap.id);
          chat.dismissSendFailure();
        }}
        aria-label="关闭提示"
      >
        <X size={13} />
      </button>
    </div>
  );

  const modelBlocked = modelConfigured !== true || modelChecking || Boolean(modelError);
  const appBlocked = modelBlocked || gate !== "app";

  return (
    <div className={cx(styles.app, (appBlocked || !sidebarOpen) && styles.sidebarClosed, narrow && styles.narrow)} data-coachmark="spotlight">
      <CoachmarkHost userId={user.id} enabled={!appBlocked} />
      <ReminderScheduler userId={user.id} subjects={chat.subjects} />
      <DesktopBridge />
      {narrow && (
        <button
          className={cx(styles.backdrop, sidebarOpen && styles.backdropOpen)}
          aria-label="关闭侧栏"
          tabIndex={sidebarOpen ? 0 : -1}
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <aside className={styles.sidebar} aria-hidden={appBlocked || !sidebarOpen || undefined} inert={appBlocked || !sidebarOpen || undefined}>
        <div className={styles.sidebarInner}>
          <ConversationSidebar
            conversations={chat.conversations}
            loading={chat.listLoading}
            error={chat.listError}
            subjects={chat.subjects}
            activeId={view.type === "chat" ? chat.activeId : null}
            activeSubjectId={view.type === "subject" ? view.id : null}
            generatingIds={generatingIds}
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
            onRename={chat.renameConversation}
            onDelete={chat.deleteConversation}
            onRetry={() => void chat.refreshList()}
            onOpenMemory={() => { openMemories(); closeOverlays(); }}
            onOpenMaterials={() => { setView({ type: "materials" }); closeOverlays(); }}
            onOpenSettings={() => { openSettings(modelConfigured === false ? "models" : "general"); closeOverlays(); }}
            onOpenHelp={() => setHelpOpen((open) => !open)}
            helpOpen={helpOpen}
            onCollapse={() => setSidebarOpen(false)}
            displayName={user.displayName}
            avatarText={user.avatarText}
          />
        </div>
      </aside>

      <main className={styles.main}>
        {modelBlocked || gate === "checking" ? (
          <ModelGate
            busy={modelChecking || (gate === "checking" && !welcomeError)}
            error={modelError || (gate === "checking" ? welcomeError : "")}
            configured={modelConfigured}
            onConfigure={() => openSettings("models")}
            onRetry={() => { void checkModel(); void checkOnboarding(); }}
            onLogout={onLogout}
          />
        ) : gate !== "app" ? (
          <Welcome
            busy={welcomeBusy}
            error={welcomeError}
            onAnswer={(text) => void answerWelcome(text)}
            onDemo={() => void browseDemo()}
            onSkip={() => void skipWelcome()}
          />
        ) : materialsOpen ? (
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
              // 学习空间页挂载时会恢复上次打开的面板，预先写入即可直接打开这个支线
              try {
                localStorage.setItem(`knowgap.space.panel.v1:${API_BASE_URL}:${subjectId}`,
                  JSON.stringify({ mode: "thread", id: threadId }));
              } catch { /* 存储不可用时只打开空间 */ }
              openSpace(subjectId);
            }}
            onOpenSpace={(subjectId) => openSpace(subjectId)}
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
            <>
            {(modelBanner || failureBar) && <div className={styles.spaceAlert}>{modelBanner}{failureBar}</div>}
            <SubjectPage
              subject={pageSubject}
              chat={chat}
              narrow={narrow}
              sidebarOpen={sidebarOpen}
              memoriesById={memoriesById}
              problemsById={problemsById}
              subjectNames={subjectNames}
              userId={user.id}
              onOpenSidebar={() => setSidebarOpen(true)}
              onEdit={() => setSpaceDialog({ editId: pageSubject.id, select: false })}
              onDelete={async () => {
                const ok = await chat.deleteSubject(pageSubject.id);
                if (ok) setView({ type: "spaces" });
                return ok;
              }}
            />
            </>
          ) : (
            <div className={styles.center}>
              <p className={styles.muted}>{subjectMissing ? "这个学习空间已不存在。" : "正在读取学习空间…"}</p>
            </div>
          )
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
                  onSendText={(text) => void chat.sendTo(chat.activeId!, text)}
                  onOpenWeakPoints={chat.activeConversation?.subjectId ? () => {
                    const subjectId = chat.activeConversation?.subjectId;
                    if (!subjectId) return;
                    try {
                      localStorage.setItem(`knowgap.space.panel.v1:${API_BASE_URL}:${subjectId}`, JSON.stringify({ mode: "graph" }));
                    } catch { /* 面板打不开时仍进入空间 */ }
                    openSpace(subjectId);
                  } : undefined}
                />
              )
            ) : (
              <div className={styles.center}>
                <p className={styles.muted}>正在读取对话…</p>
              </div>
            )}

            <div className={styles.dock}>
              {modelBanner}
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
                    modelKey={chat.modelKeyFor(chat.activeId)}
                    onModelKeyChange={(key) => chat.setConversationModel(chat.activeId, key)}
                  />
                  <p className={styles.disclaimer}>回答由模型生成，可能出错，重要内容请自行核实。</p>
            </div>
          </>
        ) : (
          <div className={cx(styles.home, todayStyles.homeViewport)}>
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

            <div className={cx(styles.homeInner, todayStyles.homeContent)}>
              <div className={styles.heroHead}>
                <div className={styles.brandLine}>
                  <Image src="/brand/knowgap-logo-v1.png" alt="" width={20} height={20} className={styles.greetingLogo} />
                  <span>KnowGap AI</span>
                </div>
                <h2 className={styles.greeting}>
                  <span>{greeting(user.displayName)}。</span>
                </h2>
              </div>

              {modelBanner}
              {failureBar}
              <Composer
                hero
                value={chat.draft}
                onChange={chat.setDraft}
                modelKey={chat.pendingModelKey}
                onModelKeyChange={(key) => chat.setConversationModel(null, key)}
                onSend={async () => {
                  const spaceId = chat.draftSubjectId;
                  const ok = await chat.sendMessage();
                  if (ok && spaceId) setView({ type: "subject", id: spaceId });
                }}
                onStop={() => undefined}
                phase={null}
                busy={chat.creating}
                problems={chat.problems}
                ensureConversation={chat.ensureUploadConversation}
                onFilesCleared={chat.discardDraftConversation}
                onStartExercise={async (problemId) => {
                  const spaceId = chat.draftSubjectId;
                  const ok = await chat.startExercise(problemId);
                  if (ok && spaceId) setView({ type: "subject", id: spaceId });
                }}
                autoFocusKey="new"
                placeholder={contextSubjectName ? `在「${contextSubjectName}」里提问、演练或启动任务` : "提问、创建学习空间或启动自测任务"}
              />

              {/* 开始输入后收起下方内容，问候与输入框随之回到视口中央 */}
              <div className={cx(styles.homeBelow, composing && styles.homeBelowHidden)} inert={composing} aria-hidden={composing || undefined}>
              <div className={styles.homeBelowInner}>
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
                </div>
              </div>

              <GettingStarted
                userId={user.id}
                hasSpace={chat.subjects.length > 0}
                onCreateSpace={() => setSpaceDialog({ select: false })}
                onExplain={() => {
                  const space = recentSpaces[0];
                  if (space?.mainConversationId) {
                    setView({ type: "subject", id: space.id });
                    void chat.sendTo(space.mainConversationId, "用一个具体例子讲清一个核心概念");
                    return;
                  }
                  setView({ type: "chat" });
                  chat.setDraft("用一个具体例子讲清一个核心概念");
                  document.getElementById(COMPOSER_ID)?.focus();
                }}
                onQuiz={() => {
                  const space = recentSpaces[0];
                  if (space?.mainConversationId) {
                    setView({ type: "subject", id: space.id });
                    void chat.sendTo(space.mainConversationId, "考考我");
                    return;
                  }
                  chat.setDraft("考考我");
                  document.getElementById(COMPOSER_ID)?.focus();
                }}
                onSchedule={() => setView({ type: "agenda" })}
                onSheet={() => {
                  const space = recentSpaces[0];
                  if (!space) {
                    setSpaceDialog({ select: false });
                    return;
                  }
                  setView({ type: "subject", id: space.id });
                  window.setTimeout(() => {
                    window.dispatchEvent(new CustomEvent(OPEN_SPACE_PANEL_EVENT, {
                      detail: { mode: "cheatsheet", subjectId: space.id },
                    }));
                  }, 60);
                }}
              />
              <TodayPanel
                conversations={chat.conversations}
                recentTopics={recentTopics}
                recentSpaces={recentSpaces}
                reviewTarget={reviewTarget}
                showReview={!chat.draft}
                onReview={() => {
                  if (!reviewTarget) return;
                  chat.setDraft(
                    `针对我之前在「${reviewTarget.topic}」上的易错点（${reviewTarget.summary}），请出 1 道简短的随堂微测题检验我是否已经想通。`,
                  );
                  document.getElementById(COMPOSER_ID)?.focus();
                }}
                onPlanReview={() => {
                  chat.setDraft("让 AI 帮我排这周的复习");
                  document.getElementById(COMPOSER_ID)?.focus();
                }}
                onOpenConversation={showConversation}
                onOpenSpace={openSpace}
                onOpenSpaces={() => setView({ type: "spaces" })}
              />
              </div>
              </div>
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
              onStartOnboarding={() => {
                setMemoryOpen(false);
                openSettings("preferences");
              }}
              onPractice={() => {
                setMemoryOpen(false);
                const space = recentSpaces[0];
                if (space?.mainConversationId) {
                  setView({ type: "subject", id: space.id });
                  void chat.sendTo(space.mainConversationId, "用一个具体例子讲清一个核心概念");
                  return;
                }
                chat.setDraft("用一个具体例子讲清一个核心概念");
                document.getElementById(COMPOSER_ID)?.focus();
              }}
            />
          </aside>
        </>
      )}

      {helpOpen && (
        <HelpCenter
          desktop={Boolean(window.knowgap)}
          userId={user.id}
          onClose={() => setHelpOpen(false)}
          onTry={(action: HelpAction) => {
            setHelpOpen(false);
            const space = recentSpaces[0];
            const openMain = (text: string) => {
              if (space?.mainConversationId) {
                setView({ type: "subject", id: space.id });
                chat.setDraftFor(space.mainConversationId, text);
                return;
              }
              setView({ type: "chat" });
              chat.setDraft(text);
              window.setTimeout(() => document.getElementById(COMPOSER_ID)?.focus(), 0);
            };
            if (action === "explain") openMain("用一个具体例子讲清一个核心概念");
            else if (action === "quiz" || action === "select") openMain(action === "quiz" ? "考考我" : "选中我回复里的一句话，再追问");
            else if (action === "viva") openMain("/viva ");
            else if (action === "plan") openMain("先列一个学习计划，再讲第一个概念");
            else if (action === "review" || action === "agenda" || action === "schedule") setView({ type: "agenda" });
            else if (action === "graph" || action === "sheet") {
              if (!space) { setView({ type: "spaces" }); return; }
              setView({ type: "subject", id: space.id });
              window.setTimeout(() => {
                window.dispatchEvent(new CustomEvent(OPEN_SPACE_PANEL_EVENT, {
                  detail: { mode: action === "graph" ? "graph" : "cheatsheet", subjectId: space.id },
                }));
              }, 60);
            } else if (action === "spotlight") {
              push({ tone: "info", title: "按 Alt+Space 随时快问" });
            }
          }}
        />
      )}

      {settingsOpen && (
        <SettingsDialog
          source={DATA_SOURCE}
          health={health}
          studentId={user.id}
          user={user}
          initialTab={settingsTab}
          modelSignal={modelSignal}
          modelError={modelError}
          onCheckHealth={() => void checkHealth()}
          onConfigChange={handleConfigChange}
          onLogout={onLogout}
          onRename={onRename}
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
      {!appBlocked && <TaskComposer subjects={chat.subjects} />}
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

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Image from "next/image";
import { Brain, ChevronRight, CircleAlert, Folder, PanelLeftOpen, RotateCcw, X } from "lucide-react";
import { useChat } from "@/hooks/useChat";
import type { HealthState } from "@/hooks/useWorkbench";
import { getAIConfig, type AIConfigStatus } from "@/lib/api/ai-config";
import { API_BASE_URL, DATA_SOURCE, DEMO_STUDENT_ID } from "@/lib/config";
import { cx } from "@/lib/cx";
import type { Problem } from "@/lib/types";
import { createMaterialClient } from "@/lib/api/material-client";
import type { SpaceInput } from "@/lib/chat/types";
import { MaterialLibrary } from "../MaterialLibrary";
import type { ModelSignal } from "../settings/ModelAccessCard";
import { SettingsDialog } from "../settings/SettingsDialog";
import { Toaster, useToasts } from "../ui/Toaster";
import { COMPOSER_ID, Composer } from "./Composer";
import { ConversationSidebar } from "./ConversationSidebar";
import { MemoryDrawer } from "./MemoryDrawer";
import { MessageList } from "./MessageList";
import { CreateSpaceDialog } from "./CreateSpaceDialog";
import { SpacesPage } from "./SpacesPage";
import { SubjectPage } from "./SubjectPage";
import { SubjectPicker } from "./SubjectPicker";
import styles from "./ChatApp.module.css";

const NARROW = "(max-width: 860px)";
const VIEW_KEY = `knowgap.chat.view.v1:${API_BASE_URL}`;

/** 主区域显示什么：对话、学习空间总览、某个学习空间，或通用资料 */
type View = { type: "chat" } | { type: "subject"; id: string } | { type: "materials" } | { type: "spaces" };

function readView(): View {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(VIEW_KEY) ?? "null");
    if (parsed && typeof parsed === "object" && "type" in parsed) {
      if (parsed.type === "subject" && "id" in parsed && typeof parsed.id === "string") return { type: "subject", id: parsed.id };
      if (parsed.type === "materials") return { type: "materials" };
      if (parsed.type === "spaces") return { type: "spaces" };
    }
  } catch { /* unavailable storage falls back to the chat view */ }
  return { type: "chat" };
}

function greeting(hour = new Date().getHours()): string {
  if (hour < 5) return "夜深了，还在学习";
  if (hour < 11) return "早上好";
  if (hour < 13) return "中午好";
  if (hour < 18) return "下午好";
  return "晚上好";
}

function isTyping(target: EventTarget | null) {
  return target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
}

export function ChatApp() {
  const { toasts, push, dismiss } = useToasts();
  const chat = useChat(push);
  const [narrow, setNarrow] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [memoryFocus, setMemoryFocus] = useState<string[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [view, setViewState] = useState<View>({ type: "chat" });
  const [spaceDialog, setSpaceDialog] = useState<null | { editId?: string; select: boolean }>(null);
  const [viewRestored, setViewRestored] = useState(false);
  const [health, setHealth] = useState<HealthState>("checking");
  const [modelConfigured, setModelConfigured] = useState<boolean | null>(null);
  const [modelName, setModelName] = useState("");

  // 窄窗口默认收起侧栏，打开后以浮层覆盖
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
        setModelName(config.model);
      })
      .catch(() => setModelConfigured(null));
  }, [checkHealth]);

  const closeOverlays = useCallback(() => {
    if (narrow) setSidebarOpen(false);
  }, [narrow]);

  const setView = useCallback((next: View) => {
    setViewState(next);
    try {
      localStorage.setItem(VIEW_KEY, JSON.stringify(next));
    } catch { /* per-viewer convenience only */ }
  }, []);

  const { openConversation } = chat;
  const openSpace = useCallback((id: string) => {
    setView({ type: "subject", id });
  }, [setView]);

  useEffect(() => {
    const saved = readView();
    if (saved.type !== "chat") setViewState(saved);
    setViewRestored(true);
  }, []);

  // The Subject shown was deleted (here or elsewhere): fall back to a blank chat.
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

  const messages = chat.activeThread?.messages ?? [];
  const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant" && message.kind === "text");
  // 设置里的模型卡片只比较「保存之后」的信号，所以用回复自身的时间
  const signalAt = lastAssistant ? Date.parse(lastAssistant.createdAt) : 0;
  const modelSignal: ModelSignal = lastAssistant?.status === "failed"
    ? { state: "unavailable", at: signalAt, detail: lastAssistant.error ?? undefined }
    : lastAssistant?.status === "complete" ? { state: "ok", at: signalAt } : { state: "unknown" };

  const handleConfigChange = useCallback((config: AIConfigStatus) => {
    setModelConfigured(config.configured);
    setModelName(config.model);
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
  /** 当前所处的 Subject：Subject 页、所属 Subject 的对话，或在 Subject 中新建的空白对话 */
  const contextSubjectId = view.type === "subject"
    ? view.id
    : chat.activeId ? chat.activeConversation?.subjectId ?? null : chat.draftSubjectId;
  const contextSubjectName = contextSubjectId ? subjectNames[contextSubjectId] ?? null : null;
  const title = chat.activeConversation?.title ?? (chat.activeId ? "加载中…" : "新对话");
  const thread = chat.activeThread;
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
    <div className={cx(styles.app, !sidebarOpen && styles.sidebarClosed, narrow && styles.narrow)}>
      {narrow && sidebarOpen && <button className={styles.backdrop} aria-label="关闭侧栏" onClick={() => setSidebarOpen(false)} />}
      <aside className={styles.sidebar} aria-hidden={!sidebarOpen || undefined} inert={!sidebarOpen || undefined}>
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
          onRename={chat.renameConversation}
          onDelete={chat.deleteConversation}
          onRetry={() => void chat.refreshList()}
          onOpenMemory={() => { openMemories(); closeOverlays(); }}
          onOpenMaterials={() => { setView({ type: "materials" }); closeOverlays(); }}
          onOpenSettings={() => { setSettingsOpen(true); closeOverlays(); }}
          onCollapse={() => setSidebarOpen(false)}
        />
      </aside>

      <main className={styles.main}>
        {materialsOpen ? (
          <MaterialLibrary enabled unassigned onBack={() => setView({ type: "chat" })} />
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
              <button
                className={cx(styles.iconButton, memoryOpen && styles.iconButtonOn)}
                onClick={() => (memoryOpen ? setMemoryOpen(false) : openMemories())}
                aria-expanded={memoryOpen}
                aria-label="学习记忆"
                title="学习记忆"
              >
                <Brain size={16} aria-hidden />
              </button>
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
            <div className={styles.homeInner}>
              <h2 className={styles.greeting}>
                <Image src="/brand/knowgap-logo-v1.png" alt="" width={30} height={30} className={styles.greetingLogo} />
                {greeting()}
              </h2>
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
                placeholder={contextSubjectName ? `在「${contextSubjectName}」里，想弄明白什么？` : "今天想弄明白什么？"}
              />
              <div className={styles.homeMeta}>
                <SubjectPicker
                  subjects={chat.subjects}
                  value={chat.draftSubjectId}
                  onChange={(subjectId) => chat.newChat(subjectId)}
                  onCreate={() => setSpaceDialog({ select: true })}
                />
                <button className={cx(styles.modelChip, modelConfigured === false && styles.modelMissing)} onClick={() => setSettingsOpen(true)}>
                  {modelConfigured === false ? (
                    <>
                      <CircleAlert size={13} aria-hidden />
                      未配置模型
                    </>
                  ) : (
                    modelName || "模型"
                  )}
                </button>
              </div>
            </div>
          </div>
        )}
      </main>

      {memoryOpen && (
        <>
          {narrow && <button className={styles.backdrop} aria-label="关闭学习记忆" onClick={() => setMemoryOpen(false)} />}
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
            />
          </aside>
        </>
      )}

      {settingsOpen && (
        <SettingsDialog
          source={DATA_SOURCE}
          health={health}
          studentId={DEMO_STUDENT_ID}
          modelSignal={modelSignal}
          onCheckHealth={() => void checkHealth()}
          onConfigChange={handleConfigChange}
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

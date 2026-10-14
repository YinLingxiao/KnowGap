"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, Menu } from "lucide-react";
import { useWorkbench } from "@/hooks/useWorkbench";
import { getAIConfig, type AIConfigStatus } from "@/lib/api/ai-config";
import { cx } from "@/lib/cx";
import { topicLabel } from "@/lib/labels";
import type { LearningMemory } from "@/lib/types";
import { AnswerForm } from "./AnswerForm";
import { ChatComposer } from "./ChatComposer";
import { ChatThread } from "./ChatThread";
import { DiagnosisPending } from "./DiagnosisNote";
import { ErrorNotice } from "./ErrorNotice";
import { LoopStepper, type LoopStep } from "./LoopStepper";
import { MemoryPanel } from "./MemoryPanel";
import { MockConsole } from "./MockConsole";
import { ProblemStatement } from "./ProblemStatement";
import type { ModelSignal } from "./settings/ModelAccessCard";
import { SettingsDialog } from "./settings/SettingsDialog";
import { Sidebar } from "./Sidebar";
import { topicIcon } from "./topicIcon";
import { UsedMemories } from "./UsedMemories";
import { WelcomeHero } from "./WelcomeHero";
import { Button } from "./ui/Button";
import { Toaster, useToasts } from "./ui/Toaster";
import styles from "./Workbench.module.css";

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

export function Workbench() {
  const { toasts, push, dismiss } = useToasts();
  const wb = useWorkbench(push);
  const contentRef = useRef<HTMLDivElement>(null);
  const sessionTopRef = useRef<HTMLDivElement>(null);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [modelSignal, setModelSignal] = useState<ModelSignal>({ state: "unknown" });
  const [modelConfigured, setModelConfigured] = useState<boolean | null>(null);

  const selectedProblem = wb.problems.data.find((problem) => problem.id === wb.selectedProblemId) ?? null;
  const session = wb.session;
  const busy = wb.submitting || wb.sending || wb.restoring;
  const canStartNew = Boolean(selectedProblem && (session || wb.submitError)) && !busy;

  const memoriesById = useMemo(
    () => Object.fromEntries(wb.memories.data.map((memory) => [memory.id, memory])) as Record<string, LearningMemory>,
    [wb.memories.data],
  );

  const memoryCountByTopic = useMemo(() => {
    const counts: Record<string, number> = {};
    wb.memories.data.forEach((memory) => {
      counts[memory.topicKey] = (counts[memory.topicKey] ?? 0) + 1;
    });
    return counts;
  }, [wb.memories.data]);

  const draft = selectedProblem ? wb.drafts[selectedProblem.id] ?? { answer: "", reasoning: "" } : null;
  const awaitingSession = Boolean(selectedProblem && wb.pendingSessionProblemId === selectedProblem.id);
  const nextProblem = useMemo(() => {
    const index = wb.problems.data.findIndex((problem) => problem.id === wb.selectedProblemId);
    if (index < 0 || index >= wb.problems.data.length - 1) return null;
    return wb.problems.data[index + 1];
  }, [wb.problems.data, wb.selectedProblemId]);

  const steps: LoopStep[] = [
    { key: "answer", label: "作答", status: session || wb.submitting ? "done" : "active" },
    { key: "note", label: "批注", status: session ? "done" : wb.submitting ? "active" : "todo" },
    { key: "ask", label: "追问", status: session ? "active" : "todo" },
  ];

  // 诊断完成后，把视线带到「参考记忆 + 作答批注」
  const sessionId = session?.id;
  useEffect(() => {
    if (sessionId) sessionTopRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [sessionId]);

  useEffect(() => {
    if (wb.focusRequest) setMemoryOpen(true);
  }, [wb.focusRequest]);

  // 后端没有模型状态接口：从诊断请求的结果推断模型是否可用，供设置里的模型接入卡片展示
  const modelError = [wb.submitError, wb.chatError].find((error) => error?.kind === "model_unavailable") ?? null;
  useEffect(() => {
    if (modelError) setModelSignal({ state: "unavailable", at: Date.now(), detail: modelError.message });
  }, [modelError]);

  // API 模式下启动时读取一次模型配置，未配置时侧栏直接提示
  useEffect(() => {
    if (wb.source !== "api") return;
    getAIConfig()
      .then((config) => setModelConfigured(config.configured))
      .catch(() => setModelConfigured(null));
  }, [wb.source]);

  const handleConfigChange = useCallback((config: AIConfigStatus, saved: boolean) => {
    setModelConfigured(config.configured);
    // 保存后此前的模型错误已过期
    if (saved) setModelSignal({ state: "unknown" });
  }, []);

  const wasWaiting = useRef(false);
  const waiting = wb.submitting || wb.sending;
  const requestFailed = Boolean(wb.submitError || wb.chatError);
  const hasSession = Boolean(session);
  useEffect(() => {
    if (wasWaiting.current && !waiting && !requestFailed && hasSession) setModelSignal({ state: "ok", at: Date.now() });
    wasWaiting.current = waiting;
  }, [waiting, requestFailed, hasSession]);

  useEffect(() => {
    if (!catalogOpen && !memoryOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setCatalogOpen(false);
      setMemoryOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [catalogOpen, memoryOpen]);

  useEffect(() => {
    if (!wb.selectedProblemId) return;
    contentRef.current?.scrollTo({ top: 0 });
  }, [wb.selectedProblemId]);

  // 键盘快捷键：N 新会话，/ 聚焦输入框，逗号打开设置
  const startNewSession = wb.startNewSession;
  useEffect(() => {
    if (settingsOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return;
      if (event.key === ",") {
        event.preventDefault();
        setSettingsOpen(true);
      } else if (event.key === "n" || event.key === "N") {
        if (!canStartNew) return;
        event.preventDefault();
        startNewSession();
      } else if (event.key === "/") {
        const input = document.getElementById("chat-input") ?? document.getElementById("answer-input");
        if (!input) return;
        event.preventDefault();
        input.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [canStartNew, startNewSession, settingsOpen]);

  const openSettings = () => {
    setCatalogOpen(false);
    setSettingsOpen(true);
  };

  const CrumbIcon = selectedProblem ? topicIcon(selectedProblem.topicKey) : null;

  const showAnswerForm = Boolean(selectedProblem && draft && !session && !awaitingSession && !wb.restoreError);

  return (
    <div className={styles.app}>
      {(catalogOpen || memoryOpen) && (
        <button
          className={styles.backdrop}
          aria-label="关闭面板"
          onClick={() => {
            setCatalogOpen(false);
            setMemoryOpen(false);
          }}
        />
      )}
      <aside className={cx(styles.sidebar, catalogOpen && styles.sidebarOpen)}>
        <Sidebar
          source={wb.source}
          health={wb.health}
          studentId={wb.studentId}
          problems={wb.problems}
          selectedId={wb.selectedProblemId}
          memoryCountByTopic={memoryCountByTopic}
          onSelect={(problemId) => {
            wb.selectProblem(problemId);
            setCatalogOpen(false);
          }}
          onRetry={wb.loadProblems}
          disabled={busy}
          canStartNew={canStartNew}
          onNewSession={wb.startNewSession}
          onOpenSettings={openSettings}
          modelIssue={modelSignal.state === "unavailable" || modelConfigured === false}
          mockConsole={wb.source === "mock" ? <MockConsole onReset={wb.resetDemo} /> : null}
        />
      </aside>

      <main className={styles.main}>
        <header className={styles.topbar}>
          <button
            className={styles.menuButton}
            onClick={() => {
              setCatalogOpen(true);
              setMemoryOpen(false);
            }}
          >
            <Menu size={16} aria-hidden />
            题目
          </button>
          <div className={styles.breadcrumb}>
            {selectedProblem && CrumbIcon ? (
              <>
                <CrumbIcon size={15} className={styles.crumbIcon} aria-hidden />
                <span className={styles.crumbMuted}>{topicLabel(selectedProblem.topicKey, selectedProblem.topicLabel)}</span>
                <ChevronRight size={14} className={styles.crumbSep} aria-hidden />
                <span className={styles.crumbCurrent}>{selectedProblem.title}</span>
              </>
            ) : (
              <span className={styles.crumbCurrent}>开始学习</span>
            )}
          </div>
          <div className={styles.topActions}>
            <LoopStepper steps={steps} />
            <button
              className={cx(styles.memoryToggle, memoryOpen && styles.memoryToggleOpen)}
              aria-expanded={memoryOpen}
              onClick={() => {
                setMemoryOpen((open) => !open);
                setCatalogOpen(false);
              }}
            >
              记忆
              {wb.changedMemoryIds.length > 0 && <span className={styles.badge}>{wb.changedMemoryIds.length}</span>}
            </button>
          </div>
        </header>

        {showAnswerForm && selectedProblem && draft ? (
          <AnswerForm
            key={`${selectedProblem.id}:${wb.formNonce}`}
            leading={<ProblemStatement problem={selectedProblem} />}
            relatedMemoryCount={memoryCountByTopic[selectedProblem.topicKey] ?? 0}
            submitting={wb.submitting}
            answer={draft.answer}
            reasoning={draft.reasoning}
            onDraftChange={(answer, reasoning) => wb.saveDraft(selectedProblem.id, answer, reasoning)}
            onSubmit={wb.submitForProblem}
          >
            {wb.submitError && (
              <ErrorNotice
                error={wb.submitError}
                onRetry={wb.retrySubmit}
                onDismiss={wb.dismissSubmitError}
                onConfigure={openSettings}
                reveal
                className={styles.notice}
              />
            )}
            {wb.submitting && <DiagnosisPending />}
          </AnswerForm>
        ) : (
          <>
            <div ref={contentRef} className={styles.scroll}>
              <div className={styles.content}>
                {(wb.restoring || awaitingSession) && (
                  <p className={styles.restoring} role="status">
                    正在恢复这道题的学习会话…
                  </p>
                )}
                {!selectedProblem ? (
                  <WelcomeHero
                    canStart={wb.problems.data.length > 0}
                    onStart={() => {
                      const first = wb.problems.data[0];
                      if (first) wb.selectProblem(first.id);
                    }}
                  />
                ) : (
                  <>
                    <ProblemStatement problem={selectedProblem} compact={Boolean(session)} />
                    {wb.restoreError && !session && (
                      <ErrorNotice
                        error={wb.restoreError}
                        onRetry={wb.retryProblemSession}
                        retryLabel="重新读取会话"
                        onRestart={wb.startNewSession}
                        className={styles.notice}
                      />
                    )}
                    {session && (
                      <>
                        <div ref={sessionTopRef} className={styles.sessionTop}>
                          <UsedMemories usedIds={session.usedMemoryIds} memoriesById={memoriesById} onFocus={wb.focusMemory} />
                        </div>
                        <ChatThread
                          submission={session.submission}
                          submissionDiagnosis={session.submissionDiagnosis}
                          messages={session.messages}
                          sending={wb.sending}
                          onRetry={wb.retryMessage}
                        />
                        {wb.chatError && (
                          <ErrorNotice
                            error={wb.chatError}
                            context="session"
                            onRetry={
                              wb.chatError.kind === "not_found"
                                ? undefined
                                : wb.chatError.kind === "conflict"
                                  ? () => void wb.restoreSession()
                                  : () => void wb.retryMessage()
                            }
                            retryLabel={wb.chatError.kind === "conflict" ? "刷新会话" : "核对后重试"}
                            onRestart={wb.chatError.kind === "not_found" ? wb.startNewSession : undefined}
                            onDismiss={wb.dismissChatError}
                            onConfigure={openSettings}
                            reveal
                            className={styles.notice}
                          />
                        )}
                      </>
                    )}
                  </>
                )}
              </div>
            </div>

            {session && (
              <div className={styles.composerDock}>
                <div className={styles.composerInner}>
                  <div className={styles.stageBar}>
                    <p className={styles.stageStatus}>
                      <span>已提交</span>
                      <span>正在推导</span>
                    </p>
                    <div className={styles.stageActions}>
                      <Button
                        size="sm"
                        onClick={wb.startNewSession}
                        disabled={busy}
                        title="清空本题引导，重新作答。这次是新的首次作答。"
                      >
                        独立验证
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => {
                          if (nextProblem) wb.selectProblem(nextProblem.id);
                        }}
                        disabled={!nextProblem || busy}
                      >
                        下一题
                      </Button>
                    </div>
                  </div>
                  <ChatComposer sending={wb.sending || wb.restoring} onSend={(content) => void wb.sendMessage(content)} />
                </div>
              </div>
            )}
          </>
        )}
      </main>

      {memoryOpen && (
        <aside className={styles.panel}>
          <MemoryPanel
            memories={wb.memories}
            usedIds={session?.usedMemoryIds ?? []}
            changedIds={wb.changedMemoryIds}
            deletingIds={wb.deletingIds}
            focusRequest={wb.focusRequest}
            onDelete={wb.deleteMemory}
            onRefresh={wb.loadMemories}
          />
        </aside>
      )}

      {settingsOpen && (
        <SettingsDialog
          source={wb.source}
          health={wb.health}
          studentId={wb.studentId}
          modelSignal={modelSignal}
          onCheckHealth={() => void wb.checkHealth()}
          onConfigChange={handleConfigChange}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      <Toaster toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import { useWorkbench } from "@/hooks/useWorkbench";
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
import { Sidebar } from "./Sidebar";
import { topicIcon } from "./topicIcon";
import { UsedMemories } from "./UsedMemories";
import { WelcomeHero } from "./WelcomeHero";
import { Toaster, useToasts } from "./ui/Toaster";
import styles from "./Workbench.module.css";
import { WebSearchPanel } from "./WebSearchPanel";

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

export function Workbench() {
  const { toasts, push, dismiss } = useToasts();
  const wb = useWorkbench(push);
  const [searchOpen, setSearchOpen] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const sessionTopRef = useRef<HTMLDivElement>(null);

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

  const steps: LoopStep[] = [
    { key: "answer", label: "作答", status: session || wb.submitting ? "done" : "active" },
    { key: "diagnose", label: "诊断", status: session ? "done" : wb.submitting ? "active" : "todo" },
    { key: "guide", label: "引导", status: session ? "active" : "todo" },
    { key: "remember", label: "记忆", status: session && session.memoryChangeCount > 0 ? "done" : "todo" },
  ];

  // 诊断完成后，把视线带到「参考记忆 + 作答批注」
  const sessionId = session?.id;
  useEffect(() => {
    if (sessionId) sessionTopRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [sessionId]);

  // 换题时内容区回到顶部；单栏布局下把视线带到题目
  useEffect(() => {
    if (!wb.selectedProblemId) return;
    if (window.innerWidth > 900) contentRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    else contentRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [wb.selectedProblemId]);

  // 键盘快捷键：N 新会话，/ 聚焦输入框
  const startNewSession = wb.startNewSession;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (searchOpen) return;
      if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return;
      if (event.key === "n" || event.key === "N") {
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
  }, [canStartNew, startNewSession, searchOpen]);

  const CrumbIcon = selectedProblem ? topicIcon(selectedProblem.topicKey) : null;

  return (
    <div className={styles.app}>
      <aside className={styles.sidebar}>
        <Sidebar
          source={wb.source}
          health={wb.health}
          studentId={wb.studentId}
          problems={wb.problems}
          selectedId={wb.selectedProblemId}
          memoryCountByTopic={memoryCountByTopic}
          onSelect={wb.selectProblem}
          onRetry={wb.loadProblems}
          disabled={busy}
          canStartNew={canStartNew}
          onNewSession={wb.startNewSession}
          onOpenWebSearch={() => setSearchOpen(true)}
          webSearch={wb.webSearch}
          onWebSearchChange={wb.setWebSearch}
          mockConsole={wb.source === "mock" ? <MockConsole onReset={wb.resetDemo} /> : null}
        />
      </aside>

      <main className={styles.main}>
        <header className={styles.topbar}>
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
          <LoopStepper steps={steps} />
        </header>

        <div ref={contentRef} className={styles.scroll}>
          <div className={styles.content}>
            {wb.restoring && (
              <p className={styles.restoring} role="status">
                正在恢复服务器中的学习会话…
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
                <ProblemStatement problem={selectedProblem} />

                {!session ? (
                  <>
                    <AnswerForm
                      key={selectedProblem.id}
                      relatedMemoryCount={memoryCountByTopic[selectedProblem.topicKey] ?? 0}
                      submitting={wb.submitting}
                      onSubmit={wb.submitForProblem}
                    />
                    {wb.submitError && (
                      <ErrorNotice
                        error={wb.submitError}
                        onRetry={wb.retrySubmit}
                        onDismiss={wb.dismissSubmitError}
                        reveal
                        className={styles.notice}
                      />
                    )}
                    {wb.submitting && <DiagnosisPending />}
                  </>
                ) : (
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
              <ChatComposer sending={wb.sending || wb.restoring} onSend={(content) => void wb.sendMessage(content)} />
            </div>
          </div>
        )}
      </main>

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

      <Toaster toasts={toasts} onDismiss={dismiss} />
      <WebSearchPanel open={searchOpen} onClose={() => setSearchOpen(false)} />
    </div>
  );
}

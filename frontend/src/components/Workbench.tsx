"use client";

import { useEffect, useMemo, useRef } from "react";
import { useWorkbench } from "@/hooks/useWorkbench";
import type { LearningMemory } from "@/lib/types";
import { AnswerForm } from "./AnswerForm";
import { AppHeader } from "./AppHeader";
import { ChatComposer } from "./ChatComposer";
import { ChatThread } from "./ChatThread";
import { DiagnosisCard, DiagnosisSkeleton } from "./DiagnosisCard";
import { ErrorNotice } from "./ErrorNotice";
import type { LoopStep } from "./LoopStepper";
import { MemoryPanel } from "./MemoryPanel";
import { MockConsole } from "./MockConsole";
import { ProblemPanel } from "./ProblemPanel";
import { ProblemStatement } from "./ProblemStatement";
import { UsedMemories } from "./UsedMemories";
import { WelcomeHero } from "./WelcomeHero";
import { Toaster, useToasts } from "./ui/Toaster";
import styles from "./Workbench.module.css";

export function Workbench() {
  const { toasts, push, dismiss } = useToasts();
  const wb = useWorkbench(push);
  const centerRef = useRef<HTMLDivElement>(null);
  const sessionTopRef = useRef<HTMLDivElement>(null);

  const selectedProblem = wb.problems.data.find((problem) => problem.id === wb.selectedProblemId) ?? null;
  const session = wb.session;

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

  // 诊断完成后，把视线带到「参考记忆 + 诊断结果」
  const sessionId = session?.id;
  useEffect(() => {
    if (sessionId) sessionTopRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [sessionId]);

  // 单栏布局下选择题目后，把视线带到作答区
  useEffect(() => {
    if (!wb.selectedProblemId || window.innerWidth > 900) return;
    centerRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [wb.selectedProblemId]);

  return (
    <div className={styles.app}>
      <AppHeader
        source={wb.source}
        health={wb.health}
        studentId={wb.studentId}
        steps={steps}
        canStartNew={Boolean(selectedProblem && (session || wb.submitError)) && !wb.submitting && !wb.sending && !wb.restoring}
        onNewSession={wb.startNewSession}
        mockConsole={wb.source === "mock" ? <MockConsole onReset={wb.resetDemo} /> : null}
      />

      <main className={styles.main}>
        <aside className={styles.left}>
          <ProblemPanel
            source={wb.source}
            problems={wb.problems}
            selectedId={wb.selectedProblemId}
            memoryCountByTopic={memoryCountByTopic}
            onSelect={wb.selectProblem}
            onRetry={wb.loadProblems}
            disabled={wb.submitting || wb.sending || wb.restoring}
          />
        </aside>

        <div ref={centerRef} className={styles.center}>
          {wb.restoring && <p role="status">正在恢复服务器中的学习会话…</p>}
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
              <ProblemStatement problem={selectedProblem} submission={session?.submission} />

              {!session ? (
                <>
                  <AnswerForm
                    key={selectedProblem.id}
                    relatedMemoryCount={memoryCountByTopic[selectedProblem.topicKey] ?? 0}
                    submitting={wb.submitting}
                    onSubmit={wb.submitForProblem}
                  />
                  {wb.submitError && (
                    <ErrorNotice error={wb.submitError} onRetry={wb.retrySubmit} onDismiss={wb.dismissSubmitError} reveal />
                  )}
                  {wb.submitting && <DiagnosisSkeleton />}
                </>
              ) : (
                <>
                  <div ref={sessionTopRef}>
                    <UsedMemories usedIds={session.usedMemoryIds} memoriesById={memoriesById} onFocus={wb.focusMemory} />
                  </div>
                  <DiagnosisCard diagnosis={session.diagnosis} />
                  <ChatThread messages={session.messages} sending={wb.sending} onRetry={wb.retryMessage} />
                  {wb.chatError && (
                    <ErrorNotice
                      error={wb.chatError}
                      context="session"
                      onRetry={wb.chatError.kind === "not_found" ? undefined : wb.chatError.kind === "conflict" ? () => void wb.restoreSession() : () => void wb.retryMessage()}
                      retryLabel={wb.chatError.kind === "conflict" ? "刷新会话" : "核对后重试"}
                      onRestart={wb.chatError.kind === "not_found" ? wb.startNewSession : undefined}
                      onDismiss={wb.dismissChatError}
                      reveal
                      className={styles.chatError}
                    />
                  )}
                  <div className={styles.composerDock}>
                    <ChatComposer sending={wb.sending || wb.restoring} onSend={(content) => void wb.sendMessage(content)} />
                  </div>
                </>
              )}
            </>
          )}
        </div>

        <aside className={styles.right}>
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
      </main>

      <Toaster toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}

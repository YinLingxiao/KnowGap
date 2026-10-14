"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getClient } from "@/lib/api/client";
import { ApiError, describeError, toApiError } from "@/lib/api/errors";
import { API_BASE_URL, DEMO_STUDENT_ID } from "@/lib/config";
import type {
  AnswerSubmission,
  ChatMessage,
  Diagnosis,
  LearningMemory,
  MemoryChange,
  Problem,
  SessionSnapshot,
} from "@/lib/types";
import { resetMockDb } from "@/mocks/mock-client";

export interface ThreadMessage extends ChatMessage {
  delivery?: "sending" | "failed";
  memoryChanges?: MemoryChange[];
}

export interface ActiveSession {
  id: string;
  turn: number;
  problemId: string;
  submission: { answer: string; reasoning: string };
  /** 首次作答的诊断（批注在作答原文上）；diagnosis 为最新一轮 */
  submissionDiagnosis: Diagnosis;
  diagnosis: Diagnosis;
  usedMemoryIds: string[];
  messages: ThreadMessage[];
  /** 本次会话累计的记忆变化条数，用于流程指示 */
  memoryChangeCount: number;
}

export interface Resource<T> {
  data: T;
  loading: boolean;
  error: ApiError | null;
}

export type HealthState = "checking" | "online" | "offline";

export interface Notify {
  (toast: { tone: "success" | "error" | "info"; title: string; description?: string }): void;
}

const SESSION_POINTER = `knowgap.api.session.v1:${API_BASE_URL}`;

function rememberSession(session: { id: string; problemId: string } | null) {
  try {
    if (session) localStorage.setItem(SESSION_POINTER, JSON.stringify({ id: session.id, problemId: session.problemId }));
    else localStorage.removeItem(SESSION_POINTER);
  } catch { /* Disabled browser storage must not prevent learning. */ }
}

function readRememberedSession(): { id: string; problemId: string } | null {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(SESSION_POINTER) ?? "null");
    if (saved && typeof saved === "object" && "id" in saved && "problemId" in saved &&
        typeof saved.id === "string" && typeof saved.problemId === "string") return { id: saved.id, problemId: saved.problemId };
  } catch { /* Ignore malformed or unavailable local storage. */ }
  return null;
}

function recoveredSession(snapshot: SessionSnapshot, memories: LearningMemory[]): ActiveSession {
  return { ...snapshot, submissionDiagnosis: snapshot.submissionDiagnosis ?? snapshot.diagnosis,
    memoryChangeCount: memories.reduce((count, memory) =>
    count + memory.evidenceRefs.filter((ref) => ref.sessionId === snapshot.id).length, 0) };
}

export function useWorkbench(notify: Notify) {
  const client = useMemo(() => getClient(), []);
  const studentId = DEMO_STUDENT_ID;

  const [problems, setProblems] = useState<Resource<Problem[]>>({ data: [], loading: true, error: null });
  const [memories, setMemories] = useState<Resource<LearningMemory[]>>({ data: [], loading: true, error: null });
  const [health, setHealth] = useState<HealthState>("checking");

  const [selectedProblemId, setSelectedProblemId] = useState<string | null>(null);
  const [session, setSession] = useState<ActiveSession | null>(null);
  const [lastSubmission, setLastSubmission] = useState<AnswerSubmission | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<ApiError | null>(null);
  const [sending, setSending] = useState(false);
  const [chatError, setChatError] = useState<ApiError | null>(null);
  const [restoring, setRestoring] = useState(false);
  const busy = useRef(false);

  const [changedMemoryIds, setChangedMemoryIds] = useState<string[]>([]);
  const [deletingIds, setDeletingIds] = useState<string[]>([]);
  const [focusRequest, setFocusRequest] = useState<{ id: string; nonce: number } | null>(null);

  /* ---------- 加载 ---------- */

  const loadProblems = useCallback(async () => {
    setProblems((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const data = await client.listProblems();
      setProblems({ data, loading: false, error: null });
    } catch (error) {
      setProblems((prev) => ({ ...prev, loading: false, error: toApiError(error) }));
    }
  }, [client]);

  const loadMemories = useCallback(async () => {
    setMemories((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const data = await client.listMemories(studentId);
      setMemories({ data, loading: false, error: null });
    } catch (error) {
      setMemories((prev) => ({ ...prev, loading: false, error: toApiError(error) }));
    }
  }, [client, studentId]);

  const checkHealth = useCallback(async () => {
    setHealth("checking");
    try {
      await client.checkHealth();
      setHealth("online");
    } catch {
      setHealth("offline");
    }
  }, [client]);

  useEffect(() => {
    void loadProblems();
    void loadMemories();
    void checkHealth();
  }, [loadProblems, loadMemories, checkHealth]);

  useEffect(() => {
    if (client.source !== "api" || !client.getSession) return;
    const saved = readRememberedSession();
    if (!saved) return;
    let cancelled = false;
    busy.current = true;
    setRestoring(true);
    void Promise.all([client.getSession(saved.id), client.listMemories(studentId)])
      .then(([snapshot, data]) => {
        if (cancelled) return;
        setSelectedProblemId(snapshot.problemId);
        setSession(recoveredSession(snapshot, data));
        setMemories({ data, loading: false, error: null });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const failure = toApiError(error);
        if (failure.kind === "not_found") rememberSession(null);
        notify({ tone: "error", title: "未能恢复上次会话", description: failure.message });
      })
      .finally(() => { if (!cancelled) { busy.current = false; setRestoring(false); } });
    return () => { cancelled = true; };
  }, [client, studentId, notify]);

  const applyMemoryChanges = useCallback(
    (changes: MemoryChange[]) => {
      if (changes.length === 0) return;
      setChangedMemoryIds(changes.map((change) => change.memoryId));
      void loadMemories();
    },
    [loadMemories],
  );

  /* ---------- 题目与会话 ---------- */

  const selectProblem = useCallback((problemId: string) => {
    if (busy.current) return;
    if (client.source === "api") rememberSession(null);
    setSelectedProblemId(problemId);
    setSession(null);
    setSubmitError(null);
    setChatError(null);
    setLastSubmission(null);
  }, [client.source]);

  const startNewSession = useCallback(() => {
    if (busy.current) return;
    if (client.source === "api") rememberSession(null);
    setSession(null);
    setSubmitError(null);
    setChatError(null);
    setLastSubmission(null);
  }, [client.source]);

  const submitAnswer = useCallback(
    async (input: AnswerSubmission) => {
      if (busy.current || !input.answer.trim()) return;
      busy.current = true;
      setLastSubmission(input);
      setSubmitting(true);
      setSubmitError(null);
      try {
        const result = await client.startSession(input);
        setSession({
          id: result.sessionId,
          turn: result.turn ?? 1,
          problemId: input.problemId,
          submission: { answer: input.answer, reasoning: input.reasoning },
          submissionDiagnosis: result.diagnosis,
          diagnosis: result.diagnosis,
          usedMemoryIds: result.usedMemoryIds,
          messages: [{ ...result.reply, memoryChanges: result.memoryChanges }],
          memoryChangeCount: result.memoryChanges.length,
        });
        if (client.source === "api") rememberSession({ id: result.sessionId, problemId: input.problemId });
        applyMemoryChanges(result.memoryChanges);
      } catch (error) {
        setSubmitError(toApiError(error));
      } finally {
        busy.current = false;
        setSubmitting(false);
      }
    },
    [client, applyMemoryChanges],
  );

  const submitForProblem = useCallback(
    (answer: string, reasoning: string) => {
      if (!selectedProblemId) return;
      void submitAnswer({
        studentId,
        problemId: selectedProblemId,
        answer: answer.trim(),
        reasoning: reasoning.trim(),
      });
    },
    [selectedProblemId, studentId, submitAnswer],
  );

  const retrySubmit = useCallback(() => {
    if (lastSubmission) void submitAnswer(lastSubmission);
  }, [lastSubmission, submitAnswer]);

  const sendMessage = useCallback(
    async (content: string) => {
      const text = content.trim();
      if (!text || !session || busy.current) return;
      busy.current = true;
      const sessionId = session.id;
      const localId = `local-${Date.now()}`;
      const local: ThreadMessage = {
        id: localId,
        role: "student",
        content: text,
        createdAt: new Date().toISOString(),
        delivery: "sending",
      };

      const patchSession = (update: (s: ActiveSession) => ActiveSession) =>
        setSession((current) => (current && current.id === sessionId ? update(current) : current));

      patchSession((s) => ({ ...s, messages: [...s.messages, local] }));
      setSending(true);
      setChatError(null);
      try {
        const turn = await client.sendMessage(sessionId, text);
        patchSession((s) => ({
          ...s,
          turn: turn.turn ?? s.turn + 1,
          diagnosis: turn.diagnosis ?? s.diagnosis,
          usedMemoryIds: turn.usedMemoryIds ?? s.usedMemoryIds,
          messages: [
            ...s.messages.map((m) => (m.id === localId ? { ...m, delivery: undefined, diagnosis: turn.diagnosis } : m)),
            { ...turn.reply, memoryChanges: turn.memoryChanges },
          ],
          memoryChangeCount: s.memoryChangeCount + turn.memoryChanges.length,
        }));
        applyMemoryChanges(turn.memoryChanges);
      } catch (error) {
        patchSession((s) => ({
          ...s,
          messages: s.messages.map((m) => (m.id === localId ? { ...m, delivery: "failed" } : m)),
        }));
        setChatError(toApiError(error));
      } finally {
        busy.current = false;
        setSending(false);
      }
    },
    [client, session, applyMemoryChanges],
  );

  const restoreSession = useCallback(async () => {
    if (!session || !client.getSession || busy.current) return;
    busy.current = true;
    setRestoring(true);
    try {
      const [snapshot, data] = await Promise.all([client.getSession(session.id), client.listMemories(studentId)]);
      setSession(recoveredSession(snapshot, data));
      setMemories({ data, loading: false, error: null });
      setChatError(snapshot.turn >= 40 ? new ApiError("conflict", "当前会话已达到 40 轮，请开启新会话。", 409) : null);
    } catch (error) {
      setChatError(toApiError(error));
    } finally {
      busy.current = false;
      setRestoring(false);
    }
  }, [client, session, studentId]);

  const retryMessage = useCallback(
    async (messageId?: string) => {
      if (!session || busy.current) return;
      const failed = messageId
        ? session.messages.find((m) => m.id === messageId)
        : [...session.messages].reverse().find((m) => m.delivery === "failed");
      if (!failed) return;
      if (client.getSession) {
        busy.current = true;
        setRestoring(true);
        try {
          // A browser timeout can happen AFTER the backend committed. Recover before retrying.
          const snapshot = await client.getSession(session.id);
          if (snapshot.turn > session.turn || chatError?.kind === "conflict") {
            const data = await client.listMemories(studentId);
            setSession(recoveredSession(snapshot, data));
            setMemories({ data, loading: false, error: null });
            setChatError(snapshot.turn >= 40 ? new ApiError("conflict", "当前会话已达到 40 轮，请开启新会话。", 409) : null);
            return;
          }
        } catch (error) {
          setChatError(toApiError(error));
          return;
        } finally {
          busy.current = false;
          setRestoring(false);
        }
      }
      setSession((s) => (s ? { ...s, messages: s.messages.filter((m) => m.id !== failed.id) } : s));
      void sendMessage(failed.content);
    },
    [session, sendMessage, client, studentId, chatError?.kind],
  );

  /* ---------- 记忆 ---------- */

  const deleteMemory = useCallback(
    async (memoryId: string) => {
      setDeletingIds((ids) => [...ids, memoryId]);
      try {
        await client.deleteMemory(memoryId);
        setMemories((prev) => ({ ...prev, data: prev.data.filter((m) => m.id !== memoryId) }));
        notify({ tone: "success", title: "已删除这条学习记忆" });
        return true;
      } catch (error) {
        const apiError = toApiError(error);
        const copy = describeError(apiError, "memory");
        notify({ tone: "error", title: `删除失败：${copy.title}`, description: copy.hint });
        if (apiError.kind === "not_found") void loadMemories();
        return false;
      } finally {
        setDeletingIds((ids) => ids.filter((id) => id !== memoryId));
      }
    },
    [client, notify, loadMemories],
  );

  const focusMemory = useCallback((memoryId: string) => {
    setFocusRequest({ id: memoryId, nonce: Date.now() });
  }, []);

  /** 仅 Mock 模式：清空模拟的会话与记忆 */
  const resetDemo = useCallback(() => {
    resetMockDb();
    setSession(null);
    setSelectedProblemId(null);
    setSubmitError(null);
    setChatError(null);
    setChangedMemoryIds([]);
    void loadMemories();
    notify({ tone: "info", title: "演示数据已重置", description: "模拟的会话与学习记忆已清空。" });
  }, [loadMemories, notify]);

  return {
    source: client.source,
    studentId,
    health,
    problems,
    memories,
    selectedProblemId,
    session,
    submitting,
    submitError,
    sending,
    restoring,
    restoreSession,
    chatError,
    changedMemoryIds,
    deletingIds,
    focusRequest,
    loadProblems,
    loadMemories,
    selectProblem,
    startNewSession,
    submitForProblem,
    retrySubmit,
    dismissSubmitError: () => setSubmitError(null),
    sendMessage,
    retryMessage,
    dismissChatError: () => setChatError(null),
    deleteMemory,
    focusMemory,
    resetDemo,
  };
}

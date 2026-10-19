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

const SESSION_POINTERS = `knowgap.api.sessions.v1:${API_BASE_URL}`;
const LEGACY_SESSION_POINTER = `knowgap.api.session.v1:${API_BASE_URL}`;
const DRAFTS_KEY = "knowgap.drafts.v1";

function draftsKey() {
  try {
    return `${localStorage.getItem("knowgap.auth.user.v1") || "demo-student-001"}:${DRAFTS_KEY}`;
  } catch {
    return DRAFTS_KEY;
  }
}

interface SessionPointers {
  active: string | null;
  byProblem: Record<string, string>;
}

export interface AnswerDraft {
  answer: string;
  reasoning: string;
}

function emptyPointers(): SessionPointers {
  return { active: null, byProblem: {} };
}

function readPointers(): SessionPointers {
  try {
    const raw = localStorage.getItem(SESSION_POINTERS);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && "byProblem" in parsed) {
        const record = parsed as { active?: unknown; byProblem?: unknown };
        const byProblem: Record<string, string> = {};
        if (record.byProblem && typeof record.byProblem === "object") {
          for (const [key, value] of Object.entries(record.byProblem as Record<string, unknown>)) {
            if (typeof value === "string") byProblem[key] = value;
          }
        }
        return { active: typeof record.active === "string" ? record.active : null, byProblem };
      }
    }
    const legacy: unknown = JSON.parse(localStorage.getItem(LEGACY_SESSION_POINTER) ?? "null");
    if (
      legacy && typeof legacy === "object" && "id" in legacy && "problemId" in legacy &&
      typeof legacy.id === "string" && typeof legacy.problemId === "string"
    ) {
      return { active: legacy.problemId, byProblem: { [legacy.problemId]: legacy.id } };
    }
  } catch { /* Ignore malformed or unavailable local storage. */ }
  return emptyPointers();
}

function writePointers(next: SessionPointers | null) {
  try {
    if (!next || (!next.active && Object.keys(next.byProblem).length === 0)) localStorage.removeItem(SESSION_POINTERS);
    else localStorage.setItem(SESSION_POINTERS, JSON.stringify(next));
    localStorage.removeItem(LEGACY_SESSION_POINTER);
  } catch { /* Disabled browser storage must not prevent learning. */ }
}

function rememberProblemSession(problemId: string, sessionId: string) {
  const current = readPointers();
  writePointers({ active: problemId, byProblem: { ...current.byProblem, [problemId]: sessionId } });
}

function forgetProblemSession(problemId: string) {
  const current = readPointers();
  const byProblem = { ...current.byProblem };
  delete byProblem[problemId];
  writePointers({ active: problemId, byProblem });
}

function activateProblem(problemId: string) {
  const current = readPointers();
  writePointers({ ...current, active: problemId });
}

function readDrafts(): Record<string, AnswerDraft> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(draftsKey()) ?? "null");
    if (!parsed || typeof parsed !== "object") return {};
    const drafts: Record<string, AnswerDraft> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (
        value && typeof value === "object" && "answer" in value && "reasoning" in value &&
        typeof value.answer === "string" && typeof value.reasoning === "string"
      ) {
        drafts[key] = { answer: value.answer, reasoning: value.reasoning };
      }
    }
    return drafts;
  } catch {
    return {};
  }
}

function writeDrafts(drafts: Record<string, AnswerDraft>) {
  try {
    localStorage.setItem(draftsKey(), JSON.stringify(drafts));
  } catch { /* Disabled browser storage must not prevent learning. */ }
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
  const [webSearch, setWebSearch] = useState(false);

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
  const [drafts, setDrafts] = useState<Record<string, AnswerDraft>>({});
  const [formNonce, setFormNonce] = useState(0);
  const [pendingSessionProblemId, setPendingSessionProblemId] = useState<string | null>(null);
  const [restoreError, setRestoreError] = useState<ApiError | null>(null);

  const sessionRef = useRef(session);
  sessionRef.current = session;
  const selectedProblemIdRef = useRef(selectedProblemId);
  selectedProblemIdRef.current = selectedProblemId;
  const cacheRef = useRef<Record<string, ActiveSession>>({});
  const selectSeq = useRef(0);

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
    setDrafts((current) => ({ ...readDrafts(), ...current }));
  }, []);

  useEffect(() => {
    if (session) cacheRef.current[session.problemId] = session;
  }, [session]);

  useEffect(() => {
    if (client.source !== "api" || !client.getSession) return;
    const saved = readPointers();
    if (!saved.active) return;
    setSelectedProblemId(saved.active);
    const sessionId = saved.byProblem[saved.active];
    if (!sessionId) return;
    const problemId = saved.active;
    const seq = ++selectSeq.current;
    let cancelled = false;
    busy.current = true;
    setRestoring(true);
    setPendingSessionProblemId(problemId);
    void Promise.all([client.getSession(sessionId), client.listMemories(studentId)])
      .then(([snapshot, data]) => {
        if (cancelled || seq !== selectSeq.current) return;
        const recovered = recoveredSession(snapshot, data);
        cacheRef.current[snapshot.problemId] = recovered;
        setSelectedProblemId(snapshot.problemId);
        setSession(recovered);
        setMemories({ data, loading: false, error: null });
      })
      .catch((error: unknown) => {
        if (cancelled || seq !== selectSeq.current) return;
        const failure = toApiError(error);
        if (failure.kind === "not_found") {
          forgetProblemSession(problemId);
          setRestoreError(null);
        } else {
          setRestoreError(failure);
        }
        notify({ tone: "error", title: "未能恢复上次会话", description: failure.message });
      })
      .finally(() => {
        if (!cancelled && seq === selectSeq.current) {
          busy.current = false;
          setRestoring(false);
          setPendingSessionProblemId(null);
        }
      });
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

  const saveDraft = useCallback((problemId: string, answer: string, reasoning: string) => {
    setDrafts((current) => {
      const next = { ...current, [problemId]: { answer, reasoning } };
      writeDrafts(next);
      return next;
    });
  }, []);

  const clearDraft = useCallback((problemId: string) => {
    setDrafts((current) => {
      const next = { ...current };
      delete next[problemId];
      writeDrafts(next);
      return next;
    });
    setFormNonce((nonce) => nonce + 1);
  }, []);

  const restoreProblemSession = useCallback((problemId: string) => {
    const seq = ++selectSeq.current;
    const cached = cacheRef.current[problemId];
    if (cached) {
      setSession(cached);
      setPendingSessionProblemId(null);
      setRestoreError(null);
      return;
    }
    const sessionId = client.source === "api" ? readPointers().byProblem[problemId] : undefined;
    if (!sessionId || !client.getSession) {
      setSession(null);
      setPendingSessionProblemId(null);
      setRestoreError(null);
      return;
    }
    setSession(null);
    setRestoreError(null);
    setPendingSessionProblemId(problemId);
    void client.getSession(sessionId)
      .then(async (snapshot) => {
        if (seq !== selectSeq.current) return null;
        const data = await client.listMemories(studentId);
        if (seq !== selectSeq.current) return null;
        const recovered = recoveredSession(snapshot, data);
        cacheRef.current[problemId] = recovered;
        setSession(recovered);
        setMemories({ data, loading: false, error: null });
        return recovered;
      })
      .catch((error: unknown) => {
        if (seq !== selectSeq.current) return;
        const failure = toApiError(error);
        if (failure.kind === "not_found") {
          forgetProblemSession(problemId);
          setSession(null);
          setRestoreError(null);
        } else {
          setRestoreError(failure);
        }
      })
      .finally(() => {
        if (seq === selectSeq.current) setPendingSessionProblemId(null);
      });
  }, [client, studentId]);

  const selectProblem = useCallback((problemId: string) => {
    if (problemId === selectedProblemIdRef.current) return;
    if (busy.current) return;
    const previousId = selectedProblemIdRef.current;
    const previous = sessionRef.current;
    if (previousId && previous && previous.problemId === previousId) cacheRef.current[previousId] = previous;
    if (client.source === "api") activateProblem(problemId);
    setChangedMemoryIds([]);
    setSelectedProblemId(problemId);
    setSubmitError(null);
    setChatError(null);
    setLastSubmission(null);
    restoreProblemSession(problemId);
  }, [client.source, restoreProblemSession]);

  const startNewSession = useCallback(() => {
    if (busy.current) return;
    selectSeq.current += 1;
    const problemId = selectedProblemIdRef.current;
    if (problemId) {
      delete cacheRef.current[problemId];
      if (client.source === "api") forgetProblemSession(problemId);
      clearDraft(problemId);
    }
    setSession(null);
    setPendingSessionProblemId(null);
    setRestoreError(null);
    setSubmitError(null);
    setChatError(null);
    setLastSubmission(null);
    setChangedMemoryIds([]);
  }, [clearDraft, client.source]);

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
        if (client.source === "api") rememberProblemSession(input.problemId, result.sessionId);
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
        webSearch,
      });
    },
    [selectedProblemId, studentId, submitAnswer, webSearch],
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
        const turn = await client.sendMessage(sessionId, text, webSearch);
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
    [client, session, applyMemoryChanges, webSearch],
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
    cacheRef.current = {};
    selectSeq.current += 1;
    writePointers(null);
    writeDrafts({});
    setDrafts({});
    setFormNonce((nonce) => nonce + 1);
    setSession(null);
    setSelectedProblemId(null);
    setPendingSessionProblemId(null);
    setRestoreError(null);
    setSubmitError(null);
    setChatError(null);
    setChangedMemoryIds([]);
    void loadMemories();
    notify({ tone: "info", title: "演示数据已重置", description: "模拟的会话与学习记忆已清空。" });
  }, [loadMemories, notify]);

  return {
    source: client.source,
    webSearch,
    setWebSearch,
    studentId,
    health,
    checkHealth,
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
    drafts,
    formNonce,
    saveDraft,
    pendingSessionProblemId,
    restoreError,
    retryProblemSession: () => {
      const problemId = selectedProblemIdRef.current;
      if (problemId) restoreProblemSession(problemId);
    },
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

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, toApiError } from "@/lib/api/errors";
import { chatApi } from "@/lib/chat/api";
import type {
  ChatMessage, Conversation, ConversationSummary, LearnerMemory, LearnerMemoryStatus, SpaceInput, StreamEvent, Subject,
} from "@/lib/chat/types";
import { API_BASE_URL } from "@/lib/config";
import type { Problem } from "@/lib/types";

export interface Notify {
  (toast: { tone: "success" | "error" | "info"; title: string; description?: string }): void;
}

export interface Thread {
  messages: ChatMessage[];
  loading: boolean;
  error: ApiError | null;
}

/** connecting：请求已发出、服务端尚未确认；streaming：正在输出；analyzing：回复已完成，正在整理学习记录 */
export type StreamPhase = "connecting" | "streaming" | "analyzing";

interface StreamHandle {
  controller: AbortController;
  phase: StreamPhase;
}

export interface SendFailure {
  conversationId: string | null;
  error: ApiError;
}

const NEW = "new";
const ACTIVE_KEY = `knowgap.chat.active.v1:${API_BASE_URL}`;
const DRAFTS_KEY = `knowgap.chat.drafts.v1:${API_BASE_URL}`;

function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function storage<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

function upsert(messages: ChatMessage[], message: ChatMessage | null): ChatMessage[] {
  if (!message) return messages;
  const index = messages.findIndex((item) => item.id === message.id);
  if (index >= 0) {
    const next = messages.slice();
    next[index] = message;
    return next;
  }
  return [...messages, message].sort((a, b) => a.seq - b.seq);
}

function sortSummaries(items: ConversationSummary[]): ConversationSummary[] {
  return items.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function useChat(notify: Notify) {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<ApiError | null>(null);
  const [activeId, setActiveIdState] = useState<string | null>(null);
  const [threads, setThreads] = useState<Record<string, Thread>>({});
  const [streams, setStreams] = useState<Record<string, StreamHandle>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [creating, setCreating] = useState(false);
  const [sendFailure, setSendFailure] = useState<SendFailure | null>(null);
  const [problems, setProblems] = useState<Problem[]>([]);
  const [memories, setMemories] = useState<LearnerMemory[]>([]);
  const [memoriesLoading, setMemoriesLoading] = useState(true);
  const [memoriesError, setMemoriesError] = useState<ApiError | null>(null);
  const [follows, setFollows] = useState<Record<string, number>>({});
  const [restored, setRestored] = useState(false);
  const [subjects, setSubjects] = useState<Subject[]>([]);
  /** 空白新对话发出第一条消息时归入的 Subject（在 Subject 页里开始的对话） */
  const [draftSubjectId, setDraftSubjectId] = useState<string | null>(null);

  const draftConversationKey = useRef(newId());
  const pending = useRef<Record<string, { text: string; requestId: string }>>({});
  const streamsRef = useRef(streams);
  streamsRef.current = streams;

  const setActiveId = useCallback((id: string | null) => {
    setActiveIdState(id);
    storage(() => (id ? localStorage.setItem(ACTIVE_KEY, id) : localStorage.removeItem(ACTIVE_KEY)), undefined);
  }, []);

  const upsertSummary = useCallback((summary: ConversationSummary | null) => {
    if (!summary) return;
    setConversations((items) => sortSummaries([summary, ...items.filter((item) => item.id !== summary.id)]));
  }, []);

  const patchMessages = useCallback((id: string, update: (messages: ChatMessage[]) => ChatMessage[]) => {
    setThreads((all) => {
      const thread = all[id] ?? { messages: [], loading: false, error: null };
      return { ...all, [id]: { ...thread, messages: update(thread.messages) } };
    });
  }, []);

  const putConversation = useCallback((conversation: Conversation) => {
    const { messages, ...summary } = conversation;
    upsertSummary(summary);
    setThreads((all) => ({ ...all, [conversation.id]: { messages, loading: false, error: null } }));
  }, [upsertSummary]);

  const loadSubjects = useCallback(async () => {
    try {
      setSubjects(await chatApi.listSubjects());
    } catch {
      // The sidebar keeps the last known list; conversations still work without it.
    }
  }, []);

  const refreshList = useCallback(async () => {
    try {
      setConversations(sortSummaries(await chatApi.listConversations()));
      setListError(null);
      void loadSubjects();
    } catch (error) {
      setListError(toApiError(error));
    } finally {
      setListLoading(false);
    }
  }, [loadSubjects]);

  const loadMemories = useCallback(async () => {
    setMemoriesLoading(true);
    try {
      setMemories(await chatApi.listMemories());
      setMemoriesError(null);
    } catch (error) {
      setMemoriesError(toApiError(error));
    } finally {
      setMemoriesLoading(false);
    }
  }, []);

  const newChat = useCallback((subjectId: string | null = null) => {
    draftConversationKey.current = newId();
    setDraftSubjectId(subjectId);
    setSendFailure(null);
    setActiveId(null);
  }, [setActiveId]);

  const loadConversation = useCallback(async (id: string) => {
    setThreads((all) => ({ ...all, [id]: { messages: all[id]?.messages ?? [], loading: true, error: null } }));
    try {
      putConversation(await chatApi.getConversation(id));
    } catch (error) {
      const apiError = toApiError(error);
      if (apiError.kind === "not_found") {
        setConversations((items) => items.filter((item) => item.id !== id));
        setThreads((all) => {
          const next = { ...all };
          delete next[id];
          return next;
        });
        setActiveIdState((current) => {
          if (current !== id) return current;
          storage(() => localStorage.removeItem(ACTIVE_KEY), undefined);
          return null;
        });
        notify({ tone: "info", title: "这个对话已不存在", description: "可能已在其他页面删除。" });
        return;
      }
      setThreads((all) => ({ ...all, [id]: { messages: all[id]?.messages ?? [], loading: false, error: apiError } }));
    }
  }, [notify, putConversation]);

  const openConversation = useCallback((id: string) => {
    setSendFailure(null);
    setActiveId(id);
    setFollows((all) => ({ ...all, [id]: (all[id] ?? 0) + 1 }));
    void loadConversation(id);
  }, [loadConversation, setActiveId]);

  // 首次加载：题目、会话列表、记忆；恢复刷新前打开的会话
  useEffect(() => {
    setDrafts(storage(() => {
      const parsed: unknown = JSON.parse(localStorage.getItem(DRAFTS_KEY) ?? "{}");
      return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
    }, {}));
    void chatApi.listProblems().then(setProblems).catch(() => setProblems([]));
    void loadMemories();
    void refreshList();
    const saved = storage(() => localStorage.getItem(ACTIVE_KEY), null);
    if (saved) {
      setActiveIdState(saved);
      void loadConversation(saved);
    }
    setRestored(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on mount
  }, []);

  useEffect(() => {
    if (!restored) return;
    storage(() => {
      const kept = Object.fromEntries(Object.entries(drafts).filter(([, value]) => value));
      localStorage.setItem(DRAFTS_KEY, JSON.stringify(kept));
    }, undefined);
  }, [drafts, restored]);

  const draftKey = activeId ?? NEW;
  const setDraft = useCallback((value: string) => {
    setDrafts((all) => ({ ...all, [draftKey]: value }));
  }, [draftKey]);

  const endStream = useCallback((id: string, controller: AbortController) => {
    setStreams((all) => {
      if (all[id]?.controller !== controller) return all;
      const next = { ...all };
      delete next[id];
      return next;
    });
  }, []);

  const setPhase = useCallback((id: string, controller: AbortController, phase: StreamPhase) => {
    setStreams((all) => (all[id]?.controller === controller ? { ...all, [id]: { controller, phase } } : all));
  }, []);

  /** 运行一次流式请求。连接阶段失败时抛出 ApiError；返回服务端是否已确认收到 */
  const runStream = useCallback(async (
    id: string,
    start: (onEvent: (event: StreamEvent) => void, signal: AbortSignal) => Promise<"ended" | "interrupted">,
    onAck?: () => void,
  ): Promise<boolean> => {
    const controller = new AbortController();
    setStreams((all) => ({ ...all, [id]: { controller, phase: "connecting" } }));
    let assistantId: string | null = null;
    let acked = false;
    const onEvent = (event: StreamEvent) => {
      switch (event.type) {
        case "start":
          acked = true;
          onAck?.();
          upsertSummary(event.conversation);
          assistantId = event.assistantMessage?.id ?? null;
          patchMessages(id, (messages) => upsert(
            upsert(messages.filter((m) => !event.discardedIds.includes(m.id)), event.userMessage),
            event.assistantMessage,
          ));
          setPhase(id, controller, "streaming");
          setFollows((all) => ({ ...all, [id]: (all[id] ?? 0) + 1 }));
          break;
        case "delta":
          patchMessages(id, (messages) => messages.map((m) => (m.id === assistantId ? { ...m, content: m.content + event.text } : m)));
          break;
        case "done":
          patchMessages(id, (messages) => upsert(messages, event.message));
          setPhase(id, controller, "analyzing");
          break;
        case "cancelled":
          patchMessages(id, (messages) => upsert(messages, event.message));
          endStream(id, controller);
          break;
        case "error":
          if (event.message) patchMessages(id, (messages) => upsert(messages, event.message));
          else notify({ tone: "error", title: "生成失败", description: event.detail });
          endStream(id, controller);
          break;
        case "analysis":
          patchMessages(id, (messages) => upsert(upsert(messages, event.userMessage), event.assistantMessage));
          if (event.userMessage?.memoryChanges.length) void loadMemories();
          break;
        case "tool_approval":
          patchMessages(id, (messages) => messages.map((m) => (m.id === assistantId ? { ...m, pendingApproval: event } : m)));
          break;
        case "tool_start":
        case "tool_end":
          patchMessages(id, (messages) => messages.map((m) => {
            if (m.id !== assistantId) return m;
            const current = m.toolCalls.find((call) => call.id === event.id);
            const next = {
              id: event.id,
              name: event.name,
              arguments: event.type === "tool_start" ? event.arguments : current?.arguments ?? "",
              output: event.type === "tool_end" ? event.output : current?.output ?? "",
              ok: event.type === "tool_end" ? event.ok : current?.ok ?? true,
            };
            const toolCalls = current ? m.toolCalls.map((call) => (call.id === event.id ? next : call)) : [...m.toolCalls, next];
            return { ...m, pendingApproval: null, toolCalls };
          }));
          break;
      }
    };
    try {
      const result = await start(onEvent, controller.signal);
      if (result === "interrupted" && acked) await loadConversation(id);
      return acked;
    } finally {
      endStream(id, controller);
      void refreshList();
    }
  }, [endStream, loadConversation, loadMemories, notify, patchMessages, refreshList, setPhase, upsertSummary]);

  const sendTo = useCallback(async (id: string, text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return false;
    if (streamsRef.current[id] && streamsRef.current[id].phase !== "analyzing") return false;
    const previous = pending.current[id];
    const requestId = previous && previous.text === trimmed ? previous.requestId : newId();
    pending.current[id] = { text: trimmed, requestId };
    setSendFailure(null);
    try {
      await runStream(id, (onEvent, signal) => chatApi.sendMessage(id, trimmed, requestId, onEvent, signal), () => {
        delete pending.current[id];
        setDrafts((all) => ({ ...all, [id]: (all[id] ?? "").trim() === trimmed ? "" : all[id] ?? "" }));
      });
      return true;
    } catch (error) {
      setSendFailure({ conversationId: id, error: toApiError(error) });
      return false;
    }
  }, [runStream]);

  const sendMessage = useCallback(async (override?: string) => {
    const key = activeId ?? NEW;
    const text = (override ?? drafts[key] ?? "").trim();
    if (!text || creating) return false;
    if (activeId) return sendTo(activeId, text);
    if (draftSubjectId) {
      const mainId = subjects.find((item) => item.id === draftSubjectId)?.mainConversationId;
      if (mainId) {
        setDrafts((all) => ({ ...all, [mainId]: text, [NEW]: "" }));
        try {
          putConversation(await chatApi.getConversation(mainId));
        } catch { /* 流式结果仍会补上这条消息 */ }
        return sendTo(mainId, text);
      }
    }
    let id = "";
    const previous = pending.current[NEW];
    const requestId = previous && previous.text === text ? previous.requestId : newId();
    pending.current[NEW] = { text, requestId };
    setSendFailure(null);
    try {
      setCreating(true);
      const conversation = await chatApi.createConversation({ clientRequestId: draftConversationKey.current });
      id = conversation.id;
      putConversation(conversation);
      setDrafts((all) => ({ ...all, [conversation.id]: text, [NEW]: "" }));
      pending.current[id] = { text, requestId };
      delete pending.current[NEW];
      setActiveId(id);
      setCreating(false);
      return await sendTo(id, text);
    } catch (error) {
      setSendFailure({ conversationId: id || null, error: toApiError(error) });
      return false;
    } finally {
      setCreating(false);
    }
  }, [activeId, creating, draftSubjectId, drafts, putConversation, sendTo, setActiveId, subjects]);

  const regenerate = useCallback(async (id: string) => {
    try {
      await runStream(id, (onEvent, signal) => chatApi.regenerate(id, onEvent, signal));
    } catch (error) {
      const apiError = toApiError(error);
      notify({ tone: "error", title: "无法重新生成", description: apiError.message });
      if (apiError.kind === "conflict") void loadConversation(id);
    }
  }, [loadConversation, notify, runStream]);

  const stop = useCallback(async (id: string) => {
    const handle = streamsRef.current[id];
    if (!handle) return;
    if (handle.phase === "connecting") {
      handle.controller.abort();
      return;
    }
    try {
      await chatApi.stop(id);
    } catch {
      // The server also stops when the stream is closed.
      handle.controller.abort();
      void loadConversation(id);
    }
  }, [loadConversation]);

  const startExerciseOn = useCallback(async (id: string | null, problemId: string) => {
    if (id && streamsRef.current[id] && streamsRef.current[id].phase !== "analyzing") {
      notify({ tone: "info", title: "请等这条回复完成", description: "或者先停止生成，再开始练习。" });
      return false;
    }
    try {
      const mainId = !id && draftSubjectId
        ? subjects.find((item) => item.id === draftSubjectId)?.mainConversationId ?? null
        : null;
      const conversation = id
        ? await chatApi.startExercise(id, problemId)
        : mainId
          ? await chatApi.startExercise(mainId, problemId)
          : await chatApi.createConversation({ problemId, clientRequestId: draftConversationKey.current });
      putConversation(conversation);
      if (!id) setActiveId(conversation.id);
      setFollows((all) => ({ ...all, [conversation.id]: (all[conversation.id] ?? 0) + 1 }));
      return true;
    } catch (error) {
      notify({ tone: "error", title: "无法开始练习", description: toApiError(error).message });
      return false;
    }
  }, [draftSubjectId, notify, putConversation, setActiveId, subjects]);

  const startExercise = useCallback(
    (problemId: string) => startExerciseOn(activeId, problemId), [activeId, startExerciseOn],
  );

  const updateConversation = useCallback(async (id: string, patch: { title?: string; subjectId?: string | null }) => {
    try {
      const { messages, ...summary } = await chatApi.updateConversation(id, patch);
      void messages;
      upsertSummary(summary);
      if (patch.subjectId !== undefined) void loadSubjects();
      return true;
    } catch (error) {
      notify({ tone: "error", title: patch.title !== undefined ? "重命名失败" : "移动失败", description: toApiError(error).message });
      return false;
    }
  }, [loadSubjects, notify, upsertSummary]);

  const renameConversation = useCallback(
    (id: string, title: string) => updateConversation(id, { title }), [updateConversation],
  );
  const moveConversation = useCallback(
    (id: string, subjectId: string | null) => updateConversation(id, { subjectId }), [updateConversation],
  );

  const createSubject = useCallback(async (input: SpaceInput & { name: string }) => {
    try {
      const subject = await chatApi.createSubject(input);
      setSubjects((items) => [...items, subject]);
      return subject;
    } catch (error) {
      notify({ tone: "error", title: "无法创建学习空间", description: toApiError(error).message });
      return null;
    }
  }, [notify]);

  const updateSubject = useCallback(async (id: string, patch: SpaceInput) => {
    try {
      const subject = await chatApi.updateSubject(id, patch);
      setSubjects((items) => items.map((item) => (item.id === id ? subject : item)));
      return true;
    } catch (error) {
      notify({ tone: "error", title: "保存失败", description: toApiError(error).message });
      return false;
    }
  }, [notify]);

  const deleteSubject = useCallback(async (id: string) => {
    try {
      await chatApi.deleteSubject(id);
      setSubjects((items) => items.filter((item) => item.id !== id));
      setConversations((items) => items.map((item) => (item.subjectId === id ? { ...item, subjectId: null } : item)));
      setMemories((items) => items.map((item) => (item.subjectId === id ? { ...item, subjectId: null } : item)));
      setDraftSubjectId((current) => (current === id ? null : current));
      return true;
    } catch (error) {
      notify({ tone: "error", title: "删除失败", description: toApiError(error).message });
      return false;
    }
  }, [notify]);

  const deleteConversation = useCallback(async (id: string) => {
    try {
      await chatApi.deleteConversation(id);
      setConversations((items) => items.filter((item) => item.id !== id));
      setThreads((all) => {
        const next = { ...all };
        delete next[id];
        return next;
      });
      setDrafts((all) => ({ ...all, [id]: "" }));
      if (activeId === id) newChat();
      void loadMemories();
      return true;
    } catch (error) {
      notify({ tone: "error", title: "删除失败", description: toApiError(error).message });
      return false;
    }
  }, [activeId, loadMemories, newChat, notify]);

  const updateMemory = useCallback(async (
    id: string, patch: { summary?: string; status?: LearnerMemoryStatus; subjectId?: string | null },
  ) => {
    try {
      const memory = await chatApi.updateMemory(id, patch);
      setMemories((items) => items.map((item) => (item.id === id ? memory : item)));
      if (patch.subjectId !== undefined) void loadSubjects();
      notify({ tone: "success", title: "已更新这条记忆" });
      return true;
    } catch (error) {
      notify({ tone: "error", title: "更新失败", description: toApiError(error).message });
      return false;
    }
  }, [loadSubjects, notify]);

  const decideTool = useCallback(async (approvalId: string, allow: boolean) => {
    setThreads((all) => {
      const next: Record<string, Thread> = {};
      for (const [key, thread] of Object.entries(all)) {
        next[key] = {
          ...thread,
          messages: thread.messages.map((message) => (
            message.pendingApproval?.id === approvalId ? { ...message, pendingApproval: null } : message
          )),
        };
      }
      return next;
    });
    try {
      await chatApi.decideTool(approvalId, allow);
    } catch (error) {
      notify({ tone: "error", title: "审批失败", description: toApiError(error).message });
    }
  }, [notify]);

  const deleteMemory = useCallback(async (id: string) => {
    try {
      await chatApi.deleteMemory(id);
      setMemories((items) => items.filter((item) => item.id !== id));
      return true;
    } catch (error) {
      const apiError = toApiError(error);
      if (apiError.kind === "not_found") {
        setMemories((items) => items.filter((item) => item.id !== id));
        return true;
      }
      notify({ tone: "error", title: "删除失败", description: apiError.message });
      return false;
    }
  }, [notify]);

  // 打开的会话里有其他页面正在生成（或刷新前中断）的回复：短轮询直到它结束
  const activeThread = activeId ? threads[activeId] : undefined;
  const waitingElsewhere = Boolean(
    activeId && !streams[activeId] && activeThread?.messages.some((message) => message.status === "streaming"),
  );
  useEffect(() => {
    if (!waitingElsewhere || !activeId) return;
    const timer = window.setTimeout(() => void loadConversation(activeId), 1500);
    return () => window.clearTimeout(timer);
  }, [waitingElsewhere, activeId, activeThread, loadConversation]);

  const activeConversation = useMemo(
    () => conversations.find((item) => item.id === activeId) ?? null,
    [conversations, activeId],
  );
  const activeStream = activeId ? streams[activeId] ?? null : null;

  return {
    subjects, loadSubjects, createSubject, updateSubject, deleteSubject, draftSubjectId, moveConversation,
    conversations, listLoading, listError, refreshList,
    activeId, activeConversation, activeThread: activeThread ?? null, restored,
    streams, activeStream, creating,
    draft: drafts[draftKey] ?? "", setDraft,
    draftFor: (id: string) => drafts[id] ?? "",
    setDraftFor: (id: string, value: string) => setDrafts((all) => ({ ...all, [id]: value })),
    streamFor: (id: string | null) => (id ? streams[id] ?? null : null),
    messagesFor: (id: string | null) => (id ? threads[id] ?? null : null),
    followNonceFor: (id: string | null) => (id ? follows[id] ?? 0 : 0),
    sendFailure, dismissSendFailure: () => setSendFailure(null),
    problems,
    memories, memoriesLoading, memoriesError, loadMemories, updateMemory, deleteMemory, decideTool,
    newChat, openConversation, loadConversation, sendMessage, sendTo, regenerate, stop, startExercise, startExerciseOn,
    renameConversation, deleteConversation,
  };
}

export type ChatController = ReturnType<typeof useChat>;

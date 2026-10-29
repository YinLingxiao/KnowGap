"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/components/LanguageProvider";
import { ApiError, toApiError } from "@/lib/api/errors";
import { chatApi } from "@/lib/chat/api";
import { parseFileMarkers } from "@/lib/chat/attachments";
import { PLAN_EVENT, type PlanEventDetail } from "@/lib/chat/plan";
import type {
  ChatMessage, Conversation, ConversationSummary, LearnerMemory, LearnerMemoryStatus, SpaceInput, StreamEvent, Subject,
} from "@/lib/chat/types";
import { MODELS_CHANGED_EVENT } from "@/lib/api/model-library";
import { API_BASE_URL } from "@/lib/config";
import { errorText } from "@/lib/i18n/errors";
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
const ACTIVE_KEY_BASE = `knowgap.chat.active.v1:${API_BASE_URL}`;
const DRAFTS_KEY_BASE = `knowgap.chat.drafts.v1:${API_BASE_URL}`;

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

export function useChat(notify: Notify, userId: string) {
  const { lang, t } = useI18n();
  const activeKey = `${userId}:${ACTIVE_KEY_BASE}`;
  const draftsKey = `${userId}:${DRAFTS_KEY_BASE}`;
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
  const [threadDispatch, setThreadDispatch] = useState<{ mainId: string; threadId: string; nonce: number } | null>(null);
  /** 空白新对话发出第一条消息时归入的 Subject（在 Subject 页里开始的对话） */
  const [draftSubjectId, setDraftSubjectId] = useState<string | null>(null);
  const [pendingModelKey, setPendingModelKey] = useState<string | null>(null);
  const [assignedModels, setAssignedModels] = useState<Record<string, string | null>>({});

  const draftConversationKey = useRef(newId());
  const pendingModelRef = useRef<string | null>(null);
  const pending = useRef<Record<string, { text: string; requestId: string }>>({});
  const streamsRef = useRef(streams);
  streamsRef.current = streams;
  const conversationsRef = useRef(conversations);
  conversationsRef.current = conversations;
  const assignedRef = useRef(assignedModels);
  assignedRef.current = assignedModels;

  /** 首页直接上传文件时预建的空对话；发送时转为正式对话，学生移除全部文件或离开首页时删除 */
  const draftConvRef = useRef<string | null>(null);
  const draftConvPromise = useRef<Promise<string | null> | null>(null);

  const discardDraftConversation = useCallback(() => {
    const id = draftConvRef.current;
    draftConvRef.current = null;
    draftConvPromise.current = null;
    if (!id) return;
    draftConversationKey.current = newId();
    setConversations((items) => items.filter((item) => item.id !== id));
    void chatApi.deleteConversation(id).catch(() => undefined);
  }, []);

  const setActiveId = useCallback((id: string | null) => {
    if (id !== draftConvRef.current) discardDraftConversation();
    if (id) {
      pendingModelRef.current = null;
      setPendingModelKey(null);
    }
    setActiveIdState(id);
    storage(() => (id ? localStorage.setItem(activeKey, id) : localStorage.removeItem(activeKey)), undefined);
  }, [activeKey, discardDraftConversation]);

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

  const modelKeyFor = useCallback((id: string | null, fallback: string | null = null) => {
    if (!id) return pendingModelKey;
    if (Object.prototype.hasOwnProperty.call(assignedModels, id)) return assignedModels[id];
    const found = conversations.find((item) => item.id === id);
    if (found) return found.modelKey;
    return fallback;
  }, [assignedModels, conversations, pendingModelKey]);

  const setConversationModel = useCallback(async (id: string | null, modelKey: string | null) => {
    if (!id) {
      pendingModelRef.current = modelKey;
      setPendingModelKey(modelKey);
      return true;
    }
    const found = conversationsRef.current.find((item) => item.id === id);
    const known = Boolean(found) || Object.prototype.hasOwnProperty.call(assignedRef.current, id);
    const current = found
      ? found.modelKey
      : Object.prototype.hasOwnProperty.call(assignedRef.current, id) ? assignedRef.current[id] : null;
    if (known && current === modelKey) return true;
    try {
      const saved = await chatApi.setConversationModel(id, modelKey);
      setAssignedModels((all) => ({ ...all, [id]: saved.modelKey }));
      setConversations((items) => items.map((item) => (item.id === id ? { ...item, modelKey: saved.modelKey } : item)));
      return true;
    } catch (error) {
      notify({ tone: "error", title: t("toast.modelSwitchFailed"), description: errorText(toApiError(error), t, lang) });
      return false;
    }
  }, [notify]);

  const applyPendingModel = useCallback(async (id: string) => {
    const key = pendingModelRef.current;
    if (!key) return;
    const ok = await setConversationModel(id, key);
    if (!ok) {
      pendingModelRef.current = null;
      setPendingModelKey(null);
    }
  }, [setConversationModel]);

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
    if (draftConvRef.current) {
      // 预建对话随之删除，草稿里指向它的文件标记也要去掉
      discardDraftConversation();
      setDrafts((all) => ({ ...all, [NEW]: parseFileMarkers(all[NEW] ?? "").body }));
    }
    draftConversationKey.current = newId();
    pendingModelRef.current = null;
    setPendingModelKey(null);
    setDraftSubjectId(subjectId);
    setSendFailure(null);
    setActiveId(null);
  }, [discardDraftConversation, setActiveId]);

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
          storage(() => localStorage.removeItem(activeKey), undefined);
          return null;
        });
        notify({ tone: "info", title: t("toast.conversationMissing"), description: t("toast.conversationMissingDesc") });
        return;
      }
      setThreads((all) => ({ ...all, [id]: { messages: all[id]?.messages ?? [], loading: false, error: apiError } }));
    }
  }, [notify, putConversation, activeKey]);

  const openConversation = useCallback((id: string) => {
    setSendFailure(null);
    setActiveId(id);
    setFollows((all) => ({ ...all, [id]: (all[id] ?? 0) + 1 }));
    void loadConversation(id);
  }, [loadConversation, setActiveId]);

  // 首次加载：题目、会话列表、记忆；恢复刷新前打开的会话
  useEffect(() => {
    setDrafts(storage(() => {
      const parsed: unknown = JSON.parse(localStorage.getItem(draftsKey) ?? "{}");
      return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
    }, {}));
    void chatApi.listProblems().then(setProblems).catch(() => setProblems([]));
    void loadMemories();
    void refreshList();
    const saved = storage(() => localStorage.getItem(activeKey), null);
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
      localStorage.setItem(draftsKey, JSON.stringify(kept));
    }, undefined);
  }, [drafts, restored, draftsKey]);

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
    let noticed = false;
    const showModelNotice = (detail: string) => {
      if (!detail || noticed) return;
      noticed = true;
      notify({ tone: "info", title: detail });
      window.dispatchEvent(new Event(MODELS_CHANGED_EVENT));
    };
    const onEvent = (event: StreamEvent) => {
      switch (event.type) {
        case "thread_dispatched":
          setThreadDispatch((previous) => ({ mainId: id, threadId: event.threadId, nonce: (previous?.nonce ?? 0) + 1 }));
          void loadConversation(event.threadId);
          void loadSubjects();
          break;
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
          if (event.modelNotice) showModelNotice(event.modelNotice);
          break;
        case "model_notice":
          showModelNotice(event.detail);
          break;
        case "delta":
          patchMessages(id, (messages) => messages.map((m) => (m.id === assistantId ? { ...m, content: m.content + event.text } : m)));
          break;
        case "file":
          patchMessages(id, (messages) => messages.map((m) => (m.id === assistantId && !m.files?.some((item) => item.id === event.file.id)
            ? { ...m, files: [...(m.files ?? []), event.file] } : m)));
          break;
        case "reasoning":
          patchMessages(id, (messages) => messages.map((m) => (m.id === assistantId ? { ...m, reasoning: (m.reasoning ?? "") + event.text } : m)));
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
          else notify({ tone: "error", title: t("toast.generateFailed"), description: event.detail });
          endStream(id, controller);
          break;
        case "analysis":
          patchMessages(id, (messages) => upsert(upsert(messages, event.userMessage), event.assistantMessage));
          void loadMemories();
          void refreshList();
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
        case "plan":
          window.dispatchEvent(new CustomEvent<PlanEventDetail>(PLAN_EVENT, { detail: { conversationId: id, plan: event.plan } }));
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
  }, [endStream, loadConversation, loadMemories, loadSubjects, notify, patchMessages, refreshList, setPhase, upsertSummary]);

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

  /** 首页上传文件前调用：返回承接文件的对话 ID（空间的主线，或新建的空对话），并发调用共用同一次创建 */
  const ensureUploadConversation = useCallback((): Promise<string | null> => {
    if (activeId) return Promise.resolve(activeId);
    const mainId = draftSubjectId ? subjects.find((item) => item.id === draftSubjectId)?.mainConversationId : null;
    if (mainId) return Promise.resolve(mainId);
    if (draftConvPromise.current) return draftConvPromise.current;
    const key = draftConversationKey.current;
    const promise = chatApi.createConversation({ clientRequestId: key, subjectId: draftSubjectId })
      .then((conversation) => {
        if (draftConversationKey.current !== key) {
          void chatApi.deleteConversation(conversation.id).catch(() => undefined);
          return null;
        }
        draftConvRef.current = conversation.id;
        return conversation.id;
      })
      .catch((error) => {
        draftConvPromise.current = null;
        throw error;
      });
    draftConvPromise.current = promise;
    return promise;
  }, [activeId, draftSubjectId, subjects]);

  const sendMessage = useCallback(async (override?: string) => {
    const key = activeId ?? NEW;
    const text = (override ?? drafts[key] ?? "").trim();
    if (!text || creating) return false;
    if (activeId) return sendTo(activeId, text);
    const draftId = draftConvRef.current;
    if (draftId) {
      draftConvRef.current = null;
      draftConvPromise.current = null;
      draftConversationKey.current = newId();
      try {
        putConversation(await chatApi.getConversation(draftId));
      } catch { /* 流式结果仍会补上这条消息 */ }
      await applyPendingModel(draftId);
      setDrafts((all) => ({ ...all, [draftId]: text, [NEW]: "" }));
      setActiveId(draftId);
      return sendTo(draftId, text);
    }
    if (draftSubjectId) {
      const mainId = subjects.find((item) => item.id === draftSubjectId)?.mainConversationId;
      if (mainId) {
        setDrafts((all) => ({ ...all, [mainId]: text, [NEW]: "" }));
        try {
          putConversation(await chatApi.getConversation(mainId));
        } catch { /* 流式结果仍会补上这条消息 */ }
        await applyPendingModel(mainId);
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
      await applyPendingModel(id);
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
  }, [activeId, applyPendingModel, creating, draftSubjectId, drafts, putConversation, sendTo, setActiveId, subjects]);

  const regenerate = useCallback(async (id: string) => {
    try {
      await runStream(id, (onEvent, signal) => chatApi.regenerate(id, onEvent, signal));
    } catch (error) {
      const apiError = toApiError(error);
      notify({ tone: "error", title: t("toast.regenerateFailed"), description: errorText(apiError, t, lang) });
      if (apiError.kind === "conflict") void loadConversation(id);
    }
  }, [loadConversation, notify, runStream]);

  const stop = useCallback(async (id: string) => {
    const handle = streamsRef.current[id];
    if (!handle) {
      try { await chatApi.stop(id); }
      catch (error) { notify({ tone: "error", title: t("toast.stopFailed"), description: errorText(toApiError(error), t, lang) }); }
      finally { void loadConversation(id); }
      return;
    }
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
  }, [loadConversation, notify]);

  const startExerciseOn = useCallback(async (id: string | null, problemId: string) => {
    if (id && streamsRef.current[id] && streamsRef.current[id].phase !== "analyzing") {
      notify({ tone: "info", title: t("toast.waitForReply"), description: t("toast.waitForReplyDesc") });
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
      if (!id) await applyPendingModel(conversation.id);
      if (!id) setActiveId(conversation.id);
      setFollows((all) => ({ ...all, [conversation.id]: (all[conversation.id] ?? 0) + 1 }));
      return true;
    } catch (error) {
      notify({ tone: "error", title: t("toast.exerciseFailed"), description: errorText(toApiError(error), t, lang) });
      return false;
    }
  }, [applyPendingModel, draftSubjectId, notify, putConversation, setActiveId, subjects]);

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
      notify({ tone: "error", title: patch.title !== undefined ? t("toast.renameFailed") : t("toast.moveFailed"), description: errorText(toApiError(error), t, lang) });
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
      notify({ tone: "error", title: t("toast.createSpaceFailed"), description: errorText(toApiError(error), t, lang) });
      return null;
    }
  }, [notify]);

  const updateSubject = useCallback(async (id: string, patch: SpaceInput) => {
    try {
      const subject = await chatApi.updateSubject(id, patch);
      setSubjects((items) => items.map((item) => (item.id === id ? subject : item)));
      return true;
    } catch (error) {
      notify({ tone: "error", title: t("toast.saveFailed"), description: errorText(toApiError(error), t, lang) });
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
      notify({ tone: "error", title: t("toast.deleteFailed"), description: errorText(toApiError(error), t, lang) });
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
      notify({ tone: "error", title: t("toast.deleteFailed"), description: errorText(toApiError(error), t, lang) });
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
      notify({ tone: "success", title: t("toast.memoryUpdated") });
      return true;
    } catch (error) {
      notify({ tone: "error", title: t("toast.memoryUpdateFailed"), description: errorText(toApiError(error), t, lang) });
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
      notify({ tone: "error", title: t("toast.approvalFailed"), description: errorText(toApiError(error), t, lang) });
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
      notify({ tone: "error", title: t("toast.deleteFailed"), description: errorText(apiError, t, lang) });
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
    subjects, loadSubjects, createSubject, updateSubject, deleteSubject, draftSubjectId, moveConversation, threadDispatch,
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
    pendingModelKey, modelKeyFor, setConversationModel,
    newChat, ensureUploadConversation, discardDraftConversation, openConversation, loadConversation, sendMessage, sendTo, regenerate, stop, startExercise, startExerciseOn,
    renameConversation, deleteConversation,
  };
}

export type ChatController = ReturnType<typeof useChat>;

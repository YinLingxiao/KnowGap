/**
 * 微测作答的前端缓存：每个会话首次用到时拉一次已作答记录，提交后写回缓存并通知订阅的题卡。
 * 判分只在服务端；这里不保存答案，只保存服务端返回的结果。
 */
import { chatApi } from "./api";
import type { QuizAttemptResult } from "./types";

type Attempts = Record<string, QuizAttemptResult>;

const cache = new Map<string, Attempts>();
const loading = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();

const notify = () => listeners.forEach((listener) => listener());

export function subscribeQuizAttempts(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function cachedQuizAttempt(conversationId: string | null, quizId: string): QuizAttemptResult | null {
  return (conversationId && cache.get(conversationId)?.[quizId]) || null;
}

/** 同一会话只拉一次；失败不缓存，下次挂载再试 */
export function loadQuizAttempts(conversationId: string): Promise<void> {
  if (cache.has(conversationId)) return Promise.resolve();
  const pending = loading.get(conversationId);
  if (pending) return pending;
  const request = chatApi.listQuizAttempts(conversationId)
    .then((attempts) => {
      cache.set(conversationId, { ...attempts, ...cache.get(conversationId) });
      notify();
    })
    .catch(() => { /* 恢复失败时题卡按未作答显示，提交时服务端仍会返回已有结果 */ })
    .finally(() => loading.delete(conversationId));
  loading.set(conversationId, request);
  return request;
}

export async function submitQuizAttempt(
  conversationId: string | null, quizId: string, actionId: string, optionIndex: number,
): Promise<QuizAttemptResult> {
  const result = await chatApi.submitQuizAttempt(quizId, { actionId, optionIndex });
  if (conversationId) {
    cache.set(conversationId, { ...cache.get(conversationId), [quizId]: result });
    notify();
  }
  return result;
}

/**
 * 代码实验台运行记录的前端缓存：每个会话首次用到时拉一次各实验台最近的运行，
 * 用来在刷新、切换对话后恢复学生写的代码；每次运行后上报并写回缓存。
 */
import { chatApi, type PlaygroundRun } from "./api";

type Runs = Record<string, PlaygroundRun>;

const cache = new Map<string, Runs>();
const loading = new Map<string, Promise<void>>();

export function cachedPlaygroundRun(conversationId: string | null, playgroundId: string): PlaygroundRun | null {
  return (conversationId && cache.get(conversationId)?.[playgroundId]) || null;
}

/** 同一会话只拉一次；失败不缓存，下次挂载再试 */
export function loadPlaygroundRuns(conversationId: string): Promise<void> {
  if (cache.has(conversationId)) return Promise.resolve();
  const pending = loading.get(conversationId);
  if (pending) return pending;
  const request = chatApi.listPlaygroundRuns(conversationId)
    .then((runs) => {
      cache.set(conversationId, { ...runs, ...cache.get(conversationId) });
    })
    .catch(() => { /* 恢复失败时从脚手架开始，不影响运行 */ })
    .finally(() => loading.delete(conversationId));
  loading.set(conversationId, request);
  return request;
}

/** 上报失败不打扰学生：运行结果照常显示，只是这一次 AI 看不到 */
export async function reportPlaygroundRun(
  conversationId: string | null, playgroundId: string, report: object,
): Promise<PlaygroundRun | null> {
  try {
    const run = await chatApi.reportPlaygroundRun(playgroundId, report);
    if (conversationId) cache.set(conversationId, { ...cache.get(conversationId), [playgroundId]: run });
    return run;
  } catch {
    return null;
  }
}

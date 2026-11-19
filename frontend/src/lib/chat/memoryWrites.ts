import type { MemoryWriteItem } from "./types";

/**
 * 后端尚未在消息接口返回 memory_writes 时的本地过渡。
 * 只按会话 + 回复保存，刷新后仍能显示；跨设备、清缓存或换浏览器后失效。
 */
const PREFIX = "knowgap.memory-writes.v1";
const REVOKED_PREFIX = "knowgap.memory-writes-revoked.v1";

export function memoryWritesKey(conversationId: string, messageId: string): string {
  return `${PREFIX}:${conversationId}:${messageId}`;
}

function revokedKey(conversationId: string, messageId: string): string {
  return `${REVOKED_PREFIX}:${conversationId}:${messageId}`;
}

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function sanitize(value: unknown): MemoryWriteItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): MemoryWriteItem[] => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    if (typeof record.id !== "string" || !record.id) return [];
    return [{
      id: record.id,
      layer: record.layer === "MEMORY" ? "MEMORY" : "USER",
      content: typeof record.content === "string" ? record.content : "",
    }];
  });
}

export function readMemoryWrites(conversationId: string, messageId: string): MemoryWriteItem[] {
  const target = storage();
  if (!target) return [];
  try {
    const raw = target.getItem(memoryWritesKey(conversationId, messageId));
    return raw ? sanitize(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

export function storeMemoryWrites(conversationId: string, messageId: string, items: MemoryWriteItem[]): void {
  const target = storage();
  if (!target) return;
  try {
    if (!items.length) {
      target.removeItem(memoryWritesKey(conversationId, messageId));
      return;
    }
    target.setItem(memoryWritesKey(conversationId, messageId), JSON.stringify(sanitize(items)));
  } catch {
    // Private mode / quota: the in-memory view still works for this visit.
  }
}

export function clearMemoryWrites(conversationId: string, messageId: string): void {
  storeMemoryWrites(conversationId, messageId, []);
}

/** 后端撤销接口尚未把所有已撤销条目从历史消息里剔除；本地记住 id，避免刷新后回显 */
export function readRevokedMemoryWrites(conversationId: string, messageId: string): string[] {
  const target = storage();
  if (!target) return [];
  try {
    const parsed: unknown = JSON.parse(target.getItem(revokedKey(conversationId, messageId)) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string" && Boolean(id)) : [];
  } catch {
    return [];
  }
}

export function rememberRevokedMemoryWrite(conversationId: string, messageId: string, noteId: string): void {
  const target = storage();
  if (!target) return;
  try {
    const ids = readRevokedMemoryWrites(conversationId, messageId);
    if (!ids.includes(noteId)) ids.push(noteId);
    target.setItem(revokedKey(conversationId, messageId), JSON.stringify(ids));
  } catch {
    // The current view still hides the item; only reload persistence is lost.
  }
}

export function withoutRevokedMemoryWrites(
  conversationId: string, messageId: string, items: MemoryWriteItem[],
): MemoryWriteItem[] {
  const revoked = readRevokedMemoryWrites(conversationId, messageId);
  return revoked.length ? items.filter((item) => !revoked.includes(item.id)) : items;
}
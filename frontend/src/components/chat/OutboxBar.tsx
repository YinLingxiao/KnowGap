"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { chatApi, type Outbox } from "@/lib/chat/api";
import { toApiError } from "@/lib/api/errors";
import { useI18n } from "@/components/LanguageProvider";
import styles from "./OutboxBar.module.css";

/** The server owns ordering and dispatch. This view only edits saved pending inputs. */
export function OutboxBar({ conversationId }: { conversationId?: string | null }) {
  const { tx } = useI18n();
  const [queue, setQueue] = useState<Outbox>({ paused: false, items: [] });
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const ids = useRef<string[] | null>(null);
  const version = useRef(0);
  const owner = useRef(conversationId);
  owner.current = conversationId;
  const apply = useCallback((value: Outbox, cid: string) => {
    if (owner.current !== cid) return;
    if (ids.current?.some((id) => !value.items.some((item) => item.id === id))) {
      window.dispatchEvent(new CustomEvent("knowgap:outbox-dispatched", { detail: { conversationId: cid } }));
    }
    ids.current = value.items.map((item) => item.id);
    setQueue(value);
    setError("");
  }, []);
  const refresh = useCallback(() => {
    if (!conversationId) return;
    const request = ++version.current;
    void chatApi.outbox(conversationId).then((value) => {
      if (request === version.current) apply(value, conversationId);
    }).catch((error) => {
      if (request === version.current && owner.current === conversationId) setError(toApiError(error).message);
    });
  }, [apply, conversationId]);
  useEffect(() => {
    ids.current = null;
    setQueue({ paused: false, items: [] });
    setEditing(null);
    setBusy(false);
    setError("");
    refresh();
    const update = (event: Event) => {
      if ((event as CustomEvent).detail?.conversationId === conversationId) refresh();
    };
    window.addEventListener("knowgap:outbox-updated", update);
    window.addEventListener("focus", refresh);
    return () => {
      window.removeEventListener("knowgap:outbox-updated", update);
      window.removeEventListener("focus", refresh);
    };
  }, [conversationId, refresh]);
  useEffect(() => {
    // Poll only while something is queued; new items announce themselves via knowgap:outbox-updated.
    if (!conversationId || busy || !queue.items.length) return;
    const timer = window.setInterval(refresh, 1500);
    return () => window.clearInterval(timer);
  }, [busy, conversationId, queue.items.length, refresh]);
  const mutate = async (operation: (cid: string) => Promise<Outbox>) => {
    if (!conversationId || busy) return;
    const cid = conversationId;
    setBusy(true);
    ++version.current;
    try {
      const value = await operation(cid);
      if (owner.current === cid) { ++version.current; apply(value, cid); setEditing(null); }
    }
    catch (error) { if (owner.current === cid) { setError(toApiError(error).message); refresh(); } }
    finally { if (owner.current === cid) setBusy(false); }
  };
  if (!conversationId || (!queue.items.length && !error)) return null;
  return <section className={styles.bar} aria-label={tx("待发送消息")}>
    {queue.items.length > 0 && <header>
      <span>{queue.paused ? tx("待发送已暂停") : tx("回复完成后依次发送")} · {queue.items.length}</span>
      {queue.paused && <button disabled={busy} onClick={() => void mutate(chatApi.resumeQueue)}>{tx("继续发送")}</button>}
    </header>}
    <ol>{queue.items.map((item) => <li key={item.id}>
      {editing === item.id ? <form onSubmit={(event) => {
        event.preventDefault();
        if (text.trim()) void mutate((cid) => chatApi.editQueued(cid, item.id, text.trim()));
      }}>
        <textarea aria-label={tx("修改待发送内容")} value={text} onChange={(event) => setText(event.target.value)} autoFocus />
        <button disabled={busy || !text.trim()}>{tx("保存")}</button>
        <button type="button" disabled={busy} onClick={() => setEditing(null)}>{tx("取消")}</button>
      </form> : <>
        <span className={styles.preview}>{item.content}</span>
        <button disabled={busy} onClick={() => { setEditing(item.id); setText(item.content); }}>{tx("修改")}</button>
        <button disabled={busy} onClick={() => void mutate((cid) => chatApi.removeQueued(cid, item.id))}>{tx("撤回")}</button>
      </>}
    </li>)}</ol>
    {error && <p role="alert">{error} <button onClick={refresh}>{tx("重试")}</button></p>}
  </section>;
}

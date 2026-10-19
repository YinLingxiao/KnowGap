"use client";

import { useRef, useState } from "react";
import { ArrowUpRight, Check, Play } from "lucide-react";
import { toApiError } from "@/lib/api/errors";
import type { ThreadProposal } from "@/lib/chat/types";
import styles from "./ThreadProposals.module.css";

export function ThreadProposals({ proposals, disabled, onConfirm, onOpen }: {
  proposals: ThreadProposal[];
  disabled: boolean;
  onConfirm?: (proposalId: string) => Promise<string>;
  onOpen?: (threadId: string) => void;
}) {
  const inFlight = useRef(new Set<string>());
  const [pending, setPending] = useState<string[]>([]);
  const [confirmed, setConfirmed] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const confirm = async (id: string) => {
    if (!onConfirm || inFlight.current.has(id)) return;
    inFlight.current.add(id);
    setPending([...inFlight.current]);
    setErrors((prev) => ({ ...prev, [id]: "" }));
    try {
      const threadId = await onConfirm(id);
      setConfirmed((prev) => ({ ...prev, [id]: threadId }));
      onOpen?.(threadId);
    } catch (error) {
      setErrors((prev) => ({ ...prev, [id]: toApiError(error).message }));
    } finally {
      inFlight.current.delete(id);
      setPending([...inFlight.current]);
    }
  };
  return (
    <section className={styles.proposals} aria-label="建议的学习任务">
      <header>建议的学习任务<span>确认后开始执行</span></header>
      <ul>
        {proposals.map((p) => {
          const threadId = confirmed[p.id] ?? p.threadId;
          const busy = pending.includes(p.id);
          return (
            <li key={p.id}>
              <div className={styles.body}>
                <strong>{p.title}</strong>
                <p>{p.task}</p>
                {p.reason && <small>{p.reason}</small>}
                {errors[p.id] && <p className={styles.error} role="alert">{errors[p.id]}</p>}
              </div>
              <button
                className={threadId ? styles.open : styles.start}
                disabled={threadId ? !onOpen : disabled || busy || !onConfirm}
                aria-busy={busy || undefined}
                onClick={() => threadId ? onOpen?.(threadId) : void confirm(p.id)}
              >
                {threadId ? <Check size={12} aria-hidden /> : <Play size={11} aria-hidden />}
                {threadId ? "查看 Thread" : busy ? "开启中…" : errors[p.id] ? "重试" : "开启 Thread"}
                {threadId && <ArrowUpRight size={12} aria-hidden />}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

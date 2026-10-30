"use client";

import { useRef, useState } from "react";
import { ArrowUpRight, Check, Play } from "lucide-react";
import { useI18n } from "@/components/LanguageProvider";
import { toApiError } from "@/lib/api/errors";
import type { ThreadProposal } from "@/lib/chat/types";
import styles from "./ThreadProposals.module.css";

export function ThreadProposals({ proposals, disabled, onConfirm, onOpen }: {
  proposals: ThreadProposal[];
  disabled: boolean;
  onConfirm?: (proposalId: string) => Promise<string>;
  onOpen?: (threadId: string) => void;
}) {
  const { tx } = useI18n();
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
    <section className={styles.proposals} aria-label={tx("建议的学习任务")}>
      <header>{tx("建议的学习任务")}<span>{tx("确认后开始执行")}</span></header>
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
                {threadId ? tx("查看支线") : busy ? tx("开启中…") : errors[p.id] ? tx("重试") : tx("开启支线")}
                {threadId && <ArrowUpRight size={12} aria-hidden />}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

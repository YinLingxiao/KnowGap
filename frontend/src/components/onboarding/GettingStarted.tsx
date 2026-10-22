"use client";

import { useEffect, useState } from "react";
import { Check, ChevronDown, X } from "lucide-react";
import { chatApi } from "@/lib/chat/api";
import { cx } from "@/lib/cx";
import {
  CHEATSHEET_OPENED_EVENT, GUIDES_RESET_EVENT, checklistDismissKey, checklistDoneKey, cheatsheetSeenKey,
} from "./coach";
import styles from "./GettingStarted.module.css";

interface GettingStartedProps {
  userId: string;
  hasSpace: boolean;
  onCreateSpace: () => void;
  onExplain: () => void;
  onQuiz: () => void;
  onSchedule: () => void;
  onFocus: () => void;
  onSheet: () => void;
}

const ITEMS = [
  ["space", "建一个学习空间", "onCreateSpace"],
  ["explained", "讲懂一个概念", "onExplain"],
  ["answered", "答对一道小题", "onQuiz"],
  ["scheduled", "让 AI 排一次复习", "onSchedule"],
  ["focused", "完成一次专注", "onFocus"],
  ["sheet", "打开考前一页纸", "onSheet"],
] as const;

export function GettingStarted(props: GettingStartedProps) {
  const { userId } = props;
  const [flags, setFlags] = useState({ explained: false, answered: false, scheduled: false, focused: false });
  const [sheet, setSheet] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [celebrating, setCelebrating] = useState(false);
  const [open, setOpen] = useState(true);

  const readLocal = () => {
    setHidden(localStorage.getItem(checklistDismissKey(userId)) === "1" || localStorage.getItem(checklistDoneKey(userId)) === "1");
    setSheet(localStorage.getItem(cheatsheetSeenKey(userId)) === "1");
  };

  useEffect(() => {
    readLocal();
    let live = true;
    const load = () => {
      chatApi.checklist().then((next) => { if (live) setFlags(next); }).catch(() => undefined);
    };
    load();
    const onReset = () => { readLocal(); load(); };
    const onSheet = () => {
      localStorage.setItem(cheatsheetSeenKey(userId), "1");
      setSheet(true);
    };
    window.addEventListener(GUIDES_RESET_EVENT, onReset);
    window.addEventListener(CHEATSHEET_OPENED_EVENT, onSheet);
    return () => {
      live = false;
      window.removeEventListener(GUIDES_RESET_EVENT, onReset);
      window.removeEventListener(CHEATSHEET_OPENED_EVENT, onSheet);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload when the signed-in user changes
  }, [userId]);

  const done = {
    space: props.hasSpace,
    explained: flags.explained,
    answered: flags.answered,
    scheduled: flags.scheduled,
    focused: flags.focused,
    sheet,
  };
  const allDone = ITEMS.every(([key]) => done[key]);

  useEffect(() => {
    if (allDone && !hidden) setCelebrating(true);
  }, [allDone, hidden]);

  if (hidden) return null;

  if (celebrating) {
    return (
      <section className={styles.done} role="status">
        <p>六件事都做完了</p>
        <button
          type="button"
          onClick={() => {
            localStorage.setItem(checklistDoneKey(userId), "1");
            setHidden(true);
          }}
        >
          知道了
        </button>
      </section>
    );
  }

  const actions = {
    onCreateSpace: props.onCreateSpace,
    onExplain: props.onExplain,
    onQuiz: props.onQuiz,
    onSchedule: props.onSchedule,
    onFocus: props.onFocus,
    onSheet: props.onSheet,
  };

  return (
    <section className={styles.card}>
      <header>
        <button type="button" className={styles.toggle} aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          <ChevronDown size={14} className={cx(!open && styles.shut)} aria-hidden />
          上手清单
        </button>
        <button
          type="button"
          className={styles.close}
          aria-label="关闭上手清单"
          onClick={() => {
            localStorage.setItem(checklistDismissKey(userId), "1");
            setHidden(true);
          }}
        >
          <X size={14} />
        </button>
      </header>
      {open && (
        <ul>
          {ITEMS.map(([key, label, action]) => (
            <li key={key}>
              <button type="button" onClick={actions[action]} disabled={done[key]}>
                <span className={cx(styles.box, done[key] && styles.boxOn)} aria-hidden>
                  {done[key] && <Check size={12} />}
                </span>
                {label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

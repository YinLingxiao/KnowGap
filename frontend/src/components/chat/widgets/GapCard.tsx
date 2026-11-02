"use client";

import { useContext, useState } from "react";
import { MessageSquarePlus } from "lucide-react";
import { useI18n } from "@/components/LanguageProvider";
import { chatApi } from "@/lib/chat/api";
import { WidgetLiveContext } from "../LearningWidget";
import styles from "../LearningWidget.module.css";
import { STATUS_KEY } from "../MemoryDrawer";
import gap from "./GapCard.module.css";
import { MEMORY_CHANGED_EVENT, useMemoriesById } from "./memoryContext";
import { sendOrAsk, useWidgetScope } from "./widgetEvents";

/** 缺口卡：展示一条误区记忆及证据，可一键出题验证，或标记判断不准确 */
export function GapCard({ data }: { data: Record<string, unknown> }) {
  const { tx, t } = useI18n();
  const scope = useWidgetScope();
  const live = useContext(WidgetLiveContext);
  const memories = useMemoriesById();
  const [state, setState] = useState<"idle" | "working" | "done" | "failed">("idle");
  const memoryId = typeof data.memoryId === "string" ? data.memoryId : "";
  const note = typeof data.note === "string" ? data.note.trim() : "";
  const memory = memories[memoryId];

  if (live && !memory) {
    return (
      <section className={styles.widgetCard} aria-label={tx("学习缺口")} aria-busy>
        <div className={gap.skeleton}><span /><span /><span /></div>
      </section>
    );
  }
  if (!memory) {
    return (
      <section className={styles.widgetCard} aria-label={tx("学习缺口")}>
        <p className={gap.muted}>{tx("这条学习记录已删除或不可见")}</p>
      </section>
    );
  }

  const evidence = memory.evidence.slice(-2).reverse();
  const markInaccurate = async () => {
    setState("working");
    try {
      // 与记忆面板的纠正走同一接口：改回「待确认」，服务端会记为用户已纠正
      await chatApi.updateMemory(memory.id, { status: "suspected" });
      setState("done");
      window.dispatchEvent(new Event(MEMORY_CHANGED_EVENT));
    } catch {
      setState("failed");
    }
  };

  return (
    <section className={styles.widgetCard} aria-label={tx("学习缺口")}>
      <div className={gap.body}>
        <div className={gap.head}>
          <span className={gap.topic}>{memory.topic}</span>
          <span className={gap.status}>{t(STATUS_KEY[memory.status])}</span>
        </div>
        <p className={gap.summary}>{memory.summary}</p>
        {evidence.length > 0 && (
          <ul className={gap.evidence}>
            {evidence.map((item, index) => (
              <li key={`${item.messageId}-${index}`}>
                <span className={gap.source}>{item.source === "quiz_attempt" ? tx("作答") : tx("原话")}</span>
                <span>{item.quote || item.reason}</span>
              </li>
            ))}
          </ul>
        )}
        {note && <p className={gap.note}>{note}</p>}
        {state === "done" ? (
          <p className={gap.muted}>{tx("已标记为不准确")}</p>
        ) : (
          <div className={gap.actions}>
            <button
              type="button"
              className={styles.askAiBtn}
              onClick={() => sendOrAsk(scope, tx("请针对「{topic}」出一道随堂微测题，检验我是否已经弄清楚。", { topic: memory.topic }))}
            >
              <MessageSquarePlus size={12} aria-hidden />
              <span>{tx("做一道题验证")}</span>
            </button>
            <button type="button" className={gap.ghost} disabled={state === "working"} onClick={() => void markInaccurate()}>
              {state === "failed" ? tx("标记失败，点此重试") : tx("这个判断不准确")}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

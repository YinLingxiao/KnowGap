"use client";

import { useEffect, useRef, useState } from "react";
import { MessageList } from "@/components/chat/MessageList";
import { applyAppearance, type ChatWidth } from "@/lib/appearance";
import type { ChatMessage } from "@/lib/chat/types";

const THOUGHT = "学生问的是栈和队列的区别。先确认他已经知道线性表，再从「进出规则」讲起：栈后进先出，队列先进先出。"
  + "举一个生活里的例子比纯定义更容易记住——叠盘子和排队买票。最后留一道小题检查是否真的理解。";
const ANSWER = "栈和队列都是**线性表**，区别只在「从哪里进、从哪里出」：\n\n"
  + "- **栈**：只在一端（栈顶）进出，后进先出（LIFO），像一摞盘子。\n"
  + "- **队列**：一端进、另一端出，先进先出（FIFO），像排队买票。\n\n"
  + "考你一道：依次入栈 1、2、3，再出栈一次，得到的是几？如果换成队列呢？";

function message(patch: Partial<ChatMessage>): ChatMessage {
  return { id: "stream-preview", conversationId: "preview-streaming", seq: 2, role: "assistant", kind: "text",
    content: "", status: "streaming", error: null, replyTo: null, problemId: null, attempt: null, memoryChanges: [],
    usedMemoryIds: [], suggestedProblemId: null, sources: [], truncated: false, toolCalls: [], pendingApproval: null,
    preferencePrompt: null, nextActions: [], threadSummary: null, createdAt: "", ...patch };
}

const WIDTHS: Array<[ChatWidth, string]> = [["narrow", "紧凑"], ["medium", "标准"], ["wide", "宽屏"], ["full", "全宽"]];

export default function StreamingPreview() {
  const [ready, setReady] = useState(false);
  const [reasoning, setReasoning] = useState("");
  const [content, setContent] = useState("");
  const [status, setStatus] = useState<"streaming" | "complete">("complete");
  const [waiting, setWaiting] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => { setReady(true); return () => { if (timer.current) window.clearInterval(timer.current); }; }, []);
  if (process.env.NODE_ENV !== "development") return <p>此预览仅在开发环境可用。</p>;
  if (!ready) return <p>正在准备…</p>;

  const run = () => {
    if (timer.current) window.clearInterval(timer.current);
    setReasoning(""); setContent(""); setStatus("streaming"); setWaiting(false);
    let step = 0;
    // 模拟服务端：思考 → 正文，每次送来 2~7 个字，间隔不规则
    timer.current = window.setInterval(() => {
      step += 1;
      const thinking = step * 5 <= THOUGHT.length;
      if (thinking) setReasoning(THOUGHT.slice(0, step * 5));
      else {
        const done = Math.min(ANSWER.length, (step - Math.ceil(THOUGHT.length / 5)) * (2 + (step % 6)));
        setContent(ANSWER.slice(0, done));
        if (done >= ANSWER.length) { setStatus("complete"); if (timer.current) window.clearInterval(timer.current); }
      }
    }, 90);
  };
  const user: ChatMessage = message({ id: "u1", seq: 1, role: "user", content: "栈和队列有什么区别？", status: "complete" });
  const reply = reasoning || content || waiting ? message({ reasoning, content, status }) : null;
  const button = { padding: "6px 10px", border: "1px solid var(--border-strong)", borderRadius: "var(--radius-sm)",
    color: "var(--text-secondary)", background: "var(--bg-elevated)", fontSize: 12 };
  return <main style={{ height: "100dvh", display: "flex", flexDirection: "column", background: "var(--bg)", color: "var(--text)" }}>
    <header style={{ display: "flex", gap: 8, flexWrap: "wrap", padding: 12, borderBottom: "1px solid var(--border)" }}>
      <button style={button} onClick={run}>模拟一次生成</button>
      <button style={button} onClick={() => { if (timer.current) window.clearInterval(timer.current); setReasoning(""); setContent(""); setStatus("streaming"); setWaiting(true); }}>只看等待状态</button>
      {WIDTHS.map(([width, label]) => (
        <button key={width} style={button} onClick={() => applyAppearance({ textSize: "medium", width, motion: "system" })}>{label}</button>
      ))}
    </header>
    <MessageList conversationId="preview-streaming" messages={reply ? [user, reply] : [user]} problems={{}}
      memoriesById={{}} conversationSubjectId={null} subjectNames={{}} phase={status === "streaming" ? "streaming" : null}
      followNonce={content.length + reasoning.length} onRegenerate={() => undefined}
      onStartExercise={() => undefined} onOpenMemories={() => undefined} />
  </main>;
}

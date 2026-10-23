"use client";

import { useEffect, useState } from "react";
import { MessageList } from "@/components/chat/MessageList";
import type { ChatMessage } from "@/lib/chat/types";

function message(id: string, patch: Partial<ChatMessage>): ChatMessage {
  return { id, conversationId: "preview-thread-merge", seq: 1, role: "assistant", kind: "text",
    content: "", status: "complete", error: null, replyTo: null, problemId: null, attempt: null,
    memoryChanges: [], usedMemoryIds: [], suggestedProblemId: null, sources: [], truncated: false,
    toolCalls: [], pendingApproval: null, preferencePrompt: null, nextActions: [], threadSummary: null,
    createdAt: "", ...patch };
}

const messages = [
  message("question", { role: "user", content: "我不懂这道题，KMP算法是什么，这道题应该怎么做" }),
  message("reply", { content: "好的，开始讲解这道题。" }),
  message("merged", { threadSummary: { threadId: "kmp", title: "KMP算法与next数组",
    summary: "这段总结应保留在数据中，不显示在主线。", takeaways: ["要点也不显示。"], memoryIds: [] } }),
  message("long-name", { threadSummary: { threadId: "array", title: "顺序表：存储、随机访问与插入删除代价，以及位置与下标的换算",
    summary: "长名称也只占一行。", takeaways: [], memoryIds: [] } }),
];

export default function ThreadMergePreview() {
  const [ready, setReady] = useState(false);
  const [opened, setOpened] = useState<string | null>(null);
  useEffect(() => { setReady(true); }, []);
  if (process.env.NODE_ENV !== "development") return <p>此预览仅在开发环境可用。</p>;
  if (!ready) return <p>正在准备…</p>;
  return (
    <main style={{ height: "100dvh", display: "flex", flexDirection: "column", background: "var(--bg)", color: "var(--text)" }}>
      <header style={{ padding: 16, borderBottom: "1px solid var(--border)", fontSize: 13 }}>
        支线合并预览（开发用）
        <p role="status">{opened ? `已打开支线：${opened}` : "点击名称可查看原支线。"}</p>
      </header>
      <MessageList conversationId="preview-thread-merge" messages={messages} problems={{}} memoriesById={{}}
        conversationSubjectId={null} subjectNames={{}} phase={null} followNonce={0}
        onRegenerate={() => undefined} onStartExercise={() => undefined} onOpenMemories={() => undefined}
        onOpenSummary={setOpened} />
    </main>
  );
}

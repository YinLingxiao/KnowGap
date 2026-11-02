"use client";

import { useCallback, useState } from "react";
import { Composer } from "@/components/chat/Composer";
import { MessageList } from "@/components/chat/MessageList";
import { useChat, type Notify } from "@/hooks/useChat";

/** Development-only acceptance view using the real chat controller and components. */
export default function StreamingPreview() {
  if (process.env.NODE_ENV !== "development") return <p>此预览仅在开发环境可用。</p>;
  return <StreamingPreviewBody />;
}

function StreamingPreviewBody() {
  const [notice, setNotice] = useState("");
  const notify: Notify = useCallback((toast) => setNotice([toast.title, toast.description].filter(Boolean).join("：")), []);
  const chat = useChat(notify, "streaming-preview");
  return <main style={{ height: "100dvh", display: "flex", flexDirection: "column", maxWidth: 1100, margin: "0 auto", padding: "20px 16px" }}>
    <header style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap", paddingBottom: 14 }}>
      <strong>KnowGap · 流式交互验收</strong>
      <button onClick={() => chat.setDraft("用生活中的例子解释栈，详细展示操作步骤。")}>填入测试问题</button>
      <button onClick={() => chat.newChat()}>新建对话</button>
      <span style={{ color: "var(--text-secondary)", fontSize: 12 }}>请连接本地模拟后端，不消耗 API 额度</span>
    </header>
    <nav style={{ display: "flex", gap: 12, overflowX: "auto", paddingBottom: 10 }} aria-label="测试对话">
      {chat.conversations.map((conversation) => <button key={conversation.id} onClick={() => chat.openConversation(conversation.id)}>{conversation.title}</button>)}
    </nav>
    {notice && <p role="status">{notice}</p>}
    {chat.activeId ? <MessageList conversationId={chat.activeId} messages={chat.activeThread?.messages ?? []}
      problems={{}} memoriesById={{}} conversationSubjectId={null} subjectNames={{}}
      phase={chat.activeStream?.phase ?? null} followNonce={chat.followNonceFor(chat.activeId)}
      onRegenerate={() => void chat.regenerate(chat.activeId!)} onStartExercise={() => {}} onOpenMemories={() => {}}
      onDecideTool={(id, allow) => void chat.decideTool(id, allow)} onSendText={(text) => chat.sendTo(chat.activeId!, text)} />
      : <div style={{ flex: 1, display: "grid", placeItems: "center", color: "var(--text-secondary)" }}>发送问题后，可测试排队、修改要求、滚动阅读和刷新恢复。</div>}
    {chat.sendFailure && <p role="alert">{chat.sendFailure.error.message}</p>}
    <Composer conversationId={chat.activeId} value={chat.draft} onChange={chat.setDraft}
      messages={chat.activeThread?.messages} onSend={() => void chat.sendMessage()}
      onStop={() => { if (chat.activeId) void chat.stop(chat.activeId); }}
      onRevise={() => chat.activeId ? chat.reviseTo(chat.activeId, chat.draft) : undefined}
      phase={chat.activeStream?.phase ?? null} busy={chat.creating} autoFocusKey={chat.activeId ?? "new"} />
  </main>;
}

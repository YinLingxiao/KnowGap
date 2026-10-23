"use client";

import { useEffect, useState } from "react";
import { Composer } from "@/components/chat/Composer";
import { FileCard, rememberFile, scaleOf } from "@/components/chat/FileCard";
import { MessageList } from "@/components/chat/MessageList";
import { formatFileMarker, type FileAttachment } from "@/lib/chat/attachments";
import type { ChatMessage } from "@/lib/chat/types";

const slides: FileAttachment = { id: "doc-preview-slides", name: "第3章 进程调度.pptx", kind: "pptx",
  units: 24, unitLabel: "张幻灯片", chars: 18342, outline: [], subjectId: null,
  notes: ["第 4 张幻灯片含图片（共 1 张），图片里的文字没有读取。"] };
const table: FileAttachment = { ...slides, id: "doc-preview-table", name: "实验数据.xlsx", kind: "xlsx", units: 3, unitLabel: "个工作表" };

function userMessage(content: string): ChatMessage {
  return { id: `preview-${Date.now()}`, conversationId: "preview-attachments", seq: 1, role: "user", kind: "text",
    content, status: "complete", error: null, replyTo: null, problemId: null, attempt: null, memoryChanges: [],
    usedMemoryIds: [], suggestedProblemId: null, sources: [], truncated: false, toolCalls: [], pendingApproval: null,
    preferencePrompt: null, nextActions: [], threadSummary: null, createdAt: "" };
}

export default function AttachmentsPreview() {
  const [ready, setReady] = useState(false);
  const [draft, setDraft] = useState(`${formatFileMarker(slides)}\n`);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [removed, setRemoved] = useState<string[]>([]);
  const [home, setHome] = useState(false);
  useEffect(() => {
    if (process.env.NODE_ENV !== "development") return;
    rememberFile(slides); rememberFile(table);
    setMessages([userMessage(`${formatFileMarker(slides)}\n帮我精读这份课件，挑出难点`)]);
    setReady(true);
  }, []);
  if (process.env.NODE_ENV !== "development") return <p>此预览仅在开发环境可用。</p>;
  if (!ready) return <p>正在准备文件附件预览…</p>;
  const buttonStyle = { padding: "6px 10px", border: "1px solid var(--border-strong)", borderRadius: "var(--radius-sm)",
    color: "var(--text-secondary)", background: "var(--bg-elevated)", fontSize: 12 };
  return <main style={{ minHeight: "100dvh", padding: "32px 20px", background: "var(--bg)", color: "var(--text)" }}>
    <div style={{ maxWidth: 900, margin: "0 auto", display: "grid", gap: 24 }}>
      <header style={{ display: "grid", gap: 8 }}>
        <h1 style={{ fontSize: 22, fontWeight: 600 }}>附件预览（开发用）</h1>
        <p style={{ color: "var(--text-secondary)", fontSize: 13 }}>附件卡片、快捷意图和消息中文件卡片的各种状态。</p>
      </header>
      <section aria-label="附件状态" style={{ display: "grid", gap: 10 }}>
        <h2 style={{ fontSize: 14, fontWeight: 500 }}>上传与解析状态</h2>
        <div role="list" style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {!removed.includes("loading") && <FileCard name="实验报告.docx" state="uploading" onRemove={() => setRemoved([...removed, "loading"])} />}
          {!removed.includes("ready") && <FileCard name={slides.name} kind={slides.kind} scale={scaleOf(slides)} onRemove={() => setRemoved([...removed, "ready"])} />}
          {!removed.includes("error") && <FileCard name="扫描讲义.pdf" state="error" error="这份 PDF 是扫描图片，暂不支持识别文字" onRemove={() => setRemoved([...removed, "error"])} />}
        </div>
      </section>
      <section aria-label="消息中的文件卡片" style={{ display: "flex", flexDirection: "column", minHeight: 190, maxHeight: 300 }}>
        <h2 style={{ fontSize: 14, fontWeight: 500 }}>对话中的资料</h2>
        <MessageList conversationId="preview-attachments" messages={messages} problems={{}} memoriesById={{}}
          conversationSubjectId={null} subjectNames={{}} phase="analyzing" followNonce={messages.length}
          onRegenerate={() => undefined} onStartExercise={() => undefined} onOpenMemories={() => undefined} />
      </section>
      <section aria-label="输入框与学习意图" style={{ display: "grid", gap: 12 }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button style={buttonStyle} onClick={() => { setDraft(`${formatFileMarker(slides)}\n`); setHome(false); }}>课件 · 三个意图</button>
          <button style={buttonStyle} onClick={() => { setDraft(`${formatFileMarker(table)}\n`); setHome(false); }}>表格 · 两个意图</button>
          <button style={buttonStyle} onClick={() => { setDraft(""); setHome(true); }}>首页新对话提示</button>
        </div>
        <Composer value={draft} onChange={setDraft} conversationId={home ? undefined : "preview-attachments"}
          hero={home} phase={null} busy={false} autoFocusKey="preview" placeholder="拖入资料，选择你想怎么学…"
          onSend={() => { if (draft.trim()) { setMessages((list) => [...list, userMessage(draft)]); setDraft(""); } }}
          onStop={() => undefined} />
      </section>
    </div>
  </main>;
}

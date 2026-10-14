"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Brain, FileText, MoreHorizontal, PanelLeftOpen, Plus, Trash2, Upload, X } from "lucide-react";
import type { ChatController } from "@/hooks/useChat";
import { createMaterialClient } from "@/lib/api/material-client";
import { toApiError } from "@/lib/api/errors";
import { chatApi } from "@/lib/chat/api";
import { levelLabel, progressLine } from "@/lib/chat/space";
import type { ConversationSummary, LearnerMemory, Subject } from "@/lib/chat/types";
import { API_BASE_URL } from "@/lib/config";
import { cx } from "@/lib/cx";
import type { CourseMaterial, Problem } from "@/lib/types";
import { Button } from "../ui/Button";
import { Composer } from "./Composer";
import { MessageList } from "./MessageList";
import styles from "./SubjectPage.module.css";

type Panel =
  | { mode: "list" }
  | { mode: "thread"; id: string }
  | { mode: "info"; section: "about" | "files" | "memory" };

function requestId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function readPanel(subjectId: string): Panel {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(`knowgap.space.panel.v1:${API_BASE_URL}:${subjectId}`) ?? "null");
    if (!parsed || typeof parsed !== "object" || !("mode" in parsed)) return { mode: "list" };
    if (parsed.mode === "thread" && "id" in parsed && typeof parsed.id === "string") return { mode: "thread", id: parsed.id };
    if (parsed.mode === "info" && "section" in parsed && (parsed.section === "about" || parsed.section === "files" || parsed.section === "memory")) {
      return { mode: "info", section: parsed.section };
    }
  } catch { /* fall back to the thread list */ }
  return { mode: "list" };
}

export function SubjectPage({
  subject, chat, narrow, sidebarOpen, memoriesById, problemsById, subjectNames, onOpenSidebar, onEdit, onDelete,
}: {
  subject: Subject;
  chat: ChatController;
  narrow: boolean;
  sidebarOpen: boolean;
  memoriesById: Record<string, LearnerMemory>;
  problemsById: Record<string, Problem>;
  subjectNames: Record<string, string>;
  onOpenSidebar: () => void;
  onEdit: () => void;
  onDelete: () => Promise<boolean>;
}) {
  const mainId = subject.mainConversationId;
  const { loadConversation } = chat;
  const [panel, setPanel] = useState<Panel>({ mode: "list" });
  const [panelReady, setPanelReady] = useState(false);
  const [overlay, setOverlay] = useState(false);
  const [threads, setThreads] = useState<ConversationSummary[]>([]);
  const [menu, setMenu] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [instructions, setInstructions] = useState(subject.instructions);
  const [resolveFor, setResolveFor] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ title: string; summary: string; takeaways: string } | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const showPanel = (next: Panel) => {
    setPanel(next);
    setOverlay(true);
  };

  useEffect(() => {
    const saved = readPanel(subject.id);
    setPanel(saved);
    setOverlay(saved.mode !== "list");
    setPanelReady(true);
    setMenu(false);
    setConfirmDelete(false);
  }, [subject.id]);

  useEffect(() => {
    setInstructions(subject.instructions);
  }, [subject.instructions]);

  useEffect(() => {
    if (!panelReady) return;
    try {
      localStorage.setItem(`knowgap.space.panel.v1:${API_BASE_URL}:${subject.id}`, JSON.stringify(panel));
    } catch { /* convenience only */ }
  }, [panel, panelReady, subject.id]);

  const refreshThreads = useCallback(async () => {
    try {
      setThreads(await chatApi.listThreads(subject.id));
    } catch { /* keep the last list */ }
  }, [subject.id]);

  useEffect(() => {
    if (mainId) void loadConversation(mainId);
    void refreshThreads();
  }, [loadConversation, mainId, refreshThreads]);

  const main = mainId ? chat.messagesFor(mainId) : null;
  const threadId = panel.mode === "thread" ? panel.id : null;
  useEffect(() => {
    if (threadId) void loadConversation(threadId);
  }, [loadConversation, threadId]);
  const thread = threadId ? chat.messagesFor(threadId) : null;
  const threadSummary = threads.find((item) => item.id === threadId) ?? null;
  const mainPhase = mainId ? chat.streamFor(mainId)?.phase ?? null : null;

  useEffect(() => {
    if (!mainId || mainPhase) return;
    if (!main?.messages.some((message) => message.status === "streaming")) return;
    const timer = window.setTimeout(() => void loadConversation(mainId), 1500);
    return () => window.clearTimeout(timer);
  }, [loadConversation, main, mainId, mainPhase]);

  const openThread = (id: string) => {
    showPanel({ mode: "thread", id });
    void chat.loadConversation(id);
  };

  const branch = async (messageId: string) => {
    const created = await chatApi.createThread(subject.id, { anchorMessageId: messageId, clientRequestId: requestId() });
    await refreshThreads();
    openThread(created.id);
  };

  const newThread = async () => {
    const created = await chatApi.createThread(subject.id, { clientRequestId: requestId() });
    await refreshThreads();
    openThread(created.id);
  };

  const beginResolve = async (id: string) => {
    setResolveFor(id);
    setDraft(null);
    setDraftError(null);
    setDrafting(true);
    try {
      const result = await chatApi.draftResolution(id);
      setDraft({ title: result.title, summary: result.summary, takeaways: result.takeaways.join("\n") });
    } catch (error) {
      setDraftError(toApiError(error).message);
    } finally {
      setDrafting(false);
    }
  };

  const confirmResolve = async () => {
    if (!resolveFor || !draft || saving) return;
    setSaving(true);
    try {
      await chatApi.resolveThread(resolveFor, {
        title: draft.title.trim(),
        summary: draft.summary.trim(),
        takeaways: draft.takeaways.split("\n").map((item) => item.trim()).filter(Boolean).slice(0, 4),
      });
      setResolveFor(null);
      if (mainId) void chat.loadConversation(mainId);
      void chat.loadConversation(resolveFor);
      void refreshThreads();
      void chat.loadSubjects();
      void chat.loadMemories();
    } catch (error) {
      setDraftError(toApiError(error).message);
    } finally {
      setSaving(false);
    }
  };

  const reopen = async (id: string) => {
    await chatApi.reopenThread(id);
    void chat.loadConversation(id);
    void refreshThreads();
    void chat.loadSubjects();
  };

  const saveInstructions = async () => {
    if (instructions.trim() === subject.instructions) return;
    await chat.updateSubject(subject.id, { instructions });
  };

  const openThreads = threads.filter((item) => item.threadStatus !== "resolved");
  const doneThreads = threads.filter((item) => item.threadStatus === "resolved");
  const failureFor = (id: string | null) => chat.sendFailure?.conversationId === id ? chat.sendFailure : null;
  const panelVisible = !narrow || overlay;

  return (
    <div className={styles.page}>
      <section className={styles.main}>
        <header className={styles.header}>
          {!sidebarOpen && (
            <button className={styles.icon} onClick={onOpenSidebar} aria-label="展开侧栏">
              <PanelLeftOpen size={16} />
            </button>
          )}
          <span className={styles.dot} style={{ background: subject.color }} />
          <div className={styles.heading}>
            <h1>{subject.name}</h1>
            <p>{subject.goal || "还没有写下目标"}</p>
          </div>
          {levelLabel(subject.level) && <span className={styles.tag}>{levelLabel(subject.level)}</span>}
          <span className={styles.progress}>{progressLine(subject.progress)}</span>
          <div className={styles.tools}>
            <button onClick={() => showPanel({ mode: "info", section: "about" })}>说明</button>
            <button onClick={() => showPanel({ mode: "info", section: "files" })}>资料</button>
            <button onClick={() => showPanel({ mode: "info", section: "memory" })}>记忆</button>
            {narrow && <button onClick={() => showPanel({ mode: "list" })}>Thread</button>}
            <button className={styles.icon} aria-label="更多" onClick={() => setMenu((open) => !open)}>
              <MoreHorizontal size={16} />
            </button>
          </div>
          {menu && (
            <div className={styles.menu}>
              <button onClick={() => { setMenu(false); onEdit(); }}>编辑</button>
              <button className={styles.danger} onClick={() => { setMenu(false); setConfirmDelete(true); }}>删除</button>
            </div>
          )}
        </header>
        {confirmDelete && (
          <div className={styles.confirm} role="group">
            <span>删除后，主对话和 Thread 会变成普通对话，记忆改为通用。</span>
            <button onClick={() => setConfirmDelete(false)}>取消</button>
            <button className={styles.danger} onClick={() => void onDelete()}>删除</button>
          </div>
        )}
        {mainId && main ? (
          main.messages.length === 0 && !main.loading ? (
            <div className={styles.center}><p>从这里开始主线。遇到一道具体的题，把鼠标放在消息上，开一个 Thread。</p></div>
          ) : (
            <MessageList
              conversationId={mainId}
              messages={main.messages}
              problems={problemsById}
              memoriesById={memoriesById}
              conversationSubjectId={subject.id}
              subjectNames={subjectNames}
              phase={chat.streamFor(mainId)?.phase ?? null}
              followNonce={chat.followNonceFor(mainId)}
              onRegenerate={() => void chat.regenerate(mainId)}
              onStartExercise={(problemId) => void chat.startExerciseOn(mainId, problemId)}
              onOpenMemories={() => showPanel({ mode: "info", section: "memory" })}
              onOpenThread={(messageId) => void branch(messageId)}
              onOpenSummary={openThread}
            />
          )
        ) : (
          <div className={styles.center}><p>正在读取主对话…</p></div>
        )}
        {mainId && (
          <div className={styles.dock}>
            {failureFor(mainId) && <p className={styles.error}>{failureFor(mainId)?.error.message}</p>}
            <Composer
              value={chat.draftFor(mainId)}
              onChange={(value) => chat.setDraftFor(mainId, value)}
              onSend={() => void chat.sendTo(mainId, chat.draftFor(mainId))}
              onStop={() => void chat.stop(mainId)}
              phase={chat.streamFor(mainId)?.phase ?? null}
              busy={false}
              problems={chat.problems}
              onStartExercise={(problemId) => void chat.startExerciseOn(mainId, problemId)}
              autoFocusKey={mainId}
              placeholder={`在「${subject.name}」里继续学`}
            />
          </div>
        )}
      </section>
      {panelVisible && (
        <aside className={cx(styles.panel, narrow && styles.overlay)}>
          {panel.mode === "list" && (
            <ThreadList
              openThreads={openThreads}
              doneThreads={doneThreads}
              narrow={narrow}
              onClose={() => setOverlay(false)}
              onOpen={openThread}
              onCreate={() => void newThread()}
            />
          )}
          {panel.mode === "thread" && threadId && (
            <div className={styles.thread}>
              <header className={styles.threadHead}>
                <div>
                  <strong>{threadSummary?.title ?? "Thread"}</strong>
                  {threadSummary?.anchor && <p className={styles.anchor}>{threadSummary.anchor.excerpt}</p>}
                </div>
                {threadSummary?.threadStatus === "resolved" ? (
                  <button onClick={() => void reopen(threadId)}>重新打开</button>
                ) : (
                  <button onClick={() => void beginResolve(threadId)}>已解决</button>
                )}
                <button className={styles.icon} aria-label="关闭" onClick={() => { setPanel({ mode: "list" }); if (narrow) setOverlay(false); }}>
                  <X size={16} />
                </button>
              </header>
              {thread && (
                <MessageList
                  conversationId={threadId}
                  messages={thread.messages}
                  problems={problemsById}
                  memoriesById={memoriesById}
                  conversationSubjectId={subject.id}
                  subjectNames={subjectNames}
                  phase={chat.streamFor(threadId)?.phase ?? null}
                  followNonce={chat.followNonceFor(threadId)}
                  onRegenerate={() => void chat.regenerate(threadId)}
                  onStartExercise={(problemId) => void chat.startExerciseOn(threadId, problemId)}
                  onOpenMemories={() => showPanel({ mode: "info", section: "memory" })}
                />
              )}
              <div className={styles.dock}>
                {failureFor(threadId) && <p className={styles.error}>{failureFor(threadId)?.error.message}</p>}
                <Composer
                  inputId="thread-composer"
                  value={chat.draftFor(threadId)}
                  onChange={(value) => chat.setDraftFor(threadId, value)}
                  onSend={() => void chat.sendTo(threadId, chat.draftFor(threadId))}
                  onStop={() => void chat.stop(threadId)}
                  phase={chat.streamFor(threadId)?.phase ?? null}
                  busy={false}
                  problems={chat.problems}
                  onStartExercise={(problemId) => void chat.startExerciseOn(threadId, problemId)}
                  autoFocusKey={threadId}
                  placeholder="只解决这一个问题"
                />
              </div>
            </div>
          )}
          {panel.mode === "info" && (
            <div className={styles.info}>
              <header className={styles.threadHead}>
                <strong>{panel.section === "about" ? "说明" : panel.section === "files" ? "资料" : "记忆"}</strong>
                <button className={styles.icon} aria-label="关闭" onClick={() => { setPanel({ mode: "list" }); if (narrow) setOverlay(false); }}>
                  <X size={16} />
                </button>
              </header>
              {panel.section === "about" && (
                <label className={styles.about}>
                  <span>告诉模型在这个空间里怎么教你。目标、基础和截止日期在编辑里改。</span>
                  <textarea value={instructions} maxLength={4000} onChange={(event) => setInstructions(event.target.value)} onBlur={() => void saveInstructions()} />
                </label>
              )}
              {panel.section === "files" && <Files subjectId={subject.id} onChange={() => void chat.loadSubjects()} />}
              {panel.section === "memory" && (
                <ul className={styles.memories}>
                  {chat.memories.filter((memory) => memory.subjectId === subject.id).map((memory) => (
                    <li key={memory.id}>
                      <Brain size={13} aria-hidden />
                      <span>{memory.summary}</span>
                    </li>
                  ))}
                  {chat.memories.every((memory) => memory.subjectId !== subject.id) && <li className={styles.muted}>还没有属于这里的记忆。</li>}
                </ul>
              )}
            </div>
          )}
        </aside>
      )}
      {resolveFor && (
        <div className={styles.backdrop} onMouseDown={() => setResolveFor(null)}>
          <div className={styles.resolve} role="dialog" aria-modal="true" aria-label="合并小结" onMouseDown={(event) => event.stopPropagation()}>
            <h2>合并回主对话</h2>
            {drafting && <p>正在起草小结…</p>}
            {draftError && <p className={styles.error}>{draftError}</p>}
            {draft && (
              <>
                <input value={draft.title} maxLength={60} aria-label="小结标题" onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
                <textarea value={draft.summary} aria-label="小结" onChange={(event) => setDraft({ ...draft, summary: event.target.value })} />
                <textarea value={draft.takeaways} aria-label="要点，每行一条" placeholder="要点，每行一条" onChange={(event) => setDraft({ ...draft, takeaways: event.target.value })} />
              </>
            )}
            <footer>
              <Button onClick={() => setResolveFor(null)}>取消</Button>
              <Button variant="primary" disabled={!draft?.title.trim() || !draft.summary.trim()} loading={saving} onClick={() => void confirmResolve()}>
                合并
              </Button>
            </footer>
          </div>
        </div>
      )}
    </div>
  );
}

function ThreadList({
  openThreads, doneThreads, narrow, onClose, onOpen, onCreate,
}: {
  openThreads: ConversationSummary[];
  doneThreads: ConversationSummary[];
  narrow: boolean;
  onClose: () => void;
  onOpen: (id: string) => void;
  onCreate: () => void;
}) {
  return (
    <div className={styles.listPane}>
      <header className={styles.threadHead}>
        <strong>Thread</strong>
        {narrow && <button className={styles.icon} aria-label="关闭" onClick={onClose}><X size={16} /></button>}
      </header>
      <button className={styles.add} onClick={onCreate}><Plus size={14} aria-hidden />新建 Thread</button>
      <p className={styles.group}>未解决</p>
      <ul>
        {openThreads.map((item) => (
          <li key={item.id}><button onClick={() => onOpen(item.id)}>{item.title}</button></li>
        ))}
        {openThreads.length === 0 && <li className={styles.muted}>没有未解决的 Thread。</li>}
      </ul>
      <p className={styles.group}>已解决</p>
      <ul>
        {doneThreads.map((item) => (
          <li key={item.id}>
            <button onClick={() => onOpen(item.id)}>
              <span>{item.title}</span>
              {item.preview && <small>{item.preview}</small>}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Files({ subjectId, onChange }: { subjectId: string; onChange: () => void }) {
  const client = useMemo(() => createMaterialClient(), []);
  const input = useRef<HTMLInputElement>(null);
  const [documents, setDocuments] = useState<CourseMaterial[]>([]);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      setDocuments(await client.list({ subjectId }));
      setError(null);
    } catch (failure) {
      setError(toApiError(failure).message);
    }
  }, [client, subjectId]);
  useEffect(() => { void refresh(); }, [refresh]);
  const upload = async (file: File) => {
    try {
      await client.upload(file, subjectId);
      await refresh();
      onChange();
    } catch (failure) {
      setError(toApiError(failure).message);
    }
  };
  const remove = async (id: string) => {
    await client.remove(id);
    await refresh();
    onChange();
  };
  return (
    <div className={styles.files}>
      <button onClick={() => input.current?.click()}><Upload size={13} aria-hidden />上传</button>
      <input ref={input} hidden type="file" accept=".pdf,.txt,.md" onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file); }} />
      {error && <p className={styles.error}>{error}</p>}
      <ul>
        {documents.map((document) => (
          <li key={document.id}>
            <FileText size={13} aria-hidden />
            <span>{document.title}</span>
            <button aria-label={`删除 ${document.title}`} onClick={() => void remove(document.id)}><Trash2 size={12} /></button>
          </li>
        ))}
        {documents.length === 0 && <li className={styles.muted}>还没有资料。</li>}
      </ul>
    </div>
  );
}

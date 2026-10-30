"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { ArrowUp, CornerDownLeft, ExternalLink, Loader2, Plus, X } from "lucide-react";
import { useAuth } from "@/components/auth/useAuth";
import { Markdown } from "@/components/chat/Markdown";
import { useI18n } from "@/components/LanguageProvider";
import { MODE_KEY } from "@/lib/api/auth";
import { ApiError } from "@/lib/api/errors";
import { AUTH_TOKEN_KEY } from "@/lib/api/http-client";
import { chatApi } from "@/lib/chat/api";
import type { Subject } from "@/lib/chat/types";
import { API_BASE_URL } from "@/lib/config";
import styles from "./QuickAsk.module.css";

/** 上次选择的学习空间；NONE 表示“不归入空间” */
const SPACE_KEY = "knowgap.quick.space.v1";
const NONE = "none";

type Phase = "idle" | "sending" | "streaming" | "done" | "error";
type QuickBridge = NonNullable<NonNullable<Window["knowgap"]>["quick"]>;

function readSpace(): string {
  try {
    return localStorage.getItem(SPACE_KEY) ?? NONE;
  } catch {
    return NONE;
  }
}

function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/**
 * 让主界面下次加载时打开这条对话：与 useChat / ChatApp 使用同一组 localStorage 键。
 * 桌面壳里两个窗口同源，浏览器里同一站点的标签页也共享这些键。
 */
function rememberActive(userId: string, conversationId: string) {
  try {
    localStorage.setItem(`${userId}:knowgap.chat.active.v1:${API_BASE_URL}`, conversationId);
    localStorage.setItem(`${userId}:knowgap.chat.view.v1:${API_BASE_URL}`, JSON.stringify({ type: "chat" }));
  } catch { /* storage unavailable: the main window keeps its current view */ }
}

/** 全局快捷键呼出的快问浮窗；浏览器里直接访问 /quick 也可使用 */
export function QuickAsk() {
  const auth = useAuth();
  const { tx } = useI18n();
  const [desktop, setDesktop] = useState<QuickBridge | null>(null);
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [space, setSpace] = useState<string>(NONE);
  const [question, setQuestion] = useState("");
  const [asked, setAsked] = useState("");
  const [answer, setAnswer] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState("");
  const [tool, setTool] = useState("");
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [shortcut, setShortcut] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const user = auth.status === "ready" ? auth.user : null;
  const busy = phase === "sending" || phase === "streaming";

  const loadSubjects = useCallback(() => {
    chatApi.listSubjects().then((list) => {
      setSubjects(list);
      const saved = readSpace();
      setSpace(saved !== NONE && list.some((item) => item.id === saved) ? saved : NONE);
    }).catch(() => setSubjects([]));
  }, []);

  useEffect(() => {
    if (user) loadSubjects();
  }, [user, loadSubjects]);

  // 桌面浮窗：透明窗口里只显示面板本身
  useEffect(() => {
    const bridge = window.knowgap?.quick;
    if (!bridge) return;
    setDesktop(bridge);
    const { documentElement: html, body } = document;
    html.dataset.quickWindow = "";
    html.style.background = body.style.background = "transparent";
    body.style.minHeight = "0";
    body.style.overflow = "hidden";
    void bridge.shortcut().then(setShortcut).catch(() => setShortcut(null));
    return () => {
      delete html.dataset.quickWindow;
      html.style.background = body.style.background = body.style.minHeight = body.style.overflow = "";
    };
  }, []);

  // 浮窗可能早于主窗口登录就已加载：登录状态在别处变化后重新加载，拿到最新身份
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === AUTH_TOKEN_KEY || event.key === MODE_KEY) window.location.reload();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // 每次呼出时聚焦输入框，并刷新空间列表（主窗口里可能刚新建了空间）
  useEffect(() => {
    inputRef.current?.focus();
    if (!desktop) return;
    return desktop.onShown(() => {
      if (auth.status === "anonymous") {
        window.location.reload();
        return;
      }
      inputRef.current?.focus();
      inputRef.current?.select();
      if (user) loadSubjects();
    });
  }, [desktop, user, auth.status, loadSubjects]);

  // 面板高度变化时让桌面壳跟着调整窗口高度（外加阴影留白）
  useEffect(() => {
    const panel = panelRef.current;
    if (!desktop || !panel) return;
    const observer = new ResizeObserver(() => {
      void desktop.resize(Math.ceil(panel.getBoundingClientRect().height) + 32);
    });
    observer.observe(panel);
    return () => observer.disconnect();
  }, [desktop]);

  useEffect(() => () => abortRef.current?.abort(), []);

  // 回答期间输入框被禁用会丢焦点，结束后还回去，方便直接接着问
  useEffect(() => {
    if (phase === "done" || phase === "error") inputRef.current?.focus();
  }, [phase]);

  const pickSpace = (value: string) => {
    setSpace(value);
    try { localStorage.setItem(SPACE_KEY, value); } catch { /* ignore */ }
  };

  const reset = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setPhase("idle");
    setAnswer("");
    setAsked("");
    setError("");
    setTool("");
    setConversationId(null);
    inputRef.current?.focus();
  };

  /** 只是不再在浮窗里等：服务端会继续生成，对话仍可在主窗口打开 */
  const detach = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setTool("");
    setError(conversationId ? tx("已停止等待，回复会在后台继续生成。") : tx("已取消发送。"));
    setPhase("error");
  };

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    const text = question.trim();
    if (!text || busy || !user) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setAsked(text);
    setAnswer("");
    setError("");
    setTool("");
    setConversationId(null);
    setPhase("sending");
    try {
      const conversation = await chatApi.createConversation({
        clientRequestId: newId(), subjectId: space === NONE ? null : space,
      });
      setConversationId(conversation.id);
      setQuestion("");
      let failed = "";
      const outcome = await chatApi.sendMessage(conversation.id, text, newId(), (streamEvent) => {
        if (streamEvent.type === "start" || streamEvent.type === "analysis") setPhase("streaming");
        else if (streamEvent.type === "delta") {
          setPhase("streaming");
          setTool("");
          setAnswer((current) => current + streamEvent.text);
        } else if (streamEvent.type === "tool_start") setTool(streamEvent.name);
        else if (streamEvent.type === "tool_end") setTool("");
        else if (streamEvent.type === "tool_approval") setTool(tx("{name}（需在主窗口批准）", { name: streamEvent.name }));
        else if (streamEvent.type === "done" && streamEvent.message?.content) setAnswer(streamEvent.message.content);
        else if (streamEvent.type === "error") failed = streamEvent.detail;
      }, controller.signal);
      if (controller.signal.aborted) return;
      if (failed) {
        setError(failed);
        setPhase("error");
      } else if (outcome === "interrupted") {
        setError(tx("连接中断，回复可能仍在后台生成，可在主窗口查看。"));
        setPhase("error");
      } else {
        setPhase("done");
      }
    } catch (caught) {
      if (controller.signal.aborted) return;
      setError(caught instanceof ApiError ? caught.message : tx("发送失败，请确认后端已启动。"));
      setPhase("error");
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  };

  const openInMain = () => {
    if (conversationId && user) rememberActive(user.id, conversationId);
    if (desktop) {
      void desktop.openInMain(conversationId ?? undefined);
      reset();
      return;
    }
    window.open("/", "_blank", "noopener");
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    if (desktop) void desktop.hide();
    else if (busy) detach();
    else reset();
  };

  return (
    <main className={styles.stage} onKeyDown={onKeyDown}>
      <div ref={panelRef} className={styles.panel} role="dialog" aria-label={tx("快问")}>
        {auth.status === "loading" ? (
          <p className={styles.notice}>{tx("正在确认登录状态…")}</p>
        ) : !user ? (
          <div className={styles.notice}>
            <span>{auth.error || tx("请先在主窗口登录，或使用本机演示身份进入。")}</span>
            <button type="button" className={styles.ghost} onClick={openInMain}>
              <ExternalLink size={14} aria-hidden /> {tx("打开主窗口")}
            </button>
          </div>
        ) : (
          <>
            <form className={styles.bar} onSubmit={submit}>
              <input
                ref={inputRef}
                className={styles.input}
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                placeholder={busy ? tx("正在回答…") : tx("问点什么，回车发送")}
                aria-label={tx("问题")}
                autoComplete="off"
                spellCheck={false}
                disabled={busy}
              />
              <button type="submit" className={styles.send} disabled={busy || !question.trim()} aria-label={tx("发送")}>
                {busy ? <Loader2 size={15} className={styles.spin} aria-hidden /> : <ArrowUp size={15} aria-hidden />}
              </button>
            </form>
            <div className={styles.meta}>
              <label className={styles.space}>
                <span>{tx("归入")}</span>
                <select value={space} onChange={(event) => pickSpace(event.target.value)} disabled={busy}>
                  <option value={NONE}>{tx("不归入空间")}</option>
                  {subjects.map((subject) => <option key={subject.id} value={subject.id}>{subject.name}</option>)}
                </select>
              </label>
              <span className={styles.hint}>
                <CornerDownLeft size={12} aria-hidden /> {tx("发送")} · Esc {desktop ? tx("收起") : tx("清空")}
                {shortcut && <> · {tx("{shortcut} 呼出", { shortcut: shortcut.replace("CommandOrControl", "Ctrl") })}</>}
              </span>
            </div>
            {phase !== "idle" && (
              <section className={styles.result} aria-live="polite">
                <p className={styles.asked}>{asked}</p>
                {phase === "sending" && <p className={styles.status}>{tx("正在创建对话并发送…")}</p>}
                {phase === "streaming" && !answer && (
                  <p className={styles.status}>{tool ? tx("正在使用工具：{tool}", { tool }) : tx("正在思考…")}</p>
                )}
                {answer && <div className={styles.answer}><Markdown text={answer} /></div>}
                {phase === "streaming" && answer && tool && <p className={styles.status}>{tx("正在使用工具：{tool}", { tool })}</p>}
                {error && <p className={styles.error} role="alert">{error}</p>}
                <div className={styles.actions}>
                  <span className={styles.state}>
                    {phase === "done" ? tx("已保存到新对话") : phase === "error" ? (conversationId ? tx("对话已创建") : tx("未发送")) : tx("回复中")}
                  </span>
                  {busy ? (
                    <button type="button" className={styles.ghost} onClick={detach}>
                      <X size={14} aria-hidden /> {tx("不再等待")}
                    </button>
                  ) : (
                    <button type="button" className={styles.ghost} onClick={reset}>
                      <Plus size={14} aria-hidden /> {tx("新问题")}
                    </button>
                  )}
                  {conversationId && (
                    <button type="button" className={styles.primary} onClick={openInMain}>
                      <ExternalLink size={14} aria-hidden /> {tx("在主窗口打开")}
                    </button>
                  )}
                </div>
              </section>
            )}
          </>
        )}
      </div>
    </main>
  );
}

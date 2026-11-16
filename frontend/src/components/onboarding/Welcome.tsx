"use client";

import { useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { ArrowRight, Paperclip, PlugZap, X } from "lucide-react";
import { BrandLockup } from "@/components/Brand";
import { useI18n } from "@/components/LanguageProvider";
import { DOCUMENT_EXTENSIONS, MAX_UPLOAD_BYTES } from "@/lib/chat/attachments";
import styles from "./Welcome.module.css";

const EXAMPLES = ["数据结构 · 期末", "电路原理", "考研数学"];
const TOPIC_MAX = 200;

/** 「第3章_栈和队列.pdf」→「第3章 栈和队列」：给主题一个能直接用、也能改的起点 */
export function topicFromFileName(name: string): string {
  return name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim().slice(0, TOPIC_MAX);
}

interface WelcomeProps {
  busy: boolean;
  error: string;
  onAnswer: (text: string, file?: File) => void;
  onDemo: () => void;
  onSkip: () => void;
}

export function Welcome({ busy, error, onAnswer, onDemo, onSkip }: WelcomeProps) {
  const { tx } = useI18n();
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState("");
  const fileRef = useRef<HTMLInputElement | null>(null);
  const examples = EXAMPLES.map((example) => tx(example));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    onAnswer(trimmed, file ?? undefined);
  };

  const pickFile = (event: ChangeEvent<HTMLInputElement>) => {
    const next = event.target.files?.[0] ?? null;
    event.target.value = "";
    if (!next) return;
    if (next.size > MAX_UPLOAD_BYTES) {
      setFileError(tx("单份资料不能超过 20 MB。"));
      return;
    }
    setFileError("");
    setFile(next);
    if (!text.trim()) setText(topicFromFileName(next.name));
  };

  return (
    <div className={styles.wrap}>
      <form className={styles.card} onSubmit={submit}>
        <BrandLockup size={36} />
        <h1>{tx("你最近在学什么？")}</h1>
        <p className={styles.lead}>{tx("说一个主题，马上用例子开讲。")}</p>
        <input
          className={styles.input}
          value={text}
          maxLength={TOPIC_MAX}
          aria-label={tx("你最近在学什么")}
          placeholder={tx("写一个主题")}
          disabled={busy}
          onChange={(event) => setText(event.target.value)}
        />
        <input
          ref={fileRef}
          type="file"
          hidden
          accept={DOCUMENT_EXTENSIONS.join(",")}
          aria-label={tx("选择一份资料")}
          onChange={pickFile}
        />
        {file ? (
          <div className={styles.file}>
            <Paperclip size={13} aria-hidden />
            <span className={styles.fileName} title={file.name}>{file.name}</span>
            <button type="button" disabled={busy} aria-label={tx("移除资料")} onClick={() => setFile(null)}>
              <X size={13} aria-hidden />
            </button>
          </div>
        ) : (
          <button type="button" className={styles.attach} disabled={busy} onClick={() => fileRef.current?.click()}>
            <Paperclip size={13} aria-hidden />
            {tx("附一份课件或讲义（可选）")}
          </button>
        )}
        {fileError && <p className={styles.error} role="alert">{fileError}</p>}
        <div className={styles.examples} role="group" aria-label={tx("示例主题")}>
          {examples.map((example) => (
            <button key={example} type="button" disabled={busy} onClick={() => onAnswer(example, file ?? undefined)}>
              {example}
            </button>
          ))}
        </div>
        {busy && file && <p className={styles.lead} role="status">{tx("正在建空间并读取资料…")}</p>}
        {error && <p className={styles.error} role="alert">{error}</p>}
        <button className={styles.primary} type="submit" disabled={busy || !text.trim()}>
          {tx("开始学")}
          <ArrowRight size={14} aria-hidden />
        </button>
        <div className={styles.links}>
          <button type="button" disabled={busy} onClick={onDemo}>{tx("先逛逛演示空间")}</button>
          <button type="button" disabled={busy} onClick={onSkip}>{tx("跳过，直接开始")}</button>
        </div>
      </form>
    </div>
  );
}

/** 登录后读取学习进度时的过渡；只有后端连不上才需要用户动手 */
export function StartupStatus({ error, onRetry, onLogout }: {
  error: string;
  onRetry: () => void;
  onLogout: () => void;
}) {
  const { tx } = useI18n();
  return (
    <div className={styles.wrap}>
      <section className={styles.card} aria-busy={!error}>
        <BrandLockup size={36} />
        {error ? (
          <>
            <p className={styles.error} role="alert">{error}</p>
            <button className={styles.primary} type="button" onClick={onRetry}>{tx("重试")}</button>
            <button className={styles.logout} type="button" onClick={onLogout}>{tx("退出登录")}</button>
          </>
        ) : (
          <p className={styles.lead} role="status">{tx("正在读取学习进度…")}</p>
        )}
      </section>
    </div>
  );
}

/** 模型调用因为配置问题失败后出现：说明原因，带用户去接模型 */
export function ModelGuide({ detail, onConnect, onRetry, onDismiss }: {
  detail: string;
  onConnect: () => void;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  const { tx } = useI18n();
  return (
    <section className={styles.guide} role="alert" aria-labelledby="model-guide-title">
      <header className={styles.guideHead}>
        <PlugZap size={16} aria-hidden />
        <h2 id="model-guide-title">{tx("还差一步：连上 AI 模型")}</h2>
        <button type="button" className={styles.guideClose} aria-label={tx("关闭")} onClick={onDismiss}>
          <X size={14} aria-hidden />
        </button>
      </header>
      {detail && <p className={styles.guideDetail}>{detail}</p>}
      <p className={styles.guideLead}>
        {tx("选一个服务商（DeepSeek、通义千问、ChatGPT 等）填上 Key 就能用，也支持任何 OpenAI 兼容服务。接好后会自动接着讲。")}
      </p>
      <div className={styles.guideActions}>
        <button type="button" className={styles.primary} onClick={onConnect}>{tx("去连接模型")}</button>
        <button type="button" className={styles.secondary} onClick={onRetry}>{tx("重试")}</button>
      </div>
    </section>
  );
}

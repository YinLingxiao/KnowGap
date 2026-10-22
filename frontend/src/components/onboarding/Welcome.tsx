"use client";

import { useState, type FormEvent } from "react";
import Image from "next/image";
import { ArrowRight } from "lucide-react";
import styles from "./Welcome.module.css";

const EXAMPLES = ["数据结构 · 期末", "电路原理", "考研数学"];

interface WelcomeProps {
  busy: boolean;
  error: string;
  onAnswer: (text: string) => void;
  onDemo: () => void;
  onSkip: () => void;
}

export function Welcome({ busy, error, onAnswer, onDemo, onSkip }: WelcomeProps) {
  const [text, setText] = useState("");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    onAnswer(trimmed);
  };

  return (
    <div className={styles.wrap}>
      <form className={styles.card} onSubmit={submit}>
        <Image src="/brand/knowgap-logo-v1.png" alt="" width={36} height={36} className={styles.logo} />
        <h1>你最近在学什么？</h1>
        <p className={styles.lead}>说一个主题，马上用例子开讲。</p>
        <input
          className={styles.input}
          value={text}
          maxLength={200}
          aria-label="你最近在学什么"
          placeholder="写一个主题"
          disabled={busy}
          onChange={(event) => setText(event.target.value)}
        />
        <div className={styles.examples} role="group" aria-label="示例主题">
          {EXAMPLES.map((example) => (
            <button key={example} type="button" disabled={busy} onClick={() => onAnswer(example)}>
              {example}
            </button>
          ))}
        </div>
        {error && <p className={styles.error} role="alert">{error}</p>}
        <button className={styles.primary} type="submit" disabled={busy || !text.trim()}>
          开始学
          <ArrowRight size={14} aria-hidden />
        </button>
        <div className={styles.links}>
          <button type="button" disabled={busy} onClick={onDemo}>先逛逛演示空间</button>
          <button type="button" disabled={busy} onClick={onSkip}>跳过，直接开始</button>
        </div>
      </form>
    </div>
  );
}

export function ModelGate({ busy, error, configured, onConfigure, onRetry, onLogout }: {
  busy: boolean;
  error: string;
  configured: boolean | null;
  onConfigure: () => void;
  onRetry: () => void;
  onLogout: () => void;
}) {
  return (
    <div className={styles.wrap}>
      <section className={styles.card} aria-labelledby="model-gate-title" aria-busy={busy}>
        <Image src="/brand/knowgap-logo-v1.png" alt="" width={36} height={36} className={styles.logo} />
        <h1 id="model-gate-title">先连上 AI 模型</h1>
        <p className={styles.lead}>填写 OpenAI 兼容服务的地址、Key 和模型名，保存并测试通过后继续。</p>
        {busy && <p className={styles.lead} role="status">正在确认模型和学习进度…</p>}
        {error && <p className={styles.error} role="alert">{error}</p>}
        {(configured === false || (configured === true && Boolean(error))) && <button className={styles.primary} type="button" onClick={onConfigure}>去填写</button>}
        {error && <button className={styles.primary} type="button" disabled={busy} onClick={onRetry}>重试</button>}
        <button className={styles.logout} type="button" onClick={onLogout}>退出登录</button>
      </section>
    </div>
  );
}

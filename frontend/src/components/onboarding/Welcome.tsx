"use client";

import { useEffect, useState, type FormEvent } from "react";
import Image from "next/image";
import { ArrowRight } from "lucide-react";
import { getAIConfig } from "@/lib/api/ai-config";
import styles from "./Welcome.module.css";

const EXAMPLES = ["数据结构 · 期末", "电路原理", "考研数学"];

interface WelcomeProps {
  busy: boolean;
  error: string;
  configVersion: string;
  onAnswer: (text: string) => void;
  onDemo: () => void;
  onSkip: () => void;
  onConfigure: () => void;
}

export function Welcome({ busy, error, configVersion, onAnswer, onDemo, onSkip, onConfigure }: WelcomeProps) {
  const [text, setText] = useState("");
  const [needModel, setNeedModel] = useState<boolean | null>(null);

  useEffect(() => {
    let live = true;
    getAIConfig()
      .then((config) => { if (live) setNeedModel(!config.configured); })
      .catch(() => { if (live) setNeedModel(false); });
    return () => { live = false; };
  }, [configVersion]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    onAnswer(trimmed);
  };

  if (needModel === null) {
    return (
      <div className={styles.wrap}>
        <div className={styles.card}>
          <Image src="/brand/knowgap-logo-v1.png" alt="" width={36} height={36} className={styles.logo} />
          <p className={styles.lead}>正在确认模型…</p>
        </div>
      </div>
    );
  }

  if (needModel) {
    return (
      <div className={styles.wrap}>
        <div className={styles.card}>
          <Image src="/brand/knowgap-logo-v1.png" alt="" width={36} height={36} className={styles.logo} />
          <h1>先连上 AI 模型（约 1 分钟）</h1>
          <p className={styles.lead}>填写任意 OpenAI 兼容服务的地址、Key 和模型名。</p>
          <button className={styles.primary} type="button" onClick={onConfigure}>去填写</button>
          {error && <p className={styles.error} role="alert">{error}</p>}
          <div className={styles.links}>
            <button type="button" disabled={busy} onClick={onDemo}>先逛逛演示空间</button>
            <button type="button" disabled={busy} onClick={onSkip}>跳过，直接开始</button>
          </div>
        </div>
      </div>
    );
  }

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

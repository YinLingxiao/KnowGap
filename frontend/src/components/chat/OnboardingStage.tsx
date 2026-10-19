"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import Image from "next/image";
import {
  ArrowRight, Brain, Check, CheckCircle2, CircleAlert, Compass,
  CornerDownLeft, GraduationCap, MessageSquare, Settings, Sparkles,
} from "lucide-react";
import type { StreamPhase } from "@/hooks/useChat";
import type { ChatMessage } from "@/lib/chat/types";
import { cx } from "@/lib/cx";
import styles from "./OnboardingStage.module.css";

interface OnboardingStageProps {
  messages: ChatMessage[];
  stage: string | null;
  ready: boolean;
  phase: StreamPhase | null;
  modelConfigured: boolean | null;
  quickReplies: string[];
  profileEntries: Record<string, string>;
  profileSaving: boolean;
  error: string;
  onChangeProfile: (key: string, value: string) => void;
  onSendAnswer: (text: string) => Promise<boolean>;
  onConfirm: (openCreateSpace: boolean) => void;
  onSkip: () => void;
  onOpenModelSettings: () => void;
  onOpenMemories: () => void;
}

const STEP_META = [
  { key: "background", step: "STEP 01", title: "学习目标与当前基础", shortLabel: "目标", icon: Compass },
  { key: "explanation", step: "STEP 02", title: "偏好的讲解与推导方式", shortLabel: "讲法", icon: Sparkles },
  { key: "interaction", step: "STEP 03", title: "练习与卡点互动节奏", shortLabel: "互动", icon: MessageSquare },
] as const;

function cleanMarkdown(raw: string): string {
  return raw.replace(/\*\*/g, "").trim();
}

export function OnboardingStage({
  messages,
  stage,
  ready,
  phase,
  modelConfigured,
  quickReplies,
  profileEntries,
  profileSaving,
  error,
  onChangeProfile,
  onSendAnswer,
  onConfirm,
  onSkip,
  onOpenModelSettings,
  onOpenMemories,
}: OnboardingStageProps) {
  const [input, setInput] = useState("");
  const [typedCount, setTypedCount] = useState(0);
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(media.matches || document.documentElement.dataset.motion === "reduced");
    update();
    media.addEventListener("change", update);
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-motion"] });
    return () => {
      media.removeEventListener("change", update);
      observer.disconnect();
    };
  }, []);

  const stepIndex = ready
    ? 3
    : Math.max(0, ["background", "explanation", "interaction"].indexOf(stage ?? "background"));

  const currentMeta = STEP_META[Math.min(2, stepIndex)];

  const latestAssistant = useMemo(() => {
    const found = [...messages].reverse().find((m) => m.role === "assistant" && m.status === "complete" && m.content.trim());
    return found?.content ?? "最近你最想弄明白什么？可以顺便说说现在学到哪了。";
  }, [messages]);

  const { leadText, mainQuestion } = useMemo(() => {
    const paragraphs = latestAssistant
      .split(/\n\s*\n/)
      .map(cleanMarkdown)
      .filter(Boolean);
    if (paragraphs.length >= 2) {
      return {
        leadText: messages.length === 1 ? "先用 3 个简短问题了解你的习惯，让之后的每次讲解更贴合你的节奏。" : paragraphs.slice(0, -1).join(" "),
        mainQuestion: paragraphs[paragraphs.length - 1],
      };
    }
    return {
      leadText: stepIndex === 0 ? "先用 3 个简短问题了解你的习惯，让之后的每次讲解更贴合你的节奏。" : "",
      mainQuestion: paragraphs[0] ?? "",
    };
  }, [latestAssistant, stepIndex, messages.length]);

  const fullText = leadText ? `${leadText}\n${mainQuestion}` : mainQuestion;
  const totalChars = fullText.length;
  const isTypingDone = typedCount >= totalChars;

  useEffect(() => {
    if (reducedMotion || ready) {
      setTypedCount(totalChars);
      return;
    }
    setTypedCount(0);
    const timer = window.setInterval(() => {
      setTypedCount((prev) => {
        if (prev >= totalChars) {
          window.clearInterval(timer);
          return totalChars;
        }
        return prev + 1;
      });
    }, 20);
    return () => window.clearInterval(timer);
  }, [fullText, totalChars, reducedMotion, ready]);

  const shownLead = leadText ? fullText.slice(0, Math.min(typedCount, leadText.length)) : "";
  const shownQuestion = leadText
    ? typedCount > leadText.length
      ? fullText.slice(leadText.length + 1, typedCount)
      : ""
    : fullText.slice(0, typedCount);

  const busy = phase !== null || sending;

  const sendAnswer = useCallback(
    async (text: string, clear = false) => {
      if (sendingRef.current || busy || modelConfigured === false) return;
      sendingRef.current = true;
      setSending(true);
      setTypedCount(totalChars);
      try {
        if (await onSendAnswer(text)) {
          if (clear) setInput("");
        }
      } finally {
        sendingRef.current = false;
        setSending(false);
      }
    },
    [busy, modelConfigured, onSendAnswer, totalChars],
  );

  // 支持数字键 1 / 2 / 3 快捷选择卡片
  useEffect(() => {
    if (ready || busy || modelConfigured === false) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const idx = ["1", "2", "3"].indexOf(event.key);
      if (idx >= 0 && quickReplies[idx]) {
        event.preventDefault();
        void sendAnswer(quickReplies[idx]);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [ready, busy, modelConfigured, quickReplies, sendAnswer]);

  const submitCustom = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || busy) return;
    void sendAnswer(trimmed, true);
  };

  const capturedList = STEP_META.filter((m) => Boolean(profileEntries[m.key]?.trim()));

  return (
    <div className={styles.stageWrap}>
      {/* 顶栏：左侧步骤徽章，居中进度轨，右侧模型设置与跳过 */}
      <header className={styles.topBar}>
        <div className={styles.topBarLeft}>
          <span className={styles.topBadge}>
            <Sparkles size={12} className={styles.topBadgeIcon} aria-hidden />
            {ready ? "画像就绪 · 待你确认" : `初识向导 · ${stepIndex + 1} / 3`}
          </span>
        </div>

        <div className={styles.progressTrack} aria-label="初识进度">
          {STEP_META.map((item, idx) => {
            const done = ready || idx < stepIndex;
            const active = !ready && idx === stepIndex;
            return (
              <div key={item.key} className={styles.progressStep}>
                <span
                  className={cx(
                    styles.progressBar,
                    done && styles.progressBarDone,
                    active && styles.progressBarActive,
                  )}
                />
                <span className={cx(styles.progressLabel, (done || active) && styles.progressLabelLit)}>
                  {item.shortLabel}
                </span>
              </div>
            );
          })}
        </div>

        <div className={styles.topBarRight}>
          <button
            type="button"
            className={cx(styles.topBtn, modelConfigured === false && styles.topBtnWarn)}
            onClick={onOpenModelSettings}
          >
            <Settings size={13} aria-hidden />
            <span>模型设置</span>
          </button>
          <button type="button" className={styles.topBtn} onClick={onOpenMemories}>
            <Brain size={13} aria-hidden />
            <span>画像</span>
          </button>
          {!ready && (
            <button type="button" className={styles.skipBtn} onClick={onSkip}>
              跳过
            </button>
          )}
        </div>
      </header>

      {/* 舞台中心区：垂直水平居中 */}
      <div className={styles.centerStage}>
        <div className={styles.stageInner}>
          {/* 已记录的画像胶囊（随着第 1、2 问完成实时浮现） */}
          {!ready && capturedList.length > 0 && (
            <div className={styles.capturedBar} aria-label="已记录的偏好">
              {capturedList.map((item) => (
                <span key={item.key} className={styles.capturedChip}>
                  <Check size={11} className={styles.capturedIcon} aria-hidden />
                  <strong>{item.shortLabel}：</strong>
                  <span>{profileEntries[item.key]}</span>
                </span>
              ))}
            </div>
          )}

          <div className={cx(styles.logoBadge, busy && styles.logoPulse)}>
            <Image src="/brand/knowgap-logo-v1.png" alt="" width={34} height={34} className={styles.logoImg} />
          </div>

          {!ready ? (
            <>
              <span className={styles.stepEyebrow}>
                {currentMeta.step} · {currentMeta.title}
              </span>

              {/* 居中逐字打字机提问区 */}
              <div className={styles.promptBox} onClick={() => { if (!isTypingDone) setTypedCount(totalChars); }}>
                <div className="sr-only" role="status">
                  {busy ? "正在整理你的回答…" : fullText}
                </div>
                {leadText && (
                  <p className={styles.leadLine} aria-hidden="true">
                    {shownLead}
                    {!isTypingDone && typedCount <= leadText.length && <span className={styles.cursor} aria-hidden />}
                  </p>
                )}
                <h2 className={styles.questionHeadline} aria-label={mainQuestion}>
                  <span className={styles.reserveQuestion} aria-hidden="true">
                    {mainQuestion}
                  </span>
                  {busy ? (
                    <span className={styles.thinkingText}>正在整理你的回答并准备下一问…</span>
                  ) : (
                    <span aria-hidden="true">
                      {shownQuestion}
                      {!isTypingDone && typedCount > leadText.length && <span className={styles.cursor} aria-hidden />}
                    </span>
                  )}
                </h2>
                {!isTypingDone && !busy && (
                  <button
                    type="button"
                    className={styles.revealBtn}
                    onClick={(e) => {
                      e.stopPropagation();
                      setTypedCount(totalChars);
                    }}
                  >
                    立即显示全文
                  </button>
                )}
              </div>

              {error && (
                <p className={styles.errorBanner} role="alert">
                  <CircleAlert size={14} aria-hidden />
                  <span>{error}</span>
                </p>
              )}

              {modelConfigured === false && (
                <div className={styles.modelWarnBanner}>
                  <span>当前尚未配置大模型 API Key，请先配置后再回答：</span>
                  <button type="button" onClick={onOpenModelSettings}>
                    立即配置模型 →
                  </button>
                </div>
              )}

              {/* 快捷回答卡片 + 独立输入框 */}
              <div className={cx(styles.optionsSection, !busy && styles.optionsVisible)}>
                <div className={styles.optionsList} role="group" aria-label="快捷回答选项">
                  {quickReplies.map((replyText, idx) => (
                    <button
                      key={replyText}
                      type="button"
                      disabled={busy || modelConfigured === false}
                      className={styles.optionCard}
                      onClick={() => void sendAnswer(replyText)}
                    >
                      <kbd className={styles.optionKey}>{idx + 1}</kbd>
                      <span className={styles.optionText}>{replyText}</span>
                      <span className={styles.optionAction}>
                        <span>选择</span>
                        <ArrowRight size={13} aria-hidden />
                      </span>
                    </button>
                  ))}
                </div>

                <div className={styles.orDivider} aria-hidden>
                  <span>或用你自己的话描述</span>
                </div>

                <form className={styles.customForm} onSubmit={submitCustom}>
                  <input
                    className={styles.customInput}
                    value={input}
                    aria-label="你的回答"
                    disabled={busy || modelConfigured === false}
                    maxLength={500}
                    placeholder="输入你的真实情况或偏好，按 Enter 发送…"
                    onChange={(event) => setInput(event.target.value)}
                  />
                  <button
                    type="submit"
                    className={styles.customSendBtn}
                    disabled={!input.trim() || busy || modelConfigured === false}
                    aria-label="发送回答"
                  >
                    <CornerDownLeft size={14} aria-hidden />
                  </button>
                </form>
                <p className={styles.privacyNote}>
                  支持按键盘 <kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> 快速选择 · 候选画像仅在你最终确认后写入长期记忆
                </p>
              </div>
            </>
          ) : (
            /* 核对候选画像 Bento 舞台卡片 */
            <div className={styles.reviewStage}>
              <span className={styles.stepEyebrow}>FINAL · 专属学习画像已生成</span>
              <div className={styles.reviewHead}>
                <h2 className={styles.questionHeadline}>核对你的学习画像</h2>
                <p className={styles.leadLine}>
                  确认后将写入长期记忆（USER），后续所有主对话与 Thread 都会按此定制讲法。你可以直接点击修改或留空：
                </p>
              </div>

              {error && (
                <p className={styles.errorBanner} role="alert">
                  <CircleAlert size={14} aria-hidden />
                  <span>{error}</span>
                </p>
              )}

              <div className={styles.reviewCard}>
                <div className={styles.bentoList}>
                  {([
                    ["background", "背景与目标", "如：正在学一门新课程，想把核心概念弄清楚", Compass],
                    ["explanation", "讲解偏好", "如：先看具体例子或直观类比，再看抽象定义", Sparkles],
                    ["interaction", "互动偏好", "如：遇到问题先给一点小提示，留给我自己思考", MessageSquare],
                  ] as const).map(([key, label, ph, Icon]) => (
                    <label key={key} className={styles.bentoItem}>
                      <div className={styles.bentoItemHead}>
                        <span className={styles.bentoIcon} aria-hidden>
                          <Icon size={13} />
                        </span>
                        <span className={styles.reviewLabel}>{label}</span>
                        <CheckCircle2 size={13} className={styles.reviewCheck} aria-hidden />
                      </div>
                      <input
                        className={styles.reviewInput}
                        aria-label={label}
                        maxLength={220}
                        placeholder={ph}
                        value={profileEntries[key] ?? ""}
                        onChange={(event) => onChangeProfile(key, event.target.value)}
                      />
                    </label>
                  ))}
                </div>

                <div className={styles.reviewFooter}>
                  <button type="button" className={styles.ghostBtn} onClick={onSkip}>
                    暂不保存，直接体验
                  </button>
                  <div className={styles.reviewPrimaryGroup}>
                    <button
                      type="button"
                      className={styles.secondaryBtn}
                      disabled={profileSaving}
                      onClick={() => onConfirm(false)}
                    >
                      确认并进入工作台
                    </button>
                    <button
                      type="button"
                      className={styles.primaryBtn}
                      disabled={profileSaving}
                      onClick={() => onConfirm(true)}
                    >
                      <GraduationCap size={14} aria-hidden />
                      <span>确认并创建学习空间</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

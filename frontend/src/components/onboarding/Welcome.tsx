"use client";

import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { ArrowLeft, ArrowRight, Camera, Check, PlugZap, Sparkles, X } from "lucide-react";
import { BrandLockup } from "@/components/Brand";
import { useI18n } from "@/components/LanguageProvider";
import type { AIConfigStatus } from "@/lib/api/ai-config";
import type { AuthUser } from "@/lib/api/auth";
import type { DataSource } from "@/lib/config";
import type { HealthState } from "@/lib/types";
import { cx } from "@/lib/cx";
import { ModelAccessCard, type ModelSignal } from "../settings/ModelAccessCard";
import styles from "./Welcome.module.css";

const NAME_MAX = 30;
const TOPIC_MAX = 200;

/** 「第3章_栈和队列.pdf」→「第3章 栈和队列」：保留供已有工具与测试复用 */
export function topicFromFileName(name: string): string {
  return name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim().slice(0, TOPIC_MAX);
}

interface WelcomeProps {
  user: AuthUser;
  source: DataSource;
  health: HealthState;
  modelSignal: ModelSignal;
  modelConfigured: boolean | null;
  modelError?: string;
  busy: boolean;
  error: string;
  onCheckHealth: () => void;
  onConfigChange: (config: AIConfigStatus, saved: boolean) => void;
  onRename: (name: string) => Promise<void>;
  onUploadAvatar: (file: File) => Promise<void>;
  onRemoveAvatar: () => Promise<void>;
  onStartInterview: () => void;
  onDemo: () => void;
  onSkip: () => void;
}

export function Welcome({
  user, source, health, modelSignal, modelConfigured, modelError = "", busy, error,
  onCheckHealth, onConfigChange, onRename, onUploadAvatar, onRemoveAvatar,
  onStartInterview, onDemo, onSkip,
}: WelcomeProps) {
  const { tx } = useI18n();
  const [step, setStep] = useState<1 | 2>(1);
  const [name, setName] = useState(
    user.displayName && user.displayName !== "学习者" && user.displayName !== "演示学习者" ? user.displayName : "",
  );
  const [savingStep, setSavingStep] = useState(false);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarFailed, setAvatarFailed] = useState(false);
  const [localError, setLocalError] = useState("");
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setAvatarFailed(false);
  }, [user.avatarUrl]);

  const showPhoto = Boolean(user.avatarUrl && !avatarFailed);
  const previewLetter = (name.trim() || user.avatarText || tx("学")).slice(0, 1);

  const pickAvatar = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      setLocalError(tx("头像图片不能超过 2 MB。"));
      return;
    }
    setAvatarBusy(true);
    setLocalError("");
    try {
      await onUploadAvatar(file);
    } catch (caught) {
      setLocalError(caught instanceof Error ? caught.message : tx("头像上传失败，请重试。"));
    } finally {
      setAvatarBusy(false);
    }
  };

  const nextStep = async (event: FormEvent) => {
    event.preventDefault();
    if (savingStep || busy) return;
    const trimmed = name.trim();
    setLocalError("");
    if (trimmed && trimmed !== user.displayName) {
      setSavingStep(true);
      try {
        await onRename(trimmed);
      } catch (caught) {
        setLocalError(caught instanceof Error ? caught.message : tx("称呼保存失败，请重试。"));
        setSavingStep(false);
        return;
      }
      setSavingStep(false);
    }
    setStep(2);
  };

  return (
    <div className={styles.wrap}>
      <div className={cx(styles.shell, step === 2 && styles.shellWide)}>
        <div className={styles.topBar}>
          <BrandLockup size={32} />
          <ol className={styles.steps} aria-label={tx("初次引导步骤")}>
            <li className={cx(styles.stepItem, step === 1 && styles.stepActive, step > 1 && styles.stepDone)}>
              <span className={styles.stepNum} aria-hidden>{step > 1 ? <Check size={11} /> : "1"}</span>
              <span>{tx("认识你")}</span>
            </li>
            <li className={styles.stepLine} aria-hidden />
            <li className={cx(styles.stepItem, step === 2 && styles.stepActive)}>
              <span className={styles.stepNum} aria-hidden>2</span>
              <span>{tx("接入模型")}</span>
            </li>
          </ol>
        </div>

        {step === 1 ? (
          <form key="step-1" className={styles.pane} onSubmit={(event) => void nextStep(event)}>
            <div className={styles.heading}>
              <h1>{tx("欢迎来到 KnowGap")}</h1>
              <p className={styles.lead}>
                {tx("先填个称呼和头像，连上模型后 AI 会通过一次简短对话记住你在学什么与喜欢的讲法。")}
              </p>
            </div>

            <div className={styles.profileRow}>
              <button
                type="button"
                className={styles.avatarPick}
                disabled={avatarBusy || busy}
                onClick={() => fileRef.current?.click()}
                aria-label={tx("上传头像")}
                title={tx("点击上传头像")}
              >
                <span className={cx(styles.avatarCircle, showPhoto && styles.avatarPhoto)}>
                  {showPhoto ? (
                    /* eslint-disable-next-line @next/next/no-img-element -- local backend avatar URL */
                    <img src={user.avatarUrl} alt="" onError={() => setAvatarFailed(true)} />
                  ) : (
                    previewLetter
                  )}
                </span>
                <span className={styles.avatarMask} aria-hidden>
                  <Camera size={16} />
                </span>
              </button>
              <input
                ref={fileRef}
                type="file"
                hidden
                accept="image/png,image/jpeg,image/webp,image/gif"
                aria-label={tx("选择头像图片")}
                onChange={(event) => void pickAvatar(event)}
              />
              <div className={styles.profileInputs}>
                <label className={styles.fieldLabel} htmlFor="welcome-display-name">
                  {tx("怎么称呼你")} <small>{tx("（可选）")}</small>
                </label>
                <input
                  id="welcome-display-name"
                  className={styles.input}
                  value={name}
                  maxLength={NAME_MAX}
                  placeholder={tx("例如：小林、Alex")}
                  disabled={savingStep || busy}
                  onChange={(event) => { setName(event.target.value); setLocalError(""); }}
                />
                <div className={styles.avatarMeta}>
                  <span>{avatarBusy ? tx("正在上传头像…") : tx("支持 PNG / JPG / WebP，随时可在设置里修改")}</span>
                  {showPhoto && (
                    <button
                      type="button"
                      className={styles.textLink}
                      disabled={avatarBusy || busy}
                      onClick={() => {
                        setAvatarBusy(true);
                        void onRemoveAvatar().finally(() => setAvatarBusy(false));
                      }}
                    >
                      {tx("移除头像")}
                    </button>
                  )}
                </div>
              </div>
            </div>

            {(localError || error) && <p className={styles.error} role="alert">{localError || error}</p>}

            <button className={styles.primary} type="submit" disabled={savingStep || busy}>
              <span>{savingStep ? tx("正在保存…") : tx("下一步：接入模型")}</span>
              <ArrowRight size={14} aria-hidden />
            </button>

            <div className={styles.links}>
              <button type="button" disabled={busy || savingStep} onClick={onDemo}>{tx("先逛逛演示空间")}</button>
              <button type="button" disabled={busy || savingStep} onClick={onSkip}>{tx("跳过，直接进入")}</button>
            </div>
          </form>
        ) : (
          <div key="step-2" className={styles.pane}>
            <div className={styles.heading}>
              <h1>{tx("连接你的 AI 模型")}</h1>
              <p className={styles.lead}>
                {tx("接入任意模型后开启首次对话，AI 会了解你在学什么与讲解偏好，自动填充长期记忆。")}
              </p>
            </div>

            <div className={styles.modelStage}>
              <ModelAccessCard
                plain
                source={source}
                health={health}
                signal={modelSignal}
                setupError={modelError}
                onCheckHealth={onCheckHealth}
                onConfigChange={onConfigChange}
              />
            </div>

            {error && <p className={styles.error} role="alert">{error}</p>}

            <div className={styles.stepActions}>
              <button type="button" className={styles.backBtn} disabled={busy} onClick={() => setStep(1)}>
                <ArrowLeft size={14} aria-hidden />
                <span>{tx("上一步")}</span>
              </button>
              <div className={styles.rightActions}>
                <button type="button" className={styles.secondary} disabled={busy} onClick={onSkip}>
                  {tx("暂不配置，先进入")}
                </button>
                <button
                  type="button"
                  className={styles.primary}
                  disabled={busy || (source === "api" && modelConfigured !== true)}
                  onClick={onStartInterview}
                >
                  <Sparkles size={14} aria-hidden />
                  <span>{busy ? tx("正在开启…") : tx("开始首次对话")}</span>
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** 启动读取本机档案与进度时的过渡；只有后端连不上才需要用户重试 */
export function StartupStatus({ error, onRetry }: {
  error: string;
  onRetry: () => void;
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

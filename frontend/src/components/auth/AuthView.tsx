"use client";

import { useEffect, useState, type FormEvent } from "react";
import Image from "next/image";
import { Eye, EyeOff, MailCheck } from "lucide-react";
import { sendEmailCode } from "@/lib/api/auth";
import { useI18n } from "@/components/LanguageProvider";
import { cx } from "@/lib/cx";
import { ThemeToggle } from "../ThemeToggle";
import { InteractiveParticleBackground } from "./InteractiveParticleBackground";
import styles from "./AuthView.module.css";

const EMAIL_CHECK = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function AuthView({
  error,
  onLogin,
  onRegister,
  onDemo,
}: {
  error: string;
  onLogin: (email: string, credential: { password?: string; code?: string }) => Promise<void>;
  onRegister: (email: string, password: string, displayName: string, code: string) => Promise<void>;
  onDemo: () => void;
}) {
  const { t } = useI18n();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [loginMethod, setLoginMethod] = useState<"password" | "code">("password");
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [sendingCode, setSendingCode] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [demoCode, setDemoCode] = useState("");
  const [codeSentHint, setCodeSentHint] = useState("");
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState("");

  useEffect(() => {
    if (countdown <= 0) return;
    const timer = window.setInterval(() => {
      setCountdown((prev) => (prev <= 1 ? 0 : prev - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [countdown]);

  const needsCode = mode === "register" || loginMethod === "code";
  const needsPassword = mode === "register" || loginMethod === "password";

  const handleSendCode = async () => {
    const trimmedEmail = email.trim();
    if (!EMAIL_CHECK.test(trimmedEmail)) {
      setLocalError(t("auth.invalidEmail"));
      return;
    }
    if (sendingCode || countdown > 0) return;
    setSendingCode(true);
    setLocalError("");
    setDemoCode("");
    setCodeSentHint("");
    try {
      const res = await sendEmailCode(trimmedEmail, mode === "register" ? "register" : "login");
      setCountdown(60);
      if (res.delivery === "demo" && res.demoCode) {
        setDemoCode(res.demoCode);
      } else {
        setCodeSentHint(t("auth.codeSent"));
      }
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : t("auth.sendFailed"));
    } finally {
      setSendingCode(false);
    }
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmedEmail = email.trim();
    if (!EMAIL_CHECK.test(trimmedEmail)) {
      setLocalError(t("auth.invalidEmail"));
      return;
    }
    if (needsCode && code.trim().length !== 6) {
      setLocalError(t("auth.invalidCode"));
      return;
    }
    if (needsPassword && password.length < 6) {
      setLocalError(t("auth.passwordTooShort"));
      return;
    }
    if (busy) return;
    setBusy(true);
    setLocalError("");
    try {
      if (mode === "login") {
        if (loginMethod === "code") {
          await onLogin(trimmedEmail, { code: code.trim() });
        } else {
          await onLogin(trimmedEmail, { password });
        }
      } else {
        await onRegister(trimmedEmail, password, displayName, code.trim());
      }
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : t("auth.actionFailed"));
    } finally {
      setBusy(false);
    }
  };

  const shownError = localError || error;
  const canSubmit =
    Boolean(email.trim()) &&
    (!needsCode || code.trim().length === 6) &&
    (!needsPassword || password.length >= 6) &&
    !busy;

  return (
    <div className={styles.canvas}>
      <InteractiveParticleBackground />
      <div className={styles.themeSlot}>
        <ThemeToggle />
      </div>
      <section className={styles.card} aria-labelledby="auth-title">
        <div className={styles.brandHead}>
          <Image src="/brand/knowgap-logo-v1.png" alt="" width={36} height={36} className={styles.logo} />
          <h1 id="auth-title">{mode === "login" ? t("auth.loginTitle") : t("auth.registerTitle")}</h1>
          <p>{t("auth.subtitle")}</p>
        </div>

        <div className={styles.modeSwitch} role="tablist" aria-label={t("auth.modeAria")}>
          <span
            className={cx(styles.modeThumb, mode === "register" && styles.modeThumbRight)}
            aria-hidden
          />
          <button
            type="button"
            role="tab"
            aria-selected={mode === "login"}
            className={cx(styles.modeBtn, mode === "login" && styles.modeBtnActive)}
            onClick={() => {
              setMode("login");
              setLocalError("");
              setDemoCode("");
              setCodeSentHint("");
            }}
          >
            {t("auth.loginTab")}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "register"}
            className={cx(styles.modeBtn, mode === "register" && styles.modeBtnActive)}
            onClick={() => {
              setMode("register");
              setLocalError("");
              setDemoCode("");
              setCodeSentHint("");
            }}
          >
            {t("auth.registerTab")}
          </button>
        </div>

        <form className={styles.form} onSubmit={(e) => void handleSubmit(e)}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>{t("auth.email")}</span>
            <input
              type="email"
              className={styles.input}
              value={email}
              maxLength={120}
              autoComplete="email"
              placeholder="name@example.com"
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>

          {/* 验证码输入区（注册必填，或登录切到验证码登录时展开） */}
          <div className={cx(styles.collapseField, needsCode && styles.collapseFieldOpen)}>
            <div className={styles.collapseInner}>
              <div className={styles.field}>
                <div className={styles.fieldLabelRow}>
                  <span className={styles.fieldLabel}>{t("auth.code")}</span>
                  {mode === "login" && (
                    <button
                      type="button"
                      className={styles.inlineSwitchBtn}
                      onClick={() => {
                        setLoginMethod("password");
                        setLocalError("");
                      }}
                    >
                      {t("auth.usePassword")}
                    </button>
                  )}
                </div>
                <div className={styles.codeRow}>
                  <input
                    className={styles.input}
                    value={code}
                    maxLength={6}
                    inputMode="numeric"
                    tabIndex={needsCode ? 0 : -1}
                    placeholder={t("auth.codePlaceholder")}
                    onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
                  />
                  <button
                    type="button"
                    className={styles.sendCodeBtn}
                    disabled={sendingCode || countdown > 0 || !email.trim()}
                    tabIndex={needsCode ? 0 : -1}
                    onClick={() => void handleSendCode()}
                  >
                    {sendingCode ? t("auth.sending") : countdown > 0 ? t("auth.resend", { seconds: countdown }) : t("auth.getCode")}
                  </button>
                </div>
                {demoCode && (
                  <button
                    type="button"
                    className={styles.demoMailToast}
                    onClick={() => setCode(demoCode)}
                    title={t("auth.demoCodeTitle")}
                  >
                    <MailCheck size={14} aria-hidden />
                    <span>
                      {t("auth.demoCode")}<strong>{demoCode}</strong>{t("auth.demoCodeClick")}
                    </span>
                  </button>
                )}
                {codeSentHint && <p className={styles.codeHint}>{codeSentHint}</p>}
              </div>
            </div>
          </div>

          {/* 注册模式显示昵称 */}
          <div className={cx(styles.collapseField, mode === "register" && styles.collapseFieldOpen)}>
            <div className={styles.collapseInner}>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>
                  {t("auth.nickname")} <small>{t("common.optional")}</small>
                </span>
                <input
                  className={styles.input}
                  value={displayName}
                  maxLength={30}
                  tabIndex={mode === "register" ? 0 : -1}
                  placeholder={t("auth.nicknamePlaceholder")}
                  onChange={(event) => setDisplayName(event.target.value)}
                />
              </label>
            </div>
          </div>

          {/* 密码输入区（注册必填，或密码登录时展示） */}
          <div className={cx(styles.collapseField, needsPassword && styles.collapseFieldOpen)}>
            <div className={styles.collapseInner}>
              <div className={styles.field}>
                <div className={styles.fieldLabelRow}>
                  <span className={styles.fieldLabel}>{mode === "register" ? t("auth.setPassword") : t("auth.password")}</span>
                  {mode === "login" && (
                    <button
                      type="button"
                      className={styles.inlineSwitchBtn}
                      onClick={() => {
                        setLoginMethod("code");
                        setLocalError("");
                      }}
                    >
                      {t("auth.useCode")}
                    </button>
                  )}
                </div>
                <div className={styles.passwordWrap}>
                  <input
                    className={styles.input}
                    type={showPassword ? "text" : "password"}
                    value={password}
                    maxLength={128}
                    tabIndex={needsPassword ? 0 : -1}
                    autoComplete={mode === "login" ? "current-password" : "new-password"}
                    placeholder={mode === "login" ? t("auth.passwordPlaceholderLogin") : t("auth.passwordPlaceholderRegister")}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                  <button
                    type="button"
                    className={styles.eyeBtn}
                    tabIndex={needsPassword ? 0 : -1}
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? t("auth.hidePassword") : t("auth.showPassword")}
                  >
                    {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                </div>
              </div>
            </div>
          </div>

          {shownError && (
            <p className={styles.error} role="alert">
              {shownError}
            </p>
          )}

          <button type="submit" className={styles.submitBtn} disabled={!canSubmit}>
            {busy ? t("common.processing") : mode === "login" ? t("auth.login") : t("auth.register")}
          </button>
        </form>

        <button type="button" className={styles.demoBtn} onClick={onDemo}>
          {t("auth.demo")}
        </button>
      </section>
    </div>
  );
}

"use client";

import { useEffect, useState, type FormEvent } from "react";
import Image from "next/image";
import { Eye, EyeOff, MailCheck } from "lucide-react";
import { sendEmailCode } from "@/lib/api/auth";
import { cx } from "@/lib/cx";
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
      setLocalError("请先输入有效的邮箱地址（如 name@example.com）。");
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
        setCodeSentHint("验证码已发送至你的邮箱，5 分钟内有效。");
      }
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : "验证码发送失败，请稍后重试。");
    } finally {
      setSendingCode(false);
    }
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmedEmail = email.trim();
    if (!EMAIL_CHECK.test(trimmedEmail)) {
      setLocalError("请输入有效的邮箱地址（如 name@example.com）。");
      return;
    }
    if (needsCode && code.trim().length !== 6) {
      setLocalError("请输入 6 位数字邮箱验证码。");
      return;
    }
    if (needsPassword && password.length < 6) {
      setLocalError("密码长度至少为 6 位。");
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
      setLocalError(err instanceof Error ? err.message : "操作失败，请稍后重试。");
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
      <section className={styles.card} aria-labelledby="auth-title">
        <div className={styles.brandHead}>
          <Image src="/brand/knowgap-logo-v1.png" alt="" width={36} height={36} className={styles.logo} />
          <h1 id="auth-title">{mode === "login" ? "欢迎回到 KnowGap" : "创建你的学习账号"}</h1>
          <p>把一次提问，接成持续的学习</p>
        </div>

        <div className={styles.modeSwitch} role="tablist" aria-label="登录或注册">
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
            邮箱登录
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
            邮箱注册
          </button>
        </div>

        <form className={styles.form} onSubmit={(e) => void handleSubmit(e)}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>邮箱</span>
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
                  <span className={styles.fieldLabel}>邮箱验证码</span>
                  {mode === "login" && (
                    <button
                      type="button"
                      className={styles.inlineSwitchBtn}
                      onClick={() => {
                        setLoginMethod("password");
                        setLocalError("");
                      }}
                    >
                      改用密码登录
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
                    placeholder="6 位数字验证码"
                    onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
                  />
                  <button
                    type="button"
                    className={styles.sendCodeBtn}
                    disabled={sendingCode || countdown > 0 || !email.trim()}
                    tabIndex={needsCode ? 0 : -1}
                    onClick={() => void handleSendCode()}
                  >
                    {sendingCode ? "发送中…" : countdown > 0 ? `${countdown}s 后重发` : "获取验证码"}
                  </button>
                </div>
                {demoCode && (
                  <button
                    type="button"
                    className={styles.demoMailToast}
                    onClick={() => setCode(demoCode)}
                    title="点击一键填入验证码"
                  >
                    <MailCheck size={14} aria-hidden />
                    <span>
                      本机演示验证码：<strong>{demoCode}</strong>（点击一键填入）
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
                  显示昵称 <small>(可选)</small>
                </span>
                <input
                  className={styles.input}
                  value={displayName}
                  maxLength={30}
                  tabIndex={mode === "register" ? 0 : -1}
                  placeholder="用于首页问候与侧栏头像展示"
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
                  <span className={styles.fieldLabel}>{mode === "register" ? "设置密码" : "密码"}</span>
                  {mode === "login" && (
                    <button
                      type="button"
                      className={styles.inlineSwitchBtn}
                      onClick={() => {
                        setLoginMethod("code");
                        setLocalError("");
                      }}
                    >
                      改用验证码登录
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
                    placeholder={mode === "login" ? "输入登录密码" : "设置密码（至少 6 位）"}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                  <button
                    type="button"
                    className={styles.eyeBtn}
                    tabIndex={needsPassword ? 0 : -1}
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? "隐藏密码" : "显示密码"}
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
            {busy ? "处理中…" : mode === "login" ? "登录" : "验证邮箱并注册"}
          </button>
        </form>

        <button type="button" className={styles.demoBtn} onClick={onDemo}>
          使用本机演示身份直接进入 →
        </button>
      </section>
    </div>
  );
}

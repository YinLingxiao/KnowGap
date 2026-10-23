"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { CircleCheck, Cpu, Eye, EyeOff, LogIn, LogOut, RefreshCw, ShieldCheck, TriangleAlert } from "lucide-react";
import type { HealthState } from "@/hooks/useWorkbench";
import { getAIConfig, saveAIConfig, testAIConfig, type AIAuthMode, type AIConfigInput, type AIConfigStatus, type ChatGPTStatus } from "@/lib/api/ai-config";
import { getChatGPTStatus, listChatGPTModels, logoutChatGPT, startChatGPT } from "@/lib/api/chatgpt";
import { toApiError, type ApiError } from "@/lib/api/errors";
import { API_BASE_URL, type DataSource } from "@/lib/config";
import { cx } from "@/lib/cx";
import {
  MODEL_PROVIDERS,
  checkBaseUrl,
  findProvider,
  hostOf,
  matchProvider,
  normalizeBaseUrl,
  checkVertexAdc,
  vertexAdcBaseUrl,
  type ModelProviderId,
} from "@/lib/modelProviders";
import { Button } from "../ui/Button";
import styles from "./Settings.module.css";

/** 页面本次打开后从诊断请求结果观察到的模型信号 */
export type ModelSignal =
  | { state: "unknown" }
  | { state: "ok"; at: number }
  | { state: "unavailable"; at: number; detail?: string };

type Tone = "ok" | "error" | "idle" | "mock";

interface Form {
  provider: ModelProviderId;
  baseUrl: string;
  model: string;
  apiKey: string;
  authMode: AIAuthMode;
  projectId: string;
  location: string;
}

type Outcome = { tone: "ok" | "error"; text: string } | null;

const HEALTH_TEXT: Record<HealthState, string> = { checking: "检测中", online: "在线", offline: "离线" };

function formFrom(config: AIConfigStatus | null): Form {
  if (!config || !config.baseUrl) {
    const first = MODEL_PROVIDERS[0];
    return { provider: first.id, baseUrl: first.baseUrl, model: "", apiKey: "", authMode: "api_key", projectId: "", location: "global" };
  }
  const authMode = config.authMode ?? "api_key";
  return { provider: authMode === "chatgpt" ? "chatgpt" : matchProvider(config.baseUrl).id,
    baseUrl: config.baseUrl, model: config.model, apiKey: "",
    authMode, projectId: config.projectId ?? "", location: config.location ?? "global" };
}

function describeLoadError(error: ApiError): string {
  if (error.kind === "not_found") return "后端还没有模型配置接口，请更新后端到包含 /api/ai/config 的版本。";
  if (error.kind === "network") return "无法连接后端服务，请先启动后端。";
  return error.message;
}

interface ModelAccessCardProps {
  source: DataSource;
  health: HealthState;
  signal: ModelSignal;
  onCheckHealth: () => void;
  /** 读取或保存配置后回报，用于侧栏提示与清除过期的模型错误 */
  onConfigChange: (config: AIConfigStatus, saved: boolean) => void;
  plain?: boolean;
}

export function ModelAccessCard({ source, health, signal, onCheckHealth, onConfigChange, plain = false }: ModelAccessCardProps) {
  const fieldId = useId();
  const [config, setConfig] = useState<AIConfigStatus | null>(null);
  const [loading, setLoading] = useState(source === "api");
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [form, setForm] = useState<Form>(() => formFrom(null));
  const [showKey, setShowKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);
  /** 最近一次测试通过时填写的值；保存的正是这组值时，视为已验证 */
  const [passedInput, setPassedInput] = useState<string | null>(null);
  const [verified, setVerified] = useState(false);
  const [savedAt, setSavedAt] = useState(0);
  const [chatgpt, setChatgpt] = useState<ChatGPTStatus | null>(null);
  const [chatgptBusy, setChatgptBusy] = useState(false);
  const [chatgptError, setChatgptError] = useState("");
  const [models, setModels] = useState<Array<{ id: string; name: string }>>([]);
  const pollRef = useRef<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await getAIConfig();
      setConfig(data);
      setForm(formFrom(data));
      if (data.chatgpt) setChatgpt(data.chatgpt);
      if (data.authMode === "chatgpt" && data.chatgpt?.connected && data.chatgpt.planEnabled) {
        void listChatGPTModels().then(setModels).catch(() => setModels([]));
      }
      onConfigChange(data, false);
    } catch (error) {
      setLoadError(toApiError(error));
    } finally {
      setLoading(false);
    }
  }, [onConfigChange]);

  useEffect(() => {
    if (source === "api") void load();
  }, [source, load]);

  const update = (patch: Partial<Form>) => {
    setForm((current) => ({ ...current, ...patch }));
    setOutcome(null);
  };

  const refreshChatGPT = useCallback(async () => {
    const status = await getChatGPTStatus();
    setChatgpt(status);
    if (status.connected && status.planEnabled) {
      void listChatGPTModels().then(setModels).catch(() => setModels([]));
    }
    return status;
  }, []);

  useEffect(() => () => {
    if (pollRef.current) window.clearTimeout(pollRef.current);
  }, []);

  const connectChatGPT = async () => {
    const popup = window.open("about:blank", "_blank");
    setChatgptBusy(true);
    setChatgptError("");
    try {
      const { authorizeUrl, expiresIn } = await startChatGPT();
      if (popup) popup.location.href = authorizeUrl;
      else window.open(authorizeUrl, "_blank", "noopener,noreferrer");
      const deadline = Date.now() + Math.min(expiresIn * 1000, 10 * 60 * 1000);
      const tick = async () => {
        if (Date.now() > deadline) {
          setChatgptBusy(false);
          setChatgptError("等待授权超时，请重新点击登录。");
          return;
        }
        try {
          const status = await refreshChatGPT();
          if (status.connected) {
            setChatgptBusy(false);
            setOutcome({ tone: "ok", text: status.planEnabled
              ? "ChatGPT 已连接，可以保存模型。"
              : "ChatGPT 已登录，但未授予套餐用量权限；请重新连接并同意使用套餐额度。" });
            return;
          }
        } catch (error) {
          setChatgptError(toApiError(error).message);
        }
        pollRef.current = window.setTimeout(() => void tick(), 2000);
      };
      pollRef.current = window.setTimeout(() => void tick(), 1500);
    } catch (error) {
      if (popup) popup.close();
      setChatgptError(toApiError(error).message);
      setChatgptBusy(false);
    }
  };

  const disconnectChatGPT = async () => {
    setChatgptBusy(true);
    setChatgptError("");
    try {
      const result = await logoutChatGPT();
      const status = await refreshChatGPT();
      setChatgpt(status);
      setOutcome({ tone: result.revoked ? "ok" : "error", text: result.revoked
        ? "已断开 ChatGPT，套餐额度不再使用。"
        : result.warning || "已在本地断开 ChatGPT。" });
    } catch (error) {
      setChatgptError(toApiError(error).message);
    } finally {
      setChatgptBusy(false);
    }
  };

  const isChatGPT = form.provider === "chatgpt";
  const isADC = form.provider === "vertex" && form.authMode === "adc";
  const baseUrl = normalizeBaseUrl(isChatGPT ? "https://api.openai.com/v1"
    : isADC ? vertexAdcBaseUrl(form.projectId, form.location) : form.baseUrl);
  const sameService = Boolean(!isChatGPT && config?.hasApiKey
    && (config.authMode ?? "api_key") === "api_key" && baseUrl === config.baseUrl);
  const urlProblem = isChatGPT ? null
    : (isADC ? checkVertexAdc(form.projectId, form.location) : null) ?? checkBaseUrl(baseUrl);
  const keyMissing = !isADC && !isChatGPT && !form.apiKey.trim() && !sameService;
  const chatgptUsable = Boolean(isChatGPT && chatgpt?.connected && chatgpt?.planEnabled);
  const ready = Boolean(baseUrl && form.model.trim() && !urlProblem && !keyMissing && (!isChatGPT || chatgptUsable));
  const authMode: AIAuthMode = isChatGPT ? "chatgpt" : isADC ? "adc" : "api_key";
  const dirty = !config || baseUrl !== config.baseUrl || form.model.trim() !== config.model
    || authMode !== (config.authMode ?? "api_key") || Boolean(form.apiKey.trim());
  const busy = testing || saving || chatgptBusy;
  const input: AIConfigInput = { baseUrl, model: form.model, apiKey: isADC || isChatGPT ? "" : form.apiKey,
    authMode, projectId: isADC ? form.projectId : "", location: isADC ? form.location : "global" };
  const fingerprint = JSON.stringify([baseUrl, form.model.trim(), input.apiKey.trim(), input.authMode, input.projectId, input.location]);

  const runTest = async () => {
    setTesting(true);
    setOutcome(null);
    try {
      const result = await testAIConfig(input);
      setPassedInput(fingerprint);
      if (!dirty) setVerified(true);
      setOutcome({
        tone: "ok",
        text: `连接正常：${result.model} 返回了符合要求的结构化诊断。${dirty ? "记得保存后才会生效。" : ""}`,
      });
    } catch (error) {
      setPassedInput(null);
      if (!dirty) setVerified(false);
      setOutcome({ tone: "error", text: toApiError(error).message });
    } finally {
      setTesting(false);
    }
  };

  const runSave = async () => {
    setSaving(true);
    setOutcome(null);
    try {
      const data = await saveAIConfig(input);
      const tested = passedInput === fingerprint;
      setConfig(data);
      setForm(formFrom(data));
      if (data.chatgpt) setChatgpt(data.chatgpt);
      setShowKey(false);
      setVerified(tested);
      setPassedInput(null);
      setSavedAt(Date.now());
      onConfigChange(data, true);
      setOutcome({ tone: "ok", text: tested ? "已保存，立即生效。" : "已保存，立即生效。建议测试一次连接。" });
    } catch (error) {
      setOutcome({ tone: "error", text: toApiError(error).message });
    } finally {
      setSaving(false);
    }
  };

  // 状态：Mock → 读取失败 → 本次已验证 → 诊断报告不可用 → 未配置 → 诊断成功 → 已配置未测试
  let tone: Tone = "idle";
  let label = "读取中";
  let hint = "正在读取后端的模型配置…";
  if (source === "mock") {
    tone = "mock";
    label = "Mock 模式";
    hint = "当前使用前端模拟数据，不调用模型，也不连接后端。";
  } else if (loadError) {
    tone = "error";
    label = "无法读取";
    hint = describeLoadError(loadError);
  } else if (config) {
    const signalAfterSave = signal.state !== "unknown" && signal.at > savedAt;
    if (verified) {
      tone = "ok";
      label = "连接正常";
      hint = "当前配置已通过连接测试。";
    } else if (signal.state === "unavailable" && signalAfterSave) {
      tone = "error";
      label = "不可用";
      hint = signal.detail || "诊断时后端没有拿到有效的模型结果。";
    } else if (!config.configured) {
      tone = "error";
      label = config.authMode === "chatgpt" && !config.chatgpt?.connected ? "未连接" : "未配置";
      hint = config.authMode === "chatgpt" && !config.chatgpt?.connected
        ? "请先使用 ChatGPT 登录并同意套餐用量权限，再选择模型保存。"
        : "选择认证方式并填写模型配置后保存，无需重启后端。";
    } else if (signal.state === "ok" && signalAfterSave) {
      tone = "ok";
      label = "可用";
      hint = "本次打开页面后已收到模型诊断。";
    } else {
      label = "已配置";
      hint = "配置已填写，尚未测试连接。";
    }
  }

  const provider = findProvider(form.provider);

  return (
    <section className={plain ? styles.embed : cx(styles.card, styles.cardWide)} aria-labelledby={plain ? undefined : `${fieldId}-title`}>
      {!plain && (
      <header className={styles.cardHead}>
        <span className={styles.cardIcon} aria-hidden>
          <Cpu size={16} />
        </span>
        <div className={styles.cardTitleBlock}>
          <h3 id={`${fieldId}-title`} className={styles.cardTitle}>
            模型接入
          </h3>
          <p className={styles.cardDesc}>支持 OpenAI 兼容服务、Vertex 原生 Gemini 接口，以及使用 ChatGPT 套餐额度的登录授权；不需要为 ChatGPT 套餐填写 API Key。</p>
        </div>
        <span className={cx(styles.chip, styles[`chip_${tone}`])}>
          <span className={styles.chipDot} aria-hidden />
          {label}
        </span>
      </header>
      )}

      <dl className={styles.statusGrid}>
        <div className={styles.statusRow}>
          <dt>后端服务</dt>
          <dd>
            {source === "mock" ? (
              <span className={styles.muted}>未使用</span>
            ) : (
              <>
                <span className={cx(styles.dot, styles[`dot_${health}`])} aria-hidden />
                {HEALTH_TEXT[health]}
                <code className={styles.inlineCode}>{hostOf(API_BASE_URL) || API_BASE_URL}</code>
                <button className={styles.rowAction} onClick={onCheckHealth} disabled={health === "checking"}>
                  <RefreshCw size={12} aria-hidden />
                  检测
                </button>
              </>
            )}
          </dd>
        </div>
        <div className={styles.statusRow}>
          <dt>模型</dt>
          <dd className={styles.statusHint}>{hint}</dd>
        </div>
      </dl>

      {source === "mock" ? (
        <p className={styles.stepNote}>
          在 <code>frontend/.env.local</code> 设置 <code>NEXT_PUBLIC_DATA_SOURCE=api</code> 并重启前端后，可在这里配置模型。
        </p>
      ) : loadError ? (
        <div className={styles.cardActions}>
          <Button size="sm" icon={<RefreshCw size={13} />} onClick={() => void load()} loading={loading}>
            重新读取
          </Button>
        </div>
      ) : (
        <form
          className={styles.guide}
          aria-busy={loading || undefined}
          onSubmit={(event) => {
            event.preventDefault();
            if (ready && !busy) void runSave();
          }}
        >
          <div className={styles.providers} role="radiogroup" aria-label="模型服务商">
            {MODEL_PROVIDERS.map((item) => {
              const selected = item.id === form.provider;
              return (
                <button
                  key={item.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  disabled={loading || busy}
                  className={cx(styles.provider, selected && styles.providerOn)}
                  onClick={() => {
                    if (selected) return;
                    const back = Boolean(config && item.id !== "custom" && (
                      item.id === "chatgpt" ? config.authMode === "chatgpt"
                        : matchProvider(config.baseUrl).id === item.id));
                    update({
                      provider: item.id,
                      baseUrl: item.id === "custom" ? form.baseUrl : back ? config!.baseUrl : item.baseUrl,
                      model: back ? config!.model : "",
                      apiKey: "",
                      authMode: item.id === "chatgpt" ? "chatgpt" : back ? config!.authMode ?? "api_key" : "api_key",
                      projectId: back ? config!.projectId ?? "" : "",
                      location: back ? config!.location ?? "global" : "global",
                    });
                  }}
                >
                  <span className={styles.providerName}>{item.name}</span>
                  <span className={styles.providerHost}>{hostOf(item.baseUrl) || "任意兼容地址"}</span>
                </button>
              );
            })}
          </div>

          <div className={styles.fields}>
            {form.provider === "vertex" && (
              <label className={cx(styles.field, styles.fieldFull)} htmlFor={`${fieldId}-auth`}>
                <span id={`${fieldId}-auth-label`} className={styles.fieldLabel}>认证方式</span>
                <select id={`${fieldId}-auth`} className={styles.input} value={form.authMode}
                  aria-labelledby={`${fieldId}-auth-label`}
                  disabled={loading || busy} aria-describedby={`${fieldId}-auth-hint`}
                  onChange={(event) => {
                    setShowKey(false);
                    update({ authMode: event.target.value as AIAuthMode, apiKey: "", baseUrl: findProvider("vertex").baseUrl });
                  }}>
                  <option value="api_key">API Key · Vertex Express</option>
                  <option value="adc">ADC · 应用默认凭证</option>
                </select>
                <span id={`${fieldId}-auth-hint`} className={styles.fieldHint}>
                  {isADC ? "适用于组织禁止 API Key 的项目。读取运行后端的系统账号下的本机 ADC，自动刷新访问令牌；不会绕过组织权限。" : "使用 Vertex Express API Key，无需项目 ID 或区域。"}
                </span>
              </label>
            )}
            {isADC && <>
              <label className={styles.field} htmlFor={`${fieldId}-project`}>
                <span className={styles.fieldLabel}>Google Cloud 项目 ID</span>
                <input id={`${fieldId}-project`} className={styles.input} value={form.projectId}
                  onChange={(event) => update({ projectId: event.target.value })} placeholder="例如 my-learning-project"
                  spellCheck={false} autoComplete="off" disabled={loading || busy} />
              </label>
              <label className={styles.field} htmlFor={`${fieldId}-location`}>
                <span className={styles.fieldLabel}>区域</span>
                <input id={`${fieldId}-location`} className={styles.input} value={form.location}
                  onChange={(event) => update({ location: event.target.value })} placeholder="global 或 us-central1"
                  spellCheck={false} autoComplete="off" disabled={loading || busy} />
              </label>
              <p className={cx(styles.stepNote, styles.fieldFull)}>
                首次使用：在运行后端的同一电脑和系统账号下执行 <code>gcloud auth application-default login</code>。
                项目需启用 Vertex AI API、结算及模型调用权限；组织使用联合身份或服务账号模拟时，按管理员的 ADC 登录流程操作。
              </p>
            </>}
            {isChatGPT && (
              <div className={cx(styles.field, styles.fieldFull)}>
                <span className={styles.fieldLabel}>ChatGPT 账号</span>
                <div className={styles.accountRow}>
                  <span className={styles.accountState}>
                    {chatgpt?.connected ? <CircleCheck size={14} aria-hidden /> : <LogIn size={14} aria-hidden />}
                    {chatgpt?.connected ? (chatgpt.email || "已连接") : "未连接"}
                    {chatgpt?.connected && (chatgpt.planEnabled ? " · 套餐额度已授权" : " · 未授权套餐额度")}
                  </span>
                  {chatgpt?.connected ? (
                    <button type="button" className={styles.rowAction} onClick={() => void disconnectChatGPT()} disabled={chatgptBusy}>
                      <LogOut size={12} aria-hidden />{chatgptBusy ? "正在断开…" : "断开"}
                    </button>
                  ) : (
                    <button type="button" className={styles.rowAction} onClick={() => void connectChatGPT()} disabled={chatgptBusy}>
                      <LogIn size={12} aria-hidden />{chatgptBusy ? "等待浏览器授权…" : "Continue with ChatGPT"}
                    </button>
                  )}
                </div>
                <span className={styles.fieldHint}>
                  浏览器会打开 ChatGPT 授权页；登录并同意套餐用量后回到这里。授权令牌只保存在后端本机，页面不接触令牌。
                </span>
                {chatgptError && <span className={styles.fieldError} role="alert">{chatgptError}</span>}
                {chatgpt?.error && <span className={styles.fieldError} role="alert">{chatgpt.error}</span>}
                {chatgpt?.connected && !chatgpt.planEnabled && (
                  <button type="button" className={styles.rowAction} onClick={() => void connectChatGPT()} disabled={chatgptBusy}>
                    <LogIn size={12} aria-hidden />重新授权套餐
                  </button>
                )}
              </div>
            )}
            {!isChatGPT && (
            <label className={styles.field} htmlFor={`${fieldId}-url`}>
              <span id={`${fieldId}-url-label`} className={styles.fieldLabel}>接口地址</span>
              <input
                id={`${fieldId}-url`}
                aria-labelledby={`${fieldId}-url-label`}
                className={cx(styles.input, urlProblem && styles.inputInvalid)}
                value={isADC ? baseUrl : form.baseUrl}
                readOnly={isADC}
                onChange={(event) => update({ baseUrl: event.target.value, provider: matchProvider(event.target.value).id })}
                placeholder="https://…/v1"
                spellCheck={false}
                autoComplete="off"
                disabled={loading || busy}
                aria-invalid={Boolean(urlProblem)}
                aria-describedby={`${fieldId}-url-hint`}
              />
              <span id={`${fieldId}-url-hint`} className={cx(styles.fieldHint, urlProblem && styles.fieldError)}>
                {urlProblem ?? (isADC ? "按项目 ID 和区域自动生成，使用原生 Gemini 接口。" : provider.urlHint) ?? "包含版本前缀，不含 /chat/completions"}
              </span>
            </label>
            )}
            <label className={styles.field} htmlFor={`${fieldId}-model`}>
              <span id={`${fieldId}-model-label`} className={styles.fieldLabel}>模型</span>
              <input
                id={`${fieldId}-model`}
                aria-labelledby={`${fieldId}-model-label`}
                className={styles.input}
                list={isChatGPT ? `${fieldId}-models` : undefined}
                value={form.model}
                onChange={(event) => update({ model: event.target.value })}
                placeholder={provider.modelHint}
                spellCheck={false}
                autoComplete="off"
                disabled={loading || busy}
              />
              {isChatGPT && (
                <datalist id={`${fieldId}-models`}>
                  {models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
                </datalist>
              )}
              <span className={styles.fieldHint}>
                {isChatGPT
                  ? (models.length > 0 ? "从当前账号可用模型中选择；也可直接填写模型 ID。" : "连接后可读取账号可用模型；也可直接填写模型 ID。")
                  : "示例仅供参考，以服务商控制台为准"}
              </span>
            </label>
            {!isADC && !isChatGPT && <label className={cx(styles.field, styles.fieldFull)} htmlFor={`${fieldId}-key`}>
              <span id={`${fieldId}-key-label`} className={styles.fieldLabel}>{provider.keyLabel ?? "API Key"}</span>
              <span className={styles.keyInput}>
                <input
                  id={`${fieldId}-key`}
                  aria-labelledby={`${fieldId}-key-label`}
                  className={styles.input}
                  type={showKey ? "text" : "password"}
                  value={form.apiKey}
                  onChange={(event) => update({ apiKey: event.target.value })}
                  placeholder={sameService ? "已保存，留空则保持不变" : `填写服务商提供的 ${provider.keyLabel ?? "API Key"}`}
                  spellCheck={false}
                  autoComplete="new-password"
                  data-1p-ignore
                  data-lpignore="true"
                  disabled={loading || busy}
                  aria-describedby={`${fieldId}-key-hint`}
                />
                <button
                  type="button"
                  className={styles.reveal}
                  onClick={() => setShowKey((value) => !value)}
                  aria-label={showKey ? "隐藏密钥" : "显示密钥"}
                  disabled={!form.apiKey}
                >
                  {showKey ? <EyeOff size={14} aria-hidden /> : <Eye size={14} aria-hidden />}
                </button>
              </span>
              <span id={`${fieldId}-key-hint`} className={styles.fieldHint}>
                {config?.hasApiKey && !sameService ? "更换了接口地址，需要重新填写密钥。" : "密钥不会回显；后端只返回「是否已保存」。"}
                {provider.keyHint && <> {provider.keyHint}</>}
              </span>
            </label>}
          </div>

          <div className={styles.formActions}>
            {outcome && (
              <p className={cx(styles.outcome, outcome.tone === "ok" ? styles.outcomeOk : styles.outcomeError)} role="status">
                {outcome.tone === "ok" ? <CircleCheck size={14} aria-hidden /> : <TriangleAlert size={14} aria-hidden />}
                {outcome.text}
              </p>
            )}
            <Button
              size="sm"
              onClick={() => void runTest()}
              disabled={!ready || saving}
              loading={testing}
              title="用当前填写的值调用一次模型，不保存；可能消耗少量额度"
            >
              测试连接
            </Button>
            <Button size="sm" variant="primary" type="submit" disabled={!ready || !dirty || testing} loading={saving}>
              保存
            </Button>
          </div>

          <p className={styles.safety}>
            <ShieldCheck size={14} aria-hidden />
            {isChatGPT ? "ChatGPT 授权令牌由后端保存并自动刷新，不返回页面；请求使用套餐额度，不会自动切换成 API Key 计费。测试会真实调用一次模型。"
              : isADC ? "ADC 凭证由 Google 认证库读取，访问令牌不保存到应用配置、也不返回页面。测试会真实调用一次模型。"
              : "密钥只发送到本机后端，保存在后端数据目录，页面不存储。测试会真实调用一次模型。"}
          </p>
        </form>
      )}
    </section>
  );
}

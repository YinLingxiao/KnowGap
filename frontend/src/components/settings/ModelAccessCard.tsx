"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { CircleCheck, Cpu, Eye, EyeOff, RefreshCw, ShieldCheck, TriangleAlert } from "lucide-react";
import type { HealthState } from "@/hooks/useWorkbench";
import { getAIConfig, saveAIConfig, testAIConfig, type AIConfigInput, type AIConfigStatus } from "@/lib/api/ai-config";
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
}

type Outcome = { tone: "ok" | "error"; text: string } | null;

const HEALTH_TEXT: Record<HealthState, string> = { checking: "检测中", online: "在线", offline: "离线" };

function formFrom(config: AIConfigStatus | null): Form {
  if (!config || !config.baseUrl) {
    const first = MODEL_PROVIDERS[0];
    return { provider: first.id, baseUrl: first.baseUrl, model: "", apiKey: "" };
  }
  return { provider: matchProvider(config.baseUrl).id, baseUrl: config.baseUrl, model: config.model, apiKey: "" };
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
}

export function ModelAccessCard({ source, health, signal, onCheckHealth, onConfigChange }: ModelAccessCardProps) {
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

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await getAIConfig();
      setConfig(data);
      setForm(formFrom(data));
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

  const baseUrl = normalizeBaseUrl(form.baseUrl);
  const sameService = Boolean(config?.hasApiKey && baseUrl === config.baseUrl);
  const urlProblem = checkBaseUrl(form.baseUrl);
  const keyMissing = !form.apiKey.trim() && !sameService;
  const ready = Boolean(baseUrl && form.model.trim() && !urlProblem && !keyMissing);
  const dirty = !config || baseUrl !== config.baseUrl || form.model.trim() !== config.model || Boolean(form.apiKey.trim());
  const busy = testing || saving;
  const input: AIConfigInput = { baseUrl, model: form.model, apiKey: form.apiKey };
  const fingerprint = JSON.stringify([baseUrl, form.model.trim(), form.apiKey.trim()]);

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
      label = "未配置";
      hint = "填写接口地址、模型和 API Key 后保存，无需重启后端。";
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
    <section className={cx(styles.card, styles.cardWide)} aria-labelledby={`${fieldId}-title`}>
      <header className={styles.cardHead}>
        <span className={styles.cardIcon} aria-hidden>
          <Cpu size={16} />
        </span>
        <div className={styles.cardTitleBlock}>
          <h3 id={`${fieldId}-title`} className={styles.cardTitle}>
            模型接入
          </h3>
          <p className={styles.cardDesc}>诊断与引导由后端调用模型完成，支持兼容 OpenAI Chat Completions、可输出 JSON 的服务。</p>
        </div>
        <span className={cx(styles.chip, styles[`chip_${tone}`])}>
          <span className={styles.chipDot} aria-hidden />
          {label}
        </span>
      </header>

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
                    const back = config && item.baseUrl && item.baseUrl === config.baseUrl;
                    update({
                      provider: item.id,
                      baseUrl: item.id === "custom" ? form.baseUrl : item.baseUrl,
                      model: back ? config.model : "",
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
            <label className={styles.field} htmlFor={`${fieldId}-url`}>
              <span className={styles.fieldLabel}>接口地址</span>
              <input
                id={`${fieldId}-url`}
                className={cx(styles.input, urlProblem && styles.inputInvalid)}
                value={form.baseUrl}
                onChange={(event) => update({ baseUrl: event.target.value, provider: matchProvider(event.target.value).id })}
                placeholder="https://…/v1"
                spellCheck={false}
                autoComplete="off"
                disabled={loading || busy}
                aria-invalid={Boolean(urlProblem)}
                aria-describedby={`${fieldId}-url-hint`}
              />
              <span id={`${fieldId}-url-hint`} className={cx(styles.fieldHint, urlProblem && styles.fieldError)}>
                {urlProblem ?? "包含版本前缀，不含 /chat/completions"}
              </span>
            </label>
            <label className={styles.field} htmlFor={`${fieldId}-model`}>
              <span className={styles.fieldLabel}>模型</span>
              <input
                id={`${fieldId}-model`}
                className={styles.input}
                value={form.model}
                onChange={(event) => update({ model: event.target.value })}
                placeholder={provider.modelHint}
                spellCheck={false}
                autoComplete="off"
                disabled={loading || busy}
              />
              <span className={styles.fieldHint}>示例仅供参考，以服务商控制台为准</span>
            </label>
            <label className={cx(styles.field, styles.fieldFull)} htmlFor={`${fieldId}-key`}>
              <span className={styles.fieldLabel}>API Key</span>
              <span className={styles.keyInput}>
                <input
                  id={`${fieldId}-key`}
                  className={styles.input}
                  type={showKey ? "text" : "password"}
                  value={form.apiKey}
                  onChange={(event) => update({ apiKey: event.target.value })}
                  placeholder={sameService ? "已保存，留空则保持不变" : "填写服务商提供的 API Key"}
                  spellCheck={false}
                  autoComplete="new-password"
                  data-1p-ignore
                  data-lpignore="true"
                  disabled={loading || busy}
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
              <span className={styles.fieldHint}>
                {config?.hasApiKey && !sameService ? "更换了接口地址，需要重新填写密钥。" : "密钥不会回显；后端只返回「是否已保存」。"}
              </span>
            </label>
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
            密钥只发送到本机后端，保存在后端数据目录，页面不存储。测试会真实调用一次模型。
          </p>
        </form>
      )}
    </section>
  );
}

"use client";

import { useEffect, useId, useRef, useState } from "react";
import { CircleCheck, Eye, EyeOff, LogIn, LogOut, ShieldCheck, TriangleAlert } from "lucide-react";
import type { ChatGPTStatus } from "@/lib/api/ai-config";
import { getChatGPTStatus, logoutChatGPT, startChatGPT } from "@/lib/api/chatgpt";
import { toApiError } from "@/lib/api/errors";
import {
  MODELS_CHANGED_EVENT, type AuthMode, type ModelCandidate, type ModelLibraryClient, type ModelTags, type ProviderPublic,
} from "@/lib/api/model-library";
import {
  checkBaseUrl, checkVertexAdc, findProvider, normalizeBaseUrl, presetAuthModes, suggestModelTags, vertexAdcBaseUrl,
  type ModelProviderId,
} from "@/lib/modelProviders";
import { cx } from "@/lib/cx";
import { Button } from "../ui/Button";
import { EditorDialog } from "./EditorDialog";
import { ModelList } from "./ModelList";
import styles from "./ModelLibrary.module.css";

interface Draft {
  name: string;
  preset: ModelProviderId;
  baseUrl: string;
  authMode: AuthMode;
  apiKey: string;
  projectId: string;
  location: string;
}

type Outcome = { tone: "ok" | "error"; text: string } | null;

const AUTH_LABEL: Record<AuthMode, string> = {
  api_key: "API Key",
  adc: "ADC · 应用默认凭证",
  chatgpt: "ChatGPT 登录",
};

function blank(preset: ModelProviderId = "deepseek"): Draft {
  const item = findProvider(preset);
  return {
    name: item.name,
    preset,
    baseUrl: item.baseUrl,
    authMode: preset === "chatgpt" ? "chatgpt" : "api_key",
    apiKey: "",
    projectId: "",
    location: "global",
  };
}

function fromProvider(provider: ProviderPublic): Draft {
  return {
    name: provider.name,
    preset: provider.preset,
    baseUrl: provider.baseUrl,
    authMode: provider.authMode,
    apiKey: "",
    projectId: provider.projectId,
    location: provider.location || "global",
  };
}

interface ProviderEditorProps {
  provider: ProviderPublic | null;
  client: ModelLibraryClient;
  onClose: () => void;
  onChange: () => Promise<void>;
  onCreated: (id: string) => void;
  onDeleted: (text: string) => void;
}

export function ProviderEditor({ provider, client, onClose, onChange, onCreated, onDeleted }: ProviderEditorProps) {
  const fieldId = useId();
  const [draft, setDraft] = useState<Draft>(() => provider ? fromProvider(provider) : blank());
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const [probeId, setProbeId] = useState(provider?.models[0]?.id ?? "");
  const [manual, setManual] = useState(false);
  const [manualId, setManualId] = useState("");
  const [manualName, setManualName] = useState("");
  const [candidates, setCandidates] = useState<ModelCandidate[] | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [fetchQuery, setFetchQuery] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [chatgpt, setChatgpt] = useState<ChatGPTStatus | null>(null);
  const [chatgptError, setChatgptError] = useState("");
  const [chatgptBusy, setChatgptBusy] = useState(false);
  const pollRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (pollRef.current) window.clearTimeout(pollRef.current);
  }, []);

  useEffect(() => {
    if (draft.preset !== "chatgpt") return;
    let cancelled = false;
    void getChatGPTStatus()
      .then((status) => { if (!cancelled) setChatgpt(status); })
      .catch((error: unknown) => { if (!cancelled) setChatgptError(toApiError(error).message); });
    return () => { cancelled = true; };
  }, [draft.preset]);

  const presetInfo = findProvider(draft.preset);
  const modes = presetAuthModes(draft.preset);
  const isChatGPT = draft.preset === "chatgpt";
  const isADC = draft.authMode === "adc";
  const baseUrl = isChatGPT
    ? findProvider("chatgpt").baseUrl
    : isADC
      ? vertexAdcBaseUrl(draft.projectId, draft.location)
      : normalizeBaseUrl(draft.baseUrl);
  const urlProblem = isChatGPT
    ? null
    : isADC
      ? checkVertexAdc(draft.projectId, draft.location)
      : (!draft.baseUrl.trim() ? "请填写服务地址。" : checkBaseUrl(draft.baseUrl));
  const sameService = Boolean(
    provider && provider.hasApiKey && provider.authMode === "api_key" && draft.authMode === "api_key" && baseUrl === provider.baseUrl,
  );
  const urlChanged = Boolean(provider && baseUrl !== provider.baseUrl);
  const keyMissing = draft.authMode === "api_key" && !draft.apiKey.trim() && !sameService;
  const credentialDirty = !provider || urlChanged || draft.authMode !== provider.authMode
    || Boolean(draft.apiKey.trim())
    || (isADC && (draft.projectId.trim() !== provider.projectId || (draft.location.trim() || "global") !== (provider.location || "global")));
  const chatgptUsable = Boolean(chatgpt?.connected && chatgpt.planEnabled);
  const canSave = Boolean(draft.name.trim()) && !urlProblem && !keyMissing && !busy && !chatgptBusy;
  const canTest = Boolean(provider && probeId && !credentialDirty && !busy && (!isChatGPT || chatgptUsable));

  const patch = (next: Partial<Draft>) => {
    setDraft((current) => ({ ...current, ...next }));
    setOutcome(null);
  };

  const applyPreset = (preset: ModelProviderId) => {
    const item = findProvider(preset);
    const previous = findProvider(draft.preset);
    const authMode: AuthMode = preset === "chatgpt" ? "chatgpt" : preset === "vertex" && draft.authMode === "adc" ? "adc" : "api_key";
    patch({
      preset,
      name: draft.name.trim() === previous.name || !draft.name.trim() ? item.name : draft.name,
      baseUrl: !draft.baseUrl.trim() || draft.baseUrl === previous.baseUrl ? item.baseUrl : draft.baseUrl,
      authMode,
      apiKey: authMode === "api_key" ? draft.apiKey : "",
    });
  };

  const changed = async () => {
    await onChange();
    window.dispatchEvent(new Event(MODELS_CHANGED_EVENT));
  };

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setOutcome(null);
    try {
      await action();
    } catch (error: unknown) {
      setOutcome({ tone: "error", text: toApiError(error).message });
    } finally {
      setBusy(false);
    }
  };

  const save = () => run(async () => {
    if (provider) {
      await client.updateProvider(provider.id, {
        name: draft.name.trim(),
        baseUrl,
        authMode: draft.authMode,
        ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
        projectId: isADC ? draft.projectId.trim() : "",
        location: isADC ? draft.location.trim() || "global" : "global",
      });
      setDraft((current) => ({ ...current, apiKey: "" }));
      setShowKey(false);
      await changed();
      setOutcome({ tone: "ok", text: "已保存。" });
      return;
    }
    const created = await client.createProvider({
      name: draft.name.trim(),
      preset: draft.preset,
      baseUrl,
      authMode: draft.authMode,
      ...(draft.authMode === "api_key" ? { apiKey: draft.apiKey.trim() } : {}),
      ...(isADC ? { projectId: draft.projectId.trim(), location: draft.location.trim() || "global" } : {}),
    });
    await changed();
    onCreated(created.id);
  });

  const refreshChatGPT = async () => {
    const status = await getChatGPTStatus();
    setChatgpt(status);
    return status;
  };

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
            setOutcome({
              tone: status.planEnabled ? "ok" : "error",
              text: status.planEnabled ? "ChatGPT 已连接。" : "ChatGPT 已登录，但未授予套餐用量权限。",
            });
            return;
          }
        } catch (error: unknown) {
          setChatgptError(toApiError(error).message);
        }
        pollRef.current = window.setTimeout(() => void tick(), 2000);
      };
      pollRef.current = window.setTimeout(() => void tick(), 1500);
    } catch (error: unknown) {
      if (popup) popup.close();
      setChatgptError(toApiError(error).message);
      setChatgptBusy(false);
    }
  };

  const disconnectChatGPT = async () => {
    setChatgptBusy(true);
    setChatgptError("");
    try {
      await logoutChatGPT();
      setChatgpt(await refreshChatGPT());
      setOutcome({ tone: "ok", text: "已断开 ChatGPT。" });
    } catch (error: unknown) {
      setChatgptError(toApiError(error).message);
    } finally {
      setChatgptBusy(false);
    }
  };

  const remove = () => run(async () => {
    if (!provider) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      setBusy(false);
      return;
    }
    const result = await client.deleteProvider(provider.id);
    await changed();
    const roles: Record<string, string> = { logic: "逻辑", vision: "视觉", memory: "后台与记忆" };
    const parts = [
      result.affected.defaultModel ? "默认模型已清空" : "",
      result.affected.serviceModels.length ? `已改回沿用默认：${result.affected.serviceModels.map((role) => roles[role] ?? role).join("、")}` : "",
    ].filter(Boolean);
    onDeleted(parts.length ? `已删除。${parts.join("，")}。` : "已删除。");
  });

  const existing = new Set((provider?.models ?? []).map((model) => model.id));
  const fetchVisible = (candidates ?? []).filter((item) => {
    const needle = fetchQuery.trim().toLowerCase();
    return !needle || item.id.toLowerCase().includes(needle) || item.name.toLowerCase().includes(needle);
  });

  return (
    <div className={styles.fields}>
      {!provider && (
        <label className={styles.field} htmlFor={`${fieldId}-preset`}>
          <span className={styles.label}>服务商预设</span>
          <select id={`${fieldId}-preset`} className={styles.select} aria-label="服务商预设" value={draft.preset} disabled={busy} onChange={(event) => applyPreset(event.target.value as ModelProviderId)}>
            {["deepseek", "qwen", "ark", "moonshot", "zhipu", "openai", "chatgpt", "vertex", "custom"].map((id) => (
              <option key={id} value={id}>{findProvider(id).name}</option>
            ))}
          </select>
        </label>
      )}
      <label className={styles.field} htmlFor={`${fieldId}-name`}>
        <span className={styles.label}>名称</span>
        <input id={`${fieldId}-name`} className={styles.input} aria-label="服务商名称" value={draft.name} disabled={busy} onChange={(event) => patch({ name: event.target.value })} />
      </label>
      <label className={styles.field} htmlFor={`${fieldId}-auth`}>
        <span className={styles.label}>认证方式</span>
        <select
          id={`${fieldId}-auth`}
          className={styles.select}
          aria-label="认证方式"
          value={draft.authMode}
          disabled={busy || modes.length === 1}
          onChange={(event) => {
            const authMode = event.target.value as AuthMode;
            patch({
              authMode,
              apiKey: "",
              baseUrl: authMode === "api_key" && draft.preset === "vertex" ? findProvider("vertex").baseUrl : draft.baseUrl,
            });
          }}
        >
          {modes.map((mode) => (
            <option key={mode} value={mode}>
              {draft.preset === "vertex" && mode === "api_key" ? "API Key · Vertex Express" : AUTH_LABEL[mode]}
            </option>
          ))}
        </select>
        {isADC && <span className={styles.hint}>适用于组织禁止 API Key 的项目。读取运行后端的本机 ADC，不把访问令牌返回页面。</span>}
      </label>
      {isADC && (
        <div className={styles.pair}>
          <label className={styles.field} htmlFor={`${fieldId}-project`}>
            <span className={styles.label}>Google Cloud 项目 ID</span>
            <input id={`${fieldId}-project`} className={styles.input} aria-label="Google Cloud 项目 ID" value={draft.projectId} disabled={busy} spellCheck={false} autoComplete="off" onChange={(event) => patch({ projectId: event.target.value })} />
          </label>
          <label className={styles.field} htmlFor={`${fieldId}-location`}>
            <span className={styles.label}>区域</span>
            <input id={`${fieldId}-location`} className={styles.input} aria-label="区域" value={draft.location} disabled={busy} spellCheck={false} autoComplete="off" placeholder="global 或 us-central1" onChange={(event) => patch({ location: event.target.value })} />
          </label>
        </div>
      )}
      {isChatGPT && (
        <div className={styles.field}>
          <span className={styles.label}>ChatGPT 账号</span>
          <div className={styles.account}>
            <span className={styles.accountState}>
              {chatgpt?.connected ? <CircleCheck size={14} aria-hidden /> : <LogIn size={14} aria-hidden />}
              {chatgpt?.connected ? (chatgpt.email || "已连接") : "未连接"}
              {chatgpt?.connected && (chatgpt.planEnabled ? " · 套餐额度已授权" : " · 未授权套餐额度")}
            </span>
            {chatgpt?.connected ? (
              <button type="button" className={styles.textButton} disabled={chatgptBusy} onClick={() => void disconnectChatGPT()}>
                <LogOut size={12} aria-hidden />{chatgptBusy ? "正在断开…" : "断开"}
              </button>
            ) : (
              <button type="button" className={styles.textButton} disabled={chatgptBusy} onClick={() => void connectChatGPT()}>
                <LogIn size={12} aria-hidden />{chatgptBusy ? "等待浏览器授权…" : "Continue with ChatGPT"}
              </button>
            )}
          </div>
          <span className={styles.hint}>浏览器会打开授权页。令牌只留在后端本机，页面不接触令牌。</span>
          {chatgpt?.connected && !chatgpt.planEnabled && (
            <button type="button" className={styles.textButton} disabled={chatgptBusy} onClick={() => void connectChatGPT()}>重新授权套餐</button>
          )}
          {chatgptError && <span className={styles.hintError} role="alert">{chatgptError}</span>}
        </div>
      )}
      {!isChatGPT && (
        <label className={styles.field} htmlFor={`${fieldId}-url`}>
          <span className={styles.label}>接口地址</span>
          <input
            id={`${fieldId}-url`}
            className={cx(styles.input, urlProblem && styles.inputInvalid)}
            aria-label="接口地址"
            value={isADC ? baseUrl : draft.baseUrl}
            readOnly={isADC}
            disabled={busy}
            spellCheck={false}
            autoComplete="off"
            placeholder="https://…/v1"
            aria-invalid={Boolean(urlProblem)}
            onChange={(event) => patch({ baseUrl: event.target.value })}
          />
          <span className={cx(styles.hint, urlProblem && styles.hintError)}>
            {urlProblem ?? presetInfo.urlHint ?? "包含版本前缀，不含 /chat/completions"}
          </span>
        </label>
      )}
      {!isADC && !isChatGPT && (
        <label className={styles.field} htmlFor={`${fieldId}-key`}>
          <span className={styles.label}>{presetInfo.keyLabel ?? "API Key"}</span>
          <span className={styles.keyInput}>
            <input
              id={`${fieldId}-key`}
              className={styles.input}
              aria-label={presetInfo.keyLabel ?? "API Key"}
              type={showKey ? "text" : "password"}
              value={draft.apiKey}
              disabled={busy}
              spellCheck={false}
              autoComplete="new-password"
              data-1p-ignore
              data-lpignore="true"
              placeholder={sameService ? "已保存，留空则保持不变" : `填写服务商提供的 ${presetInfo.keyLabel ?? "API Key"}`}
              onChange={(event) => patch({ apiKey: event.target.value })}
            />
            <button type="button" className={styles.reveal} aria-label={showKey ? "隐藏密钥" : "显示密钥"} disabled={!draft.apiKey} onClick={() => setShowKey((value) => !value)}>
              {showKey ? <EyeOff size={14} aria-hidden /> : <Eye size={14} aria-hidden />}
            </button>
          </span>
          <span className={cx(styles.hint, urlChanged && draft.authMode === "api_key" && styles.hintError)}>
            {urlChanged && draft.authMode === "api_key" ? "更换了接口地址，需要重新填写密钥。" : "密钥不会回显；后端只返回「是否已保存」。"}
            {presetInfo.keyHint ? ` ${presetInfo.keyHint}` : ""}
          </span>
        </label>
      )}

      {provider && (
        <>
          <div className={styles.probe}>
            <label className={cx(styles.field, styles.grow)}>
              <span className={styles.label}>检查所用模型</span>
              <select className={styles.select} aria-label="检查所用模型" value={probeId} disabled={busy || provider.models.length === 0} onChange={(event) => setProbeId(event.target.value)}>
                {provider.models.length === 0 && <option value="">先添加模型</option>}
                {provider.models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
              </select>
            </label>
            <Button size="sm" disabled={!canTest} onClick={() => void run(async () => {
              const result = await client.testModel(provider.id, probeId);
              setOutcome({ tone: "ok", text: result.structuredOutput ? `连接正常：${result.model} 返回了符合要求的结构化诊断。` : `连接正常：${result.model}。` });
            })}>
              检查
            </Button>
          </div>
          {credentialDirty && <p className={styles.note}>地址或密钥有未保存的修改。先保存，再检查或获取模型列表。</p>}
          <ModelList
            models={provider.models}
            busy={busy}
            onToggle={(model, enabled) => void run(async () => {
              await client.updateModel(provider.id, model.id, { enabled });
              await changed();
            })}
            onDelete={(model) => void run(async () => {
              await client.deleteModel(provider.id, model.id);
              if (probeId === model.id) setProbeId("");
              await changed();
            })}
            onTags={(model, tags: ModelTags) => void run(async () => {
              await client.updateModel(provider.id, model.id, { tags });
              await changed();
            })}
          />
          <div className={styles.toolbar}>
            <Button size="sm" disabled={!provider || credentialDirty || busy || (provider.authMode === "api_key" && !provider.hasApiKey)} onClick={() => void run(async () => {
              const list = await client.fetchModels(provider.id);
              setCandidates(list);
              setPicked([]);
              setFetchQuery("");
            })}>
              获取模型列表
            </Button>
            <Button size="sm" aria-expanded={manual} onClick={() => setManual((value) => !value)}>手动添加模型</Button>
          </div>
          {manual && (
            <div className={styles.manual}>
              <label className={cx(styles.field, styles.grow)}>
                <span className={styles.label}>模型 ID</span>
                <input className={styles.input} aria-label="模型 ID" value={manualId} disabled={busy} spellCheck={false} placeholder={presetInfo.modelHint} onChange={(event) => setManualId(event.target.value)} />
              </label>
              <label className={cx(styles.field, styles.grow)}>
                <span className={styles.label}>显示名称</span>
                <input className={styles.input} aria-label="显示名称" value={manualName} disabled={busy} placeholder="留空则与模型 ID 相同" onChange={(event) => setManualName(event.target.value)} />
              </label>
              <Button size="sm" variant="primary" disabled={busy || !manualId.trim()} onClick={() => void run(async () => {
                const id = manualId.trim();
                await client.createModel(provider.id, { id, ...(manualName.trim() ? { name: manualName.trim() } : {}), tags: suggestModelTags(id) });
                setManualId("");
                setManualName("");
                setProbeId((current) => current || id);
                await changed();
              })}>
                添加
              </Button>
            </div>
          )}
        </>
      )}

      {outcome && (
        <p className={cx(styles.outcome, outcome.tone === "ok" ? styles.ok : styles.bad)} role={outcome.tone === "ok" ? "status" : "alert"}>
          {outcome.tone === "ok" ? <CircleCheck size={14} aria-hidden /> : <TriangleAlert size={14} aria-hidden />}
          {outcome.text}
        </p>
      )}
      <div className={styles.actions}>
        {provider && (
          <Button size="sm" variant={confirmDelete ? "danger" : "ghost"} disabled={busy} onClick={() => void remove()}>
            {confirmDelete ? "确认删除" : "删除服务商"}
          </Button>
        )}
        <Button size="sm" onClick={onClose} disabled={busy}>关闭</Button>
        <Button size="sm" variant="primary" disabled={!canSave} onClick={() => void save()}>保存</Button>
      </div>
      <p className={styles.safety}>
        <ShieldCheck size={14} aria-hidden />
        {isChatGPT ? "ChatGPT 授权令牌由后端保存，不返回页面。" : isADC ? "ADC 访问令牌不写入应用配置，也不返回页面。" : "密钥只发到本机后端。页面不保存、不回显已存密钥。"}
      </p>

      <EditorDialog open={candidates !== null} title="可用模型" description="勾选后加入这个服务商，已添加的不会重复写入。" onClose={() => setCandidates(null)}>
        <label className={cx(styles.search, styles.searchBlock)}>
          <input value={fetchQuery} aria-label="搜索可添加的模型" placeholder="搜索可添加的模型" onChange={(event) => setFetchQuery(event.target.value)} />
        </label>
        {candidates && candidates.length === 0 ? (
          <p className={styles.note}>这个服务商没有返回模型，可以手动添加。</p>
        ) : (
          <div>
            {fetchVisible.map((item) => {
              const added = existing.has(item.id);
              const checked = added || picked.includes(item.id);
              return (
                <label key={item.id} className={styles.check}>
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={added || busy}
                    aria-label={added ? `${item.name} 已添加` : `加入 ${item.name}`}
                    onChange={(event) => setPicked((current) => event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id))}
                  />
                  <span>{item.name}{item.name !== item.id ? ` · ${item.id}` : ""}{added ? " · 已添加" : ""}</span>
                </label>
              );
            })}
          </div>
        )}
        <div className={styles.actions}>
          <Button size="sm" onClick={() => setCandidates(null)}>关闭</Button>
          <Button
            size="sm"
            variant="primary"
            disabled={!provider || busy || picked.length === 0}
            onClick={() => void run(async () => {
              if (!provider || !candidates) return;
              for (const item of candidates) {
                if (!picked.includes(item.id) || existing.has(item.id)) continue;
                await client.createModel(provider.id, { id: item.id, name: item.name, tags: item.tags });
              }
              setCandidates(null);
              await changed();
              setOutcome({ tone: "ok", text: "已加入所选模型。" });
            })}
          >
            加入所选
          </Button>
        </div>
      </EditorDialog>
    </div>
  );
}

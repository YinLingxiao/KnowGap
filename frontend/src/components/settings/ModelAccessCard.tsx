"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { CircleCheck, Cpu, RefreshCw, TriangleAlert } from "lucide-react";
import type { HealthState } from "@/hooks/useWorkbench";
import type { AIConfigStatus } from "@/lib/api/ai-config";
import { toApiError } from "@/lib/api/errors";
import {
  MODELS_CHANGED_EVENT, modelLibraryApi, parseModelKey,
  type CatalogModel, type ModelLibraryClient, type ProviderPublic,
} from "@/lib/api/model-library";
import { API_BASE_URL, type DataSource } from "@/lib/config";
import { cx } from "@/lib/cx";
import { hostOf } from "@/lib/modelProviders";
import { Button } from "../ui/Button";
import { EditorDialog } from "./EditorDialog";
import { ProviderEditor } from "./ProviderEditor";
import { ProviderList } from "./ProviderList";
import settings from "./Settings.module.css";
import styles from "./ModelLibrary.module.css";

export type ModelSignal =
  | { state: "unknown" }
  | { state: "ok"; at: number }
  | { state: "unavailable"; at: number; detail?: string };

const HEALTH_TEXT: Record<HealthState, string> = { checking: "检测中", online: "在线", offline: "离线" };

interface ModelAccessCardProps {
  source: DataSource;
  health: HealthState;
  signal: ModelSignal;
  onCheckHealth: () => void;
  onConfigChange: (config: AIConfigStatus, saved: boolean) => void;
  setupError?: string;
  plain?: boolean;
  client?: ModelLibraryClient;
}

function groupCatalog(models: CatalogModel[]) {
  const groups: Array<{ id: string; name: string; models: CatalogModel[] }> = [];
  for (const model of models) {
    let group = groups.find((item) => item.id === model.providerId);
    if (!group) {
      group = { id: model.providerId, name: model.providerName, models: [] };
      groups.push(group);
    }
    group.models.push(model);
  }
  return groups;
}

function statusOf(providers: ProviderPublic[], key: string | null): AIConfigStatus {
  let provider: ProviderPublic | undefined;
  let modelId = "";
  if (key) {
    try {
      const parsed = parseModelKey(key);
      provider = providers.find((item) => item.id === parsed.providerId);
      modelId = parsed.modelId;
    } catch {
      provider = undefined;
    }
  }
  const model = provider?.models.find((item) => item.id === modelId);
  return {
    baseUrl: provider?.baseUrl ?? "",
    model: model?.name || modelId,
    hasApiKey: Boolean(provider?.hasApiKey),
    configured: Boolean(provider?.enabled && model?.enabled),
    authMode: provider?.authMode ?? "api_key",
    projectId: provider?.projectId ?? "",
    location: provider?.location || "global",
  };
}

export function ModelAccessCard({
  source, health, signal, onCheckHealth, onConfigChange, plain = false, client, setupError = "",
}: ModelAccessCardProps) {
  const fieldId = useId();
  const library = client ?? modelLibraryApi;
  const active = Boolean(client) || source === "api";
  const [providers, setProviders] = useState<ProviderPublic[]>([]);
  const [catalog, setCatalog] = useState<CatalogModel[]>([]);
  const [defaultKey, setDefaultKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(active);
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);
  const [editor, setEditor] = useState<string | null | undefined>(undefined);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const reload = useCallback(async (saved = false) => {
    const [nextProviders, nextCatalog, loadedDefault] = await Promise.all([
      library.listProviders(),
      library.listSelectableModels(),
      library.getDefaultModel(),
    ]);
    let nextDefault = loadedDefault;
    let picked = false;
    // 默认模型为空或已不可用、但有可选模型时，自动选第一个，否则会一直卡在「先连上 AI 模型」
    const firstKey = nextCatalog[0]?.key;
    if (firstKey && !nextCatalog.some((model) => model.key === loadedDefault.key)) {
      nextDefault = await library.setDefaultModel(firstKey);
      picked = true;
    }
    setProviders(nextProviders);
    setCatalog(nextCatalog);
    setDefaultKey(nextDefault.key);
    const status = statusOf(nextProviders, nextDefault.key);
    onConfigChange(status, saved || picked);
    return status;
  }, [library, onConfigChange]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setLoading(true);
    setLoadError("");
    void reload()
      .catch((error: unknown) => {
        if (cancelled) return;
        const apiError = toApiError(error);
        setLoadError(apiError.kind === "not_found" ? "后端还没有模型库接口。" : apiError.kind === "network" ? "无法连接后端服务，请先启动后端。" : apiError.message);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [active, reload]);

  const editing = editor ? providers.find((item) => item.id === editor) ?? null : null;
  const groups = groupCatalog(catalog);
  const defaultMissing = Boolean(defaultKey && !catalog.some((model) => model.key === defaultKey));

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setNotice(null);
    try {
      await action();
    } catch (error: unknown) {
      setNotice({ tone: "error", text: toApiError(error).message });
    } finally {
      setBusy(false);
    }
  };

  const saveAndTest = () => void run(async () => {
    const key = defaultKey && catalog.some((model) => model.key === defaultKey) ? defaultKey : catalog[0]?.key;
    if (!key) return;
    if (key !== defaultKey) await library.setDefaultModel(key);
    const status = await reload(true);
    window.dispatchEvent(new Event(MODELS_CHANGED_EVENT));
    setNotice(status.configured
      ? { tone: "ok", text: "正在测试连接，通过后会离开此页。" }
      : { tone: "error", text: "默认模型还不可用。请确认服务商已启用，并且密钥或 ChatGPT 套餐已授权。" });
  });

  return (
    <section className={plain ? settings.embed : cx(settings.card, settings.cardWide)} aria-labelledby={plain ? undefined : `${fieldId}-title`} aria-busy={loading || undefined}>
      {!plain && (
        <header className={settings.cardHead}>
          <span className={settings.cardIcon} aria-hidden><Cpu size={16} /></span>
          <div className={settings.cardTitleBlock}>
            <h3 id={`${fieldId}-title`} className={settings.cardTitle}>模型接入</h3>
            <p className={settings.cardDesc}>服务商保存地址和密钥，下面挂多个模型。新对话使用默认模型。</p>
          </div>
        </header>
      )}

      <dl className={settings.statusGrid}>
        <div className={settings.statusRow}>
          <dt>后端服务</dt>
          <dd>
            {source === "mock" && !client ? <span className={settings.muted}>未使用</span> : (
              <>
                <span className={cx(settings.dot, settings[`dot_${health}`])} aria-hidden />
                {HEALTH_TEXT[health]}
                <code className={settings.inlineCode}>{hostOf(API_BASE_URL) || API_BASE_URL}</code>
                <button type="button" className={settings.rowAction} onClick={onCheckHealth} disabled={health === "checking"}>
                  <RefreshCw size={12} aria-hidden />
                  检测
                </button>
              </>
            )}
          </dd>
        </div>
      </dl>

      {!active ? (
        <p className={settings.stepNote}>
          在 <code>frontend/.env.local</code> 设置 <code>NEXT_PUBLIC_DATA_SOURCE=api</code> 并重启前端后，可在这里管理模型库。
        </p>
      ) : loadError ? (
        <div className={styles.wrap}>
          <p className={cx(styles.outcome, styles.bad)} role="alert"><TriangleAlert size={14} aria-hidden />{loadError}</p>
          <Button size="sm" icon={<RefreshCw size={13} />} loading={loading} onClick={() => void run(async () => { setLoadError(""); await reload(); })}>重新读取</Button>
        </div>
      ) : loading && providers.length === 0 ? (
        <p className={styles.note}>正在读取模型库…</p>
      ) : (
        <div className={styles.wrap}>
          {providers.length === 0 ? (
            <div className={styles.empty}>
              <strong>添加你的第一个模型</strong>
              <p>先添加一个服务商，填写一次地址和密钥，再挂上它提供的模型。</p>
              <Button size="sm" variant="primary" onClick={() => setEditor(null)}>添加你的第一个模型</Button>
            </div>
          ) : (
            <>
              <label className={styles.defaultRow}>
                <span className={styles.label} id={`${fieldId}-default`}>默认模型</span>
                <select
                  className={styles.select}
                  aria-labelledby={`${fieldId}-default`}
                  value={defaultKey ?? ""}
                  disabled={busy || (catalog.length === 0 && !defaultMissing)}
                  onChange={(event) => {
                    const key = event.target.value;
                    if (!key) return;
                    void run(async () => {
                      await library.setDefaultModel(key);
                      await reload(true);
                      window.dispatchEvent(new Event(MODELS_CHANGED_EVENT));
                    });
                  }}
                >
                  {!defaultKey && <option value="">{catalog.length === 0 ? "还没有启用的模型" : "选择默认模型"}</option>}
                  {catalog.length === 0 && defaultMissing && <option value="">还没有启用的模型</option>}
                  {defaultMissing && defaultKey && <option value={defaultKey}>当前默认模型未启用</option>}
                  {groups.map((group) => (
                    <optgroup key={group.id} label={group.name}>
                      {group.models.map((model) => <option key={model.key} value={model.key}>{model.name}</option>)}
                    </optgroup>
                  ))}
                </select>
              </label>
              <p className={styles.note}>新对话使用默认模型。选好后点保存并测试，通过才会离开此页。</p>
              <Button size="sm" variant="primary" disabled={busy || catalog.length === 0} onClick={saveAndTest}>
                保存并测试
              </Button>
              <ProviderList
                providers={providers}
                busy={busy}
                onOpen={(id) => setEditor(id)}
                onAdd={() => setEditor(null)}
                onToggle={(id, enabled) => void run(async () => {
                  await library.updateProvider(id, { enabled });
                  await reload();
                })}
              />
            </>
          )}
          {signal.state === "unavailable" && (
            <p className={cx(styles.outcome, styles.bad)} role="status">
              <TriangleAlert size={14} aria-hidden />
              {signal.detail || "诊断时后端没有拿到有效的模型结果。"}
            </p>
          )}
          {(notice || setupError) && (
            <p className={cx(styles.outcome, notice?.tone === "ok" && !setupError ? styles.ok : styles.bad)} role={notice?.tone === "ok" && !setupError ? "status" : "alert"}>
              {notice?.tone === "ok" && !setupError ? <CircleCheck size={14} aria-hidden /> : <TriangleAlert size={14} aria-hidden />}
              {notice?.tone === "error" ? notice.text : setupError || notice?.text}
            </p>
          )}
        </div>
      )}

      <EditorDialog
        open={editor !== undefined}
        title={editing ? `${editing.name} 接入` : "添加服务商"}
        description={editing ? "地址、认证和密钥保存在这个服务商下，模型是它的子项。" : "先保存服务商，再添加模型。密钥只留在本机后端。"}
        onClose={() => setEditor(undefined)}
      >
        {editor !== undefined && (
          <ProviderEditor
            key={editor ?? "create"}
            provider={editing}
            client={library}
            onClose={() => setEditor(undefined)}
            onChange={async () => { await reload(); }}
            onCreated={(id) => setEditor(id)}
            onDeleted={(text) => {
              setEditor(undefined);
              setNotice({ tone: "ok", text });
            }}
          />
        )}
      </EditorDialog>
    </section>
  );
}

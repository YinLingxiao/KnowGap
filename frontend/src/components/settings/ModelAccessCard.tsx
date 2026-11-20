"use client";

import { useCallback, useEffect, useId, useState, type ReactNode } from "react";
import { CircleCheck, Cpu, Plus, RefreshCw, TriangleAlert } from "lucide-react";
import { useI18n } from "@/components/LanguageProvider";
import type { HealthState } from "@/lib/types";
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
  extraRows?: ReactNode;
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
  source, health, signal, onCheckHealth, onConfigChange, plain = false, client, setupError = "", extraRows,
}: ModelAccessCardProps) {
  const { tx } = useI18n();
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
  const enabledProviders = providers.filter((p) => p.enabled).length;

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
      ? { tone: "ok", text: tx("已保存默认模型，正在验证连接…") }
      : { tone: "error", text: tx("默认模型还不可用。请确认服务商已启用，并且密钥或 ChatGPT 套餐已授权。") });
  });

  const envHint = tx("在 {path} 设置 {flag} 并重启前端后，可在这里管理模型库。", { path: "\u0000", flag: "\u0001" });

  const healthBadge = source === "mock" && !client ? (
    <span className={styles.healthPill}>{tx("模拟数据")}</span>
  ) : (
    <div className={styles.healthPill}>
      <span className={cx(styles.healthDot, styles[`health_${health}`])} aria-hidden />
      <span>{tx(HEALTH_TEXT[health])}</span>
      <code className={styles.healthHost}>{hostOf(API_BASE_URL) || API_BASE_URL}</code>
      <button
        type="button"
        className={styles.healthRetry}
        onClick={onCheckHealth}
        disabled={health === "checking"}
        title={tx("检测后端服务")}
      >
        <RefreshCw size={12} className={cx(health === "checking" && styles.spin)} aria-hidden />
        <span>{tx("检测")}</span>
      </button>
    </div>
  );

  return (
    <div className={cx(styles.stack, !plain && styles.standalone)} aria-busy={loading || undefined}>
      {!plain && (
        <header className={settings.cardHead}>
          <span className={settings.cardIcon} aria-hidden><Cpu size={16} /></span>
          <div className={settings.cardTitleBlock}>
            <h3 id={`${fieldId}-title`} className={settings.cardTitle}>{tx("模型接入")}</h3>
            <p className={settings.cardDesc}>{tx("服务商保存地址和密钥，下面挂多个模型。新对话使用默认模型。")}</p>
          </div>
        </header>
      )}

      {!active ? (
        <section className={styles.sectionCard}>
          <div className={styles.sectionHead}>
            <span className={styles.sectionHeadTitle}>{tx("默认对话模型")}</span>
            {healthBadge}
          </div>
          <div className={styles.sectionPad}>
            <p className={settings.stepNote}>
              {envHint.split(/(\u0000|\u0001)/).map((part, index) => {
                if (part === "\u0000") return <code key={index}>frontend/.env.local</code>;
                if (part === "\u0001") return <code key={index}>NEXT_PUBLIC_DATA_SOURCE=api</code>;
                return part;
              })}
            </p>
          </div>
        </section>
      ) : loadError ? (
        <section className={styles.sectionCard}>
          <div className={styles.sectionHead}>
            <span className={styles.sectionHeadTitle}>{tx("默认对话模型")}</span>
            {healthBadge}
          </div>
          <div className={styles.sectionPad}>
            <p className={cx(styles.outcome, styles.bad)} role="alert"><TriangleAlert size={14} aria-hidden />{tx(loadError)}</p>
            <div>
              <Button size="sm" icon={<RefreshCw size={13} />} loading={loading} onClick={() => void run(async () => { setLoadError(""); await reload(); })}>
                {tx("重新读取")}
              </Button>
            </div>
          </div>
        </section>
      ) : loading && providers.length === 0 ? (
        <section className={styles.sectionCard}>
          <div className={styles.sectionHead}>
            <span className={styles.sectionHeadTitle}>{tx("默认对话模型")}</span>
            {healthBadge}
          </div>
          <div className={styles.sectionPad}>
            <p className={styles.note}>{tx("正在读取模型库…")}</p>
          </div>
        </section>
      ) : (
        <>
          <section className={styles.sectionCard}>
            <div className={styles.sectionHead}>
              <span className={styles.sectionHeadTitle}>{tx("默认对话模型")}</span>
              {healthBadge}
            </div>
            <div className={styles.sectionBody}>
              <div className={styles.settingLine}>
                <div className={styles.settingMeta}>
                  <label className={styles.settingTitle} id={`${fieldId}-default`} htmlFor={`${fieldId}-default-select`}>
                    {tx("默认模型")}
                  </label>
                  <p className={styles.settingDesc}>{tx("新对话及未单独指定的服务默认使用该模型。")}</p>
                </div>
                <div className={styles.defaultControls}>
                  <select
                    id={`${fieldId}-default-select`}
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
                    {!defaultKey && <option value="">{catalog.length === 0 ? tx("还没有启用的模型") : tx("选择默认模型")}</option>}
                    {catalog.length === 0 && defaultMissing && <option value="">{tx("还没有启用的模型")}</option>}
                    {defaultMissing && defaultKey && <option value={defaultKey}>{tx("当前默认模型未启用")}</option>}
                    {groups.map((group) => (
                      <optgroup key={group.id} label={group.name}>
                        {group.models.map((model) => <option key={model.key} value={model.key}>{model.name}</option>)}
                      </optgroup>
                    ))}
                  </select>
                  <Button
                    size="sm"
                    variant="primary"
                    loading={busy}
                    disabled={busy || catalog.length === 0}
                    onClick={saveAndTest}
                  >
                    {tx("保存并测试")}
                  </Button>
                </div>
              </div>
              {extraRows}
              {signal.state === "unavailable" && (
                <div className={styles.outcomeRow}>
                  <p className={cx(styles.outcome, styles.bad)} role="status">
                    <TriangleAlert size={14} aria-hidden />
                    {signal.detail || tx("诊断时后端没有拿到有效的模型结果。")}
                  </p>
                </div>
              )}
              {(notice || setupError) && (
                <div className={styles.outcomeRow}>
                  <p
                    className={cx(styles.outcome, notice?.tone === "ok" && !setupError ? styles.ok : styles.bad)}
                    role={notice?.tone === "ok" && !setupError ? "status" : "alert"}
                  >
                    {notice?.tone === "ok" && !setupError ? <CircleCheck size={14} aria-hidden /> : <TriangleAlert size={14} aria-hidden />}
                    {notice?.tone === "error" ? notice.text : setupError || notice?.text}
                  </p>
                </div>
              )}
            </div>
          </section>

          <section className={styles.sectionCard}>
            <div className={styles.sectionHead}>
              <div className={styles.sectionHeadGroup}>
                <span className={styles.sectionHeadTitle}>{tx("模型服务商")}</span>
                {providers.length > 0 && (
                  <span className={styles.countBadge}>
                    {tx("已启用 {enabled}/{total}", { enabled: enabledProviders, total: providers.length })}
                  </span>
                )}
              </div>
              <Button size="sm" variant="secondary" icon={<Plus size={13} />} disabled={busy} onClick={() => setEditor(null)}>
                {tx("添加服务商")}
              </Button>
            </div>
            <div className={styles.sectionPad}>
              {providers.length === 0 ? (
                <div className={styles.empty}>
                  <strong>{tx("添加你的第一个模型")}</strong>
                  <p>{tx("先添加一个服务商，填写一次地址和密钥，再挂上它提供的模型。")}</p>
                  <Button size="sm" variant="primary" icon={<Plus size={13} />} onClick={() => setEditor(null)}>
                    {tx("添加你的第一个模型")}
                  </Button>
                </div>
              ) : (
                <ProviderList
                  providers={providers}
                  busy={busy}
                  onOpen={(id) => setEditor(id)}
                  onToggle={(id, enabled) => void run(async () => {
                    await library.updateProvider(id, { enabled });
                    await reload();
                  })}
                />
              )}
            </div>
          </section>
        </>
      )}

      <EditorDialog
        open={editor !== undefined}
        title={editing ? tx("{name} 接入", { name: editing.name }) : tx("添加服务商")}
        description={editing ? tx("地址、认证和密钥保存在这个服务商下，模型是它的子项。") : tx("先保存服务商，再添加模型。密钥只留在本机后端。")}
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
    </div>
  );
}

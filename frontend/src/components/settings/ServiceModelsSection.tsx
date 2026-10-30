"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { BrainCircuit, CheckCircle2, Database, Eye, RefreshCw, Save, Sparkles } from "lucide-react";
import { useI18n } from "@/components/LanguageProvider";
import { Button } from "../ui/Button";
import { toApiError } from "@/lib/api/errors";
import { modelLibraryApi, type CatalogModel, type ModelLibraryClient, type ServiceModelSelection, type ServiceRole } from "@/lib/api/model-library";
import { getServiceModels, saveServiceModels, type BboxFormat } from "@/lib/api/vision-client";
import styles from "./ServiceModelsSection.module.css";

export interface VisionPrefs {
  bboxFormat: BboxFormat;
  visionEnabled: boolean;
  dualModelRelay: boolean;
  circuitConfirmFirst: boolean;
  suggestReplyEnabled: boolean;
}

export interface VisionPrefsClient {
  load(): Promise<VisionPrefs>;
  save(next: VisionPrefs): Promise<VisionPrefs>;
}

const BBOX_OPTIONS: ReadonlyArray<{ value: BboxFormat; label: string }> = [
  { value: "xyxy_1000", label: "Qwen / xyxy · 0–1000" },
  { value: "yxyx_1000", label: "yxyx · 0–1000" },
  { value: "xyxy_pixel", label: "xyxy · 像素坐标" },
  { value: "xyxy_unit", label: "xyxy · 0–1" },
];

const ROLES: Array<{ key: ServiceRole; title: string; desc: string; icon: typeof BrainCircuit }> = [
  { key: "logic", title: "主力逻辑模型", desc: "判错、列 KCL/KVL、综合计算", icon: BrainCircuit },
  { key: "vision", title: "多模态视觉模型", desc: "转写、区域定位与电路网表草稿", icon: Eye },
  { key: "memory", title: "后台与记忆", desc: "话题自动命名、会话历史压缩、档案信息生成", icon: Database },
];

const defaultVision: VisionPrefsClient = {
  async load() {
    const data = await getServiceModels();
    return {
      bboxFormat: data.visionModel.bboxFormat,
      visionEnabled: data.visionModel.enabled,
      dualModelRelay: data.dualModelRelay,
      circuitConfirmFirst: data.circuitConfirmFirst,
      suggestReplyEnabled: data.suggestReplyEnabled,
    };
  },
  async save(next) {
    const data = await saveServiceModels({
      visionModel: { enabled: next.visionEnabled, bboxFormat: next.bboxFormat },
      dualModelRelay: next.dualModelRelay,
      circuitConfirmFirst: next.circuitConfirmFirst,
      suggestReplyEnabled: next.suggestReplyEnabled,
    });
    return {
      bboxFormat: data.visionModel.bboxFormat,
      visionEnabled: data.visionModel.enabled,
      dualModelRelay: data.dualModelRelay,
      circuitConfirmFirst: data.circuitConfirmFirst,
      suggestReplyEnabled: data.suggestReplyEnabled,
    };
  },
};

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

function Toggle({
  id, checked, title, description, disabled, onChange,
}: {
  id: string;
  checked: boolean;
  title: string;
  description: string;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className={styles.toggleRow} htmlFor={id}>
      <span>
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
      <span className={styles.switch}>
        <input id={id} type="checkbox" role="switch" checked={checked} disabled={disabled} aria-label={title} onChange={(event) => onChange(event.target.checked)} />
        <span aria-hidden />
      </span>
    </label>
  );
}

function fingerprint(selection: ServiceModelSelection, prefs: VisionPrefs | null) {
  return JSON.stringify({ selection, prefs });
}

export function ServiceModelsSection({ client, visionClient }: { client?: ModelLibraryClient; visionClient?: VisionPrefsClient } = {}) {
  const { tx } = useI18n();
  const id = useId();
  const library = client ?? modelLibraryApi;
  const vision = visionClient ?? defaultVision;
  const [catalog, setCatalog] = useState<CatalogModel[]>([]);
  const [selection, setSelection] = useState<ServiceModelSelection>({ logic: null, vision: null, memory: null });
  const [prefs, setPrefs] = useState<VisionPrefs | null>(null);
  const [visionReady, setVisionReady] = useState(false);
  const [baseline, setBaseline] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [libraryError, setLibraryError] = useState("");
  const [visionError, setVisionError] = useState("");
  const [outcome, setOutcome] = useState("");
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLibraryError("");
    setVisionError("");
    setOutcome("");
    setFailed(false);
    const [modelsResult, serviceResult, visionResult] = await Promise.allSettled([
      library.listSelectableModels(),
      library.getServiceModels(),
      vision.load(),
    ]);
    if (modelsResult.status === "fulfilled" && serviceResult.status === "fulfilled") {
      setCatalog(modelsResult.value);
      setSelection(serviceResult.value);
      const nextPrefs = visionResult.status === "fulfilled" ? visionResult.value : null;
      setPrefs(nextPrefs);
      setVisionReady(visionResult.status === "fulfilled");
      setBaseline(fingerprint(serviceResult.value, nextPrefs));
    } else {
      const reason = modelsResult.status === "rejected" ? modelsResult.reason : serviceResult.status === "rejected" ? serviceResult.reason : null;
      const apiError = toApiError(reason);
      setLibraryError(apiError.kind === "not_found" ? "后端还没有模型库接口。" : apiError.message);
    }
    if (visionResult.status === "rejected") {
      const apiError = toApiError(visionResult.reason);
      setVisionError(apiError.kind === "not_found" ? "后端尚未挂载视觉服务接口，坐标格式暂时读不到。" : apiError.message);
      setVisionReady(false);
    }
    setLoading(false);
  }, [library, vision]);

  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    setSaving(true);
    setOutcome("");
    setFailed(false);
    try {
      const saved = await library.setServiceModels(selection);
      let nextPrefs = prefs;
      if (visionReady && prefs) nextPrefs = await vision.save(prefs);
      setSelection(saved);
      setPrefs(nextPrefs);
      setBaseline(fingerprint(saved, nextPrefs));
      setOutcome("服务模型分工已保存，下一次识图与推理请求立即生效。");
    } catch (error: unknown) {
      setFailed(true);
      setOutcome(toApiError(error).message);
    } finally {
      setSaving(false);
    }
  };

  if (libraryError) {
    return (
      <section className={styles.root} aria-labelledby={`${id}-title`}>
        <div className={styles.sectionHead}>
          <div>
            <h3 id={`${id}-title`}>{tx("服务模型分工")}</h3>
            <p>{tx("逻辑、视觉、后台与记忆从模型库里选择。")}</p>
          </div>
        </div>
        <div className={styles.loadError} role="alert">{tx(libraryError)}</div>
        <Button size="sm" icon={<RefreshCw size={14} />} loading={loading} onClick={() => void load()}>{tx("重新读取")}</Button>
      </section>
    );
  }

  if (loading && !baseline) {
    return (
      <section className={styles.root} aria-busy="true">
        <div className={styles.skeleton}>{tx("正在读取服务模型配置…")}</div>
      </section>
    );
  }

  const disabled = loading || saving;
  const dirty = fingerprint(selection, prefs) !== baseline;
  const groups = groupCatalog(catalog);

  const choose = (role: ServiceRole, value: string) => {
    setSelection((current) => ({ ...current, [role]: value || null }));
    setOutcome("");
  };

  return (
    <section className={styles.root} aria-labelledby={`${id}-title`} aria-busy={disabled || undefined}>
      <div className={styles.sectionHead}>
        <div>
          <h3 id={`${id}-title`}>{tx("服务模型分工")}</h3>
          <p>{tx("从已启用的模型里选择。选「沿用默认模型」时使用模型库的默认模型，这里不再填写地址和密钥。")}</p>
        </div>
        <Button size="sm" variant="primary" icon={<Save size={14} />} loading={saving} disabled={disabled || !dirty} onClick={() => void save()}>
          {tx("保存分工")}
        </Button>
      </div>
      {visionError && <div className={styles.loadError} role="alert">{tx(visionError)}</div>}
      <div className={styles.modelGrid}>
        {ROLES.map((role) => {
          const Icon = role.icon;
          const current = selection[role.key];
          const known = !current || catalog.some((model) => model.key === current);
          return (
            <article key={role.key} className={styles.modelCard}>
              <header className={styles.cardHead}>
                <span className={styles.cardIcon}><Icon size={16} aria-hidden /></span>
                <div>
                  <h5>{tx(role.title)}</h5>
                  <p>{tx(role.desc)}</p>
                </div>
              </header>
              <label className={styles.field} htmlFor={`${id}-${role.key}`}>
                <select
                  id={`${id}-${role.key}`}
                  className={styles.input}
                  aria-label={tx(role.title)}
                  value={current ?? ""}
                  disabled={disabled}
                  onChange={(event) => choose(role.key, event.target.value)}
                >
                  <option value="">{tx("沿用默认模型")}</option>
                  {!known && current && <option value={current}>{tx("当前模型已停用")}</option>}
                  {groups.map((group) => (
                    <optgroup key={group.id} label={group.name}>
                      {group.models.map((model) => <option key={model.key} value={model.key}>{model.name}</option>)}
                    </optgroup>
                  ))}
                </select>
              </label>
              {role.key === "vision" && prefs && (
                <>
                  <label className={styles.field} htmlFor={`${id}-bbox`}>
                    <span className={styles.fieldLabel}>{tx("服务商坐标格式")}</span>
                    <select
                      id={`${id}-bbox`}
                      className={styles.input}
                      aria-label={tx("服务商坐标格式")}
                      value={prefs.bboxFormat}
                      disabled={disabled || !prefs.visionEnabled}
                      onChange={(event) => setPrefs({ ...prefs, bboxFormat: event.target.value as BboxFormat })}
                    >
                      {BBOX_OPTIONS.map((option) => <option key={option.value} value={option.value}>{tx(option.label)}</option>)}
                    </select>
                  </label>
                  <p className={styles.help}>{tx("当前 Qwen 接力建议使用 xyxy · 0–1000；内部会统一换算为圈画坐标。")}</p>
                  <Toggle
                    id={`${id}-vision-enabled`}
                    checked={prefs.visionEnabled}
                    disabled={disabled}
                    title={tx("启用视觉模型")}
                    description={tx("关闭后识图不再单独调用所选视觉模型")}
                    onChange={(visionEnabled) => setPrefs({ ...prefs, visionEnabled })}
                  />
                </>
              )}
            </article>
          );
        })}
      </div>
      {prefs && (
        <div className={styles.group}>
          <div className={styles.groupTitle}>
            <Sparkles size={16} aria-hidden />
            <div><h4>{tx("可选功能")}</h4><p>{tx("控制接力方式与需要人工确认的教学节点。")}</p></div>
          </div>
          <div className={styles.options}>
            <Toggle id={`${id}-dual`} checked={prefs.dualModelRelay} disabled={disabled} title={tx("双模型接力")} description={tx("视觉模型给区域 ID，逻辑模型只按 ID 判错")} onChange={(dualModelRelay) => setPrefs({ ...prefs, dualModelRelay })} />
            <Toggle id={`${id}-confirm`} checked={prefs.circuitConfirmFirst} disabled={disabled} title={tx("电路网表先确认")} description={tx("学生核对节点和支路后，逻辑模型才列方程")} onChange={(circuitConfirmFirst) => setPrefs({ ...prefs, circuitConfirmFirst })} />
            <Toggle id={`${id}-suggest`} checked={prefs.suggestReplyEnabled} disabled={disabled} title={tx("建议回复")} description={tx("保留给公共聊天服务的建议回复开关")} onChange={(suggestReplyEnabled) => setPrefs({ ...prefs, suggestReplyEnabled })} />
          </div>
        </div>
      )}
      {outcome && (
        <p className={failed ? styles.outcomeError : styles.outcomeOk} role="status">
          {!failed && <CheckCircle2 size={14} aria-hidden />}
          {tx(outcome)}
        </p>
      )}
    </section>
  );
}

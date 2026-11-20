"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { BrainCircuit, CheckCircle2, ChevronRight, Database, Eye, RefreshCw, Sparkles } from "lucide-react";
import { useI18n } from "@/components/LanguageProvider";
import { Button } from "../ui/Button";
import { EditorDialog } from "./EditorDialog";
import { toApiError } from "@/lib/api/errors";
import {
  MODELS_CHANGED_EVENT, modelLibraryApi,
  type CatalogModel, type ModelLibraryClient, type ServiceModelSelection, type ServiceRole,
} from "@/lib/api/model-library";
import { getServiceModels, saveServiceModels, type BboxFormat } from "@/lib/api/vision-client";
import { cx } from "@/lib/cx";
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

type EditorKey = ServiceRole | "options";

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

export function ServiceModelsSection({ client, visionClient }: { client?: ModelLibraryClient; visionClient?: VisionPrefsClient } = {}) {
  const { tx } = useI18n();
  const id = useId();
  const library = client ?? modelLibraryApi;
  const vision = visionClient ?? defaultVision;
  const [catalog, setCatalog] = useState<CatalogModel[]>([]);
  const [selection, setSelection] = useState<ServiceModelSelection>({ logic: null, vision: null, memory: null });
  const [prefs, setPrefs] = useState<VisionPrefs | null>(null);
  const [visionReady, setVisionReady] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [libraryError, setLibraryError] = useState("");
  const [visionError, setVisionError] = useState("");
  const [outcome, setOutcome] = useState("");
  const [failed, setFailed] = useState(false);

  const [editing, setEditing] = useState<EditorKey | null>(null);
  const [draftSelection, setDraftSelection] = useState<ServiceModelSelection>({ logic: null, vision: null, memory: null });
  const [draftPrefs, setDraftPrefs] = useState<VisionPrefs | null>(null);
  const [dialogError, setDialogError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setLibraryError("");
    setVisionError("");
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
      setLoaded(true);
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

  // 模型库变更后刷新可选模型列表
  useEffect(() => {
    const refresh = () => void load();
    window.addEventListener(MODELS_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(MODELS_CHANGED_EVENT, refresh);
  }, [load]);

  const openEditor = (key: EditorKey) => {
    setDraftSelection(selection);
    setDraftPrefs(prefs ? { ...prefs } : null);
    setDialogError("");
    setEditing(key);
  };

  const closeEditor = () => {
    if (saving) return;
    setEditing(null);
    setDialogError("");
  };

  const saveDialog = async () => {
    setSaving(true);
    setDialogError("");
    setOutcome("");
    setFailed(false);
    try {
      const saved = await library.setServiceModels(draftSelection);
      let nextPrefs = prefs;
      if (visionReady && draftPrefs && (editing === "vision" || editing === "options")) {
        nextPrefs = await vision.save(draftPrefs);
      }
      setSelection(saved);
      setPrefs(nextPrefs);
      setEditing(null);
      setOutcome("已保存，下一次请求立即生效。");
    } catch (error: unknown) {
      setDialogError(toApiError(error).message);
    } finally {
      setSaving(false);
    }
  };

  const labelForModel = (key: string | null) => {
    if (!key) return tx("沿用默认模型");
    const found = catalog.find((item) => item.key === key);
    return found ? found.name : tx("当前模型已停用");
  };

  if (libraryError) {
    return (
      <section className={styles.card} aria-labelledby={`${id}-title`}>
        <div className={styles.head}>
          <div>
            <h3 id={`${id}-title`}>{tx("服务模型分工")}</h3>
            <p>{tx("逻辑、视觉、后台与记忆从模型库里选择。")}</p>
          </div>
        </div>
        <div className={styles.pad}>
          <div className={styles.loadError} role="alert">{tx(libraryError)}</div>
          <div>
            <Button size="sm" icon={<RefreshCw size={14} />} loading={loading} onClick={() => void load()}>{tx("重新读取")}</Button>
          </div>
        </div>
      </section>
    );
  }

  if (loading && !loaded) {
    return (
      <section className={styles.card} aria-busy="true">
        <div className={styles.head}>
          <h3>{tx("服务模型分工")}</h3>
        </div>
        <div className={styles.pad}>
          <div className={styles.skeleton}>{tx("正在读取服务模型配置…")}</div>
        </div>
      </section>
    );
  }

  const groups = groupCatalog(catalog);
  const activeRole = editing && editing !== "options" ? ROLES.find((r) => r.key === editing) ?? null : null;
  const enabledOptionCount = prefs
    ? [prefs.dualModelRelay, prefs.circuitConfirmFirst, prefs.suggestReplyEnabled].filter(Boolean).length
    : 0;

  return (
    <section className={styles.card} aria-labelledby={`${id}-title`} aria-busy={saving || undefined}>
      <div className={styles.head}>
        <div>
          <h3 id={`${id}-title`}>{tx("服务模型分工")}</h3>
          <p>{tx("点击任意一项弹出配置；未单独指定时自动沿用默认模型。")}</p>
        </div>
        {outcome && (
          <span className={failed ? styles.badgeError : styles.badgeOk} role="status">
            {!failed && <CheckCircle2 size={12} aria-hidden />}
            {tx(outcome)}
          </span>
        )}
      </div>

      {visionError && <div className={styles.pad}><div className={styles.loadError} role="alert">{tx(visionError)}</div></div>}

      <div className={styles.list} role="list">
        {ROLES.map((role) => {
          const Icon = role.icon;
          const current = selection[role.key];
          const isVisionOff = role.key === "vision" && prefs && !prefs.visionEnabled;
          const isCustom = Boolean(current) && !isVisionOff;
          const summary = isVisionOff ? tx("已关闭") : labelForModel(current);
          return (
            <button
              key={role.key}
              type="button"
              role="listitem"
              className={styles.row}
              onClick={() => openEditor(role.key)}
            >
              <span className={cx(styles.rowIcon, isCustom && styles.rowIconActive)} aria-hidden>
                <Icon size={15} />
              </span>
              <span className={styles.rowText}>
                <strong>{tx(role.title)}</strong>
                <small>{tx(role.desc)}</small>
              </span>
              <span className={styles.rowRight}>
                <span className={cx(styles.valuePill, isCustom && styles.valuePillActive, isVisionOff && styles.valuePillMuted)}>
                  {summary}
                </span>
                <ChevronRight size={14} className={styles.chevron} aria-hidden />
              </span>
            </button>
          );
        })}

        {prefs && (
          <button
            type="button"
            role="listitem"
            className={styles.row}
            onClick={() => openEditor("options")}
          >
            <span className={styles.rowIcon} aria-hidden>
              <Sparkles size={15} />
            </span>
            <span className={styles.rowText}>
              <strong>{tx("可选功能")}</strong>
              <small>{tx("控制接力方式与需要人工确认的教学节点。")}</small>
            </span>
            <span className={styles.rowRight}>
              <span className={styles.valuePill}>
                {tx("已开启 {count}/3", { count: enabledOptionCount })}
              </span>
              <ChevronRight size={14} className={styles.chevron} aria-hidden />
            </span>
          </button>
        )}
      </div>

      <EditorDialog
        open={editing !== null}
        title={activeRole ? tx(activeRole.title) : tx("可选功能")}
        description={activeRole ? tx(activeRole.desc) : tx("控制接力方式与需要人工确认的教学节点。")}
        onClose={closeEditor}
      >
        {activeRole && (
          <div className={styles.dialogBody}>
            {activeRole.key === "vision" && draftPrefs && (
              <Toggle
                id={`${id}-vision-enabled`}
                checked={draftPrefs.visionEnabled}
                disabled={saving}
                title={tx("启用视觉模型")}
                description={tx("关闭后识图不再单独调用所选视觉模型")}
                onChange={(visionEnabled) => setDraftPrefs({ ...draftPrefs, visionEnabled })}
              />
            )}

            <label className={styles.field} htmlFor={`${id}-dialog-model`}>
              <span className={styles.fieldLabel}>{tx("指定模型")}</span>
              <select
                id={`${id}-dialog-model`}
                className={styles.input}
                aria-label={tx(activeRole.title)}
                value={draftSelection[activeRole.key] ?? ""}
                disabled={saving || (activeRole.key === "vision" && Boolean(draftPrefs && !draftPrefs.visionEnabled))}
                onChange={(event) => {
                  const value = event.target.value || null;
                  setDraftSelection((cur) => ({ ...cur, [activeRole.key]: value }));
                }}
              >
                <option value="">{tx("沿用默认模型")}</option>
                {draftSelection[activeRole.key] && !catalog.some((m) => m.key === draftSelection[activeRole.key]) && (
                  <option value={draftSelection[activeRole.key] ?? ""}>{tx("当前模型已停用")}</option>
                )}
                {groups.map((group) => (
                  <optgroup key={group.id} label={group.name}>
                    {group.models.map((model) => <option key={model.key} value={model.key}>{model.name}</option>)}
                  </optgroup>
                ))}
              </select>
            </label>

            {activeRole.key === "vision" && draftPrefs && (
              <>
                <label className={styles.field} htmlFor={`${id}-bbox`}>
                  <span className={styles.fieldLabel}>{tx("服务商坐标格式")}</span>
                  <select
                    id={`${id}-bbox`}
                    className={styles.input}
                    aria-label={tx("服务商坐标格式")}
                    value={draftPrefs.bboxFormat}
                    disabled={saving || !draftPrefs.visionEnabled}
                    onChange={(event) => setDraftPrefs({ ...draftPrefs, bboxFormat: event.target.value as BboxFormat })}
                  >
                    {BBOX_OPTIONS.map((option) => <option key={option.value} value={option.value}>{tx(option.label)}</option>)}
                  </select>
                </label>
                <p className={styles.help}>{tx("当前 Qwen 接力建议使用 xyxy · 0–1000；内部会统一换算为圈画坐标。")}</p>
              </>
            )}
          </div>
        )}

        {editing === "options" && draftPrefs && (
          <div className={styles.dialogOptions}>
            <Toggle
              id={`${id}-dual`}
              checked={draftPrefs.dualModelRelay}
              disabled={saving}
              title={tx("双模型接力")}
              description={tx("视觉模型给区域 ID，逻辑模型只按 ID 判错")}
              onChange={(dualModelRelay) => setDraftPrefs({ ...draftPrefs, dualModelRelay })}
            />
            <Toggle
              id={`${id}-confirm`}
              checked={draftPrefs.circuitConfirmFirst}
              disabled={saving}
              title={tx("电路网表先确认")}
              description={tx("学生核对节点和支路后，逻辑模型才列方程")}
              onChange={(circuitConfirmFirst) => setDraftPrefs({ ...draftPrefs, circuitConfirmFirst })}
            />
            <Toggle
              id={`${id}-suggest`}
              checked={draftPrefs.suggestReplyEnabled}
              disabled={saving}
              title={tx("建议回复")}
              description={tx("保留给公共聊天服务的建议回复开关")}
              onChange={(suggestReplyEnabled) => setDraftPrefs({ ...draftPrefs, suggestReplyEnabled })}
            />
          </div>
        )}

        {dialogError && <p className={styles.outcomeError} role="alert">{tx(dialogError)}</p>}

        <div className={styles.dialogActions}>
          <Button size="sm" variant="secondary" disabled={saving} onClick={closeEditor}>{tx("取消")}</Button>
          <Button size="sm" variant="primary" loading={saving} disabled={saving} onClick={() => void saveDialog()}>
            {tx("保存")}
          </Button>
        </div>
      </EditorDialog>
    </section>
  );
}

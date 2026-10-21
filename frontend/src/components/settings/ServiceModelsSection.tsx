"use client";

import { useCallback, useEffect, useId, useState } from "react";
import {
  BrainCircuit, CheckCircle2, Database, Eye, EyeOff, RefreshCw, Save, Sparkles,
} from "lucide-react";
import { Button } from "../ui/Button";
import { toApiError } from "@/lib/api/errors";
import {
  getServiceModels,
  saveServiceModels,
  type BboxFormat,
  type ModelSource,
  type ServiceModels,
} from "@/lib/api/vision-client";
import styles from "./ServiceModelsSection.module.css";

type Outcome = { tone: "ok" | "error"; text: string } | null;

type EndpointForm = {
  baseUrl: string;
  model: string;
  apiKey: string;
};

type Form = {
  logic: EndpointForm;
  vision: EndpointForm & { enabled: boolean; bboxFormat: BboxFormat };
  memory: { model: string; enabled: boolean };
  suggestReplyEnabled: boolean;
  dualModelRelay: boolean;
  circuitConfirmFirst: boolean;
};

const SOURCE_LABEL: Record<ModelSource, string> = {
  global: "全局主模型",
  service_models: "服务模型设置",
  env: "后端环境变量",
  logic: "逻辑模型",
  none: "未配置",
};

const BBOX_OPTIONS: ReadonlyArray<{ value: BboxFormat; label: string }> = [
  { value: "xyxy_1000", label: "Qwen / xyxy · 0–1000" },
  { value: "yxyx_1000", label: "yxyx · 0–1000" },
  { value: "xyxy_pixel", label: "xyxy · 像素坐标" },
  { value: "xyxy_unit", label: "xyxy · 0–1" },
];

function formFrom(config: ServiceModels): Form {
  return {
    logic: { baseUrl: config.logicModel.baseUrl, model: config.logicModel.model, apiKey: "" },
    vision: {
      baseUrl: config.visionModel.baseUrl,
      model: config.visionModel.model,
      apiKey: "",
      enabled: config.visionModel.enabled,
      bboxFormat: config.visionModel.bboxFormat,
    },
    memory: { model: config.memoryModel.model, enabled: config.memoryModel.enabled },
    suggestReplyEnabled: config.suggestReplyEnabled,
    dualModelRelay: config.dualModelRelay,
    circuitConfirmFirst: config.circuitConfirmFirst,
  };
}

function sourceText(source: ModelSource): string {
  return SOURCE_LABEL[source] ?? "未知来源";
}

function EndpointFields({
  id,
  value,
  configuredKey,
  disabled,
  onChange,
}: {
  id: string;
  value: EndpointForm;
  configuredKey: boolean;
  disabled: boolean;
  onChange: (patch: Partial<EndpointForm>) => void;
}) {
  const [showKey, setShowKey] = useState(false);
  return (
    <div className={styles.endpointFields}>
      <label className={styles.field} htmlFor={`${id}-url`}>
        <span className={styles.fieldLabel}>接口地址</span>
        <input
          id={`${id}-url`}
          className={styles.input}
          value={value.baseUrl}
          onChange={(event) => onChange({ baseUrl: event.target.value })}
          placeholder="留空则复用全局 / 逻辑模型地址"
          spellCheck={false}
          autoComplete="off"
          disabled={disabled}
        />
      </label>
      <label className={styles.field} htmlFor={`${id}-model`}>
        <span className={styles.fieldLabel}>模型名称</span>
        <input
          id={`${id}-model`}
          className={styles.input}
          value={value.model}
          onChange={(event) => onChange({ model: event.target.value })}
          placeholder="例如 gemini-4-argon"
          spellCheck={false}
          autoComplete="off"
          disabled={disabled}
        />
      </label>
      <label className={`${styles.field} ${styles.fieldFull}`} htmlFor={`${id}-key`}>
        <span className={styles.fieldLabel}>API Key</span>
        <span className={styles.keyField}>
          <input
            id={`${id}-key`}
            className={styles.input}
            type={showKey ? "text" : "password"}
            value={value.apiKey}
            onChange={(event) => onChange({ apiKey: event.target.value })}
            placeholder={configuredKey ? "已安全保存在后端；留空保持不变" : "使用独立地址时填写；不会返回前端"}
            spellCheck={false}
            autoComplete="new-password"
            data-1p-ignore
            disabled={disabled}
          />
          <button
            type="button"
            className={styles.reveal}
            aria-label={showKey ? "隐藏 API Key" : "显示 API Key"}
            aria-pressed={showKey}
            disabled={disabled || !value.apiKey}
            onClick={() => setShowKey((shown) => !shown)}
          >
            {showKey ? <EyeOff size={15} aria-hidden /> : <Eye size={15} aria-hidden />}
          </button>
        </span>
      </label>
    </div>
  );
}

function Toggle({
  id,
  checked,
  title,
  description,
  disabled,
  onChange,
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
        <input id={id} type="checkbox" checked={checked} disabled={disabled}
          onChange={(event) => onChange(event.target.checked)} />
        <span aria-hidden />
      </span>
    </label>
  );
}

/** Standalone service-model panel. The settings dialog can mount it without passing secrets or chat state. */
export function ServiceModelsSection() {
  const id = useId();
  const [config, setConfig] = useState<ServiceModels | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [outcome, setOutcome] = useState<Outcome>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    setOutcome(null);
    try {
      const data = await getServiceModels();
      setConfig(data);
      setForm(formFrom(data));
    } catch (error: unknown) {
      const apiError = toApiError(error);
      setLoadError(apiError.kind === "not_found"
        ? "后端尚未挂载视觉服务接口，请先由集成人员挂载 /api/vision 路由。"
        : apiError.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const patchLogic = (patch: Partial<EndpointForm>) => {
    setForm((current) => current ? { ...current, logic: { ...current.logic, ...patch } } : current);
    setOutcome(null);
  };
  const patchVision = (patch: Partial<Form["vision"]>) => {
    setForm((current) => current ? { ...current, vision: { ...current.vision, ...patch } } : current);
    setOutcome(null);
  };

  const save = async () => {
    if (!form) return;
    setSaving(true);
    setOutcome(null);
    try {
      const data = await saveServiceModels({
        logicModel: form.logic,
        visionModel: form.vision,
        memoryModel: form.memory,
        suggestReplyEnabled: form.suggestReplyEnabled,
        dualModelRelay: form.dualModelRelay,
        circuitConfirmFirst: form.circuitConfirmFirst,
      });
      setConfig(data);
      setForm(formFrom(data));
      setOutcome({ tone: "ok", text: "服务模型分工已保存，下一次识图与推理请求立即生效。" });
    } catch (error: unknown) {
      setOutcome({ tone: "error", text: toApiError(error).message });
    } finally {
      setSaving(false);
    }
  };

  if (loadError) {
    return (
      <section className={styles.root} aria-labelledby={`${id}-title`}>
        <div className={styles.sectionHead}>
          <div>
            <h3 id={`${id}-title`}>服务模型分工</h3>
            <p>为识图、逻辑推理和后台能力分别选择模型。</p>
          </div>
        </div>
        <div className={styles.loadError} role="alert">{loadError}</div>
        <Button size="sm" icon={<RefreshCw size={14} />} loading={loading} onClick={() => void load()}>
          重新读取
        </Button>
      </section>
    );
  }

  if (!form || !config) {
    return (
      <section className={styles.root} aria-busy="true">
        <div className={styles.skeleton}>正在读取服务模型配置…</div>
      </section>
    );
  }

  const disabled = loading || saving;
  const update = (patch: Partial<Form>) => {
    setForm((current) => current ? { ...current, ...patch } : current);
    setOutcome(null);
  };

  return (
    <section className={styles.root} aria-labelledby={`${id}-title`} aria-busy={disabled || undefined}>
      <div className={styles.sectionHead}>
        <div>
          <h3 id={`${id}-title`}>服务模型分工</h3>
          <p>视觉模型只读取图片并定位；逻辑模型只依据结构化文本推理，API Key 始终留在后端。</p>
        </div>
        <Button size="sm" variant="primary" icon={<Save size={14} />} loading={saving} disabled={loading}
          onClick={() => void save()}>
          保存分工
        </Button>
      </div>

      <div className={styles.group}>
        <div className={styles.groupTitle}>
          <BrainCircuit size={16} aria-hidden />
          <div><h4>核心教学与双模型协同</h4><p>“眼睛”负责客观提取，“大脑”负责判错与严密推理。</p></div>
        </div>
        <div className={styles.modelGrid}>
          <article className={styles.modelCard}>
            <header className={styles.cardHead}>
              <span className={styles.cardIcon}><BrainCircuit size={16} aria-hidden /></span>
              <div><h5>主力逻辑模型</h5><p>判错、列 KCL/KVL、综合计算</p></div>
              <span className={config.logicModel.effective.configured ? styles.ready : styles.missing}>
                {config.logicModel.effective.configured ? "可用" : "未配置"}
              </span>
            </header>
            <EndpointFields id={`${id}-logic`} value={form.logic}
              configuredKey={config.logicModel.apiKeyConfigured} disabled={disabled} onChange={patchLogic} />
            <p className={styles.effective}>当前：<strong>{config.logicModel.effective.model || "未配置"}</strong>
              <span>来自 {sourceText(config.logicModel.effective.source)}</span></p>
            <p className={styles.help}>只填写模型名可复用全局接口地址和 Key；填写独立地址时也需提供 Key。</p>
          </article>

          <article className={styles.modelCard}>
            <header className={styles.cardHead}>
              <span className={styles.cardIcon}><Eye size={16} aria-hidden /></span>
              <div><h5>多模态视觉模型</h5><p>转写、区域定位与电路网表草稿</p></div>
              <span className={config.visionModel.effective.configured ? styles.ready : styles.missing}>
                {config.visionModel.effective.configured ? "可用" : "未配置"}
              </span>
            </header>
            <Toggle id={`${id}-vision-enabled`} checked={form.vision.enabled} disabled={disabled}
              title="启用独立视觉模型" description="关闭时回退到后端环境变量或逻辑模型"
              onChange={(enabled) => patchVision({ enabled })} />
            <EndpointFields id={`${id}-vision`} value={form.vision}
              configuredKey={config.visionModel.apiKeyConfigured} disabled={disabled || !form.vision.enabled} onChange={patchVision} />
            <label className={styles.field} htmlFor={`${id}-bbox`}>
              <span className={styles.fieldLabel}>服务商坐标格式</span>
              <select id={`${id}-bbox`} className={styles.input} value={form.vision.bboxFormat}
                disabled={disabled || !form.vision.enabled}
                onChange={(event) => patchVision({ bboxFormat: event.target.value as BboxFormat })}>
                {BBOX_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
            <p className={styles.effective}>当前：<strong>{config.visionModel.effective.model || "未配置"}</strong>
              <span>来自 {sourceText(config.visionModel.effective.source)}</span></p>
            <p className={styles.help}>当前 Qwen 接力建议使用 xyxy · 0–1000；内部会统一换算为圈画坐标。</p>
          </article>
        </div>
      </div>

      <div className={styles.group}>
        <div className={styles.groupTitle}>
          <Database size={16} aria-hidden />
          <div>
            <h4>通用后台与记忆服务（话题自动命名 / 会话历史压缩 / 档案信息生成）</h4>
            <p>统一驱动首轮话题自动命名、长对话自动上下文压缩、五层白盒学习者档案生成与记忆分析；关闭独立模型时自动复用主力逻辑模型。</p>
          </div>
        </div>
        <article className={styles.compactCard}>
          <Toggle id={`${id}-memory-enabled`} checked={form.memory.enabled} disabled={disabled}
            title="使用独立后台与记忆模型" description="用于话题自动命名、会话历史压缩、档案信息生成与五层白盒记忆提取"
            onChange={(enabled) => update({ memory: { ...form.memory, enabled } })} />
          <label className={styles.field} htmlFor={`${id}-memory-model`}>
            <span className={styles.fieldLabel}>后台与记忆模型名称</span>
            <input id={`${id}-memory-model`} className={styles.input} value={form.memory.model}
              placeholder="例如 deepseek-flash（留空则复用主力逻辑模型）" disabled={disabled || !form.memory.enabled}
              onChange={(event) => update({ memory: { ...form.memory, model: event.target.value } })}
              spellCheck={false} autoComplete="off" />
          </label>
          <p className={styles.effective}>
            当前生效模型：<strong>{config.memoryModel.effective.model || "未配置"}</strong>
            <span>来自 {sourceText(config.memoryModel.effective.source)} · 已启用：话题自动命名 · 会话历史自动压缩 · 档案信息生成</span>
          </p>
        </article>
      </div>

      <div className={styles.group}>
        <div className={styles.groupTitle}>
          <Sparkles size={16} aria-hidden />
          <div><h4>可选功能</h4><p>控制接力方式与需要人工确认的教学节点。</p></div>
        </div>
        <div className={styles.options}>
          <Toggle id={`${id}-dual`} checked={form.dualModelRelay} disabled={disabled}
            title="双模型接力" description="视觉模型给区域 ID，逻辑模型只按 ID 判错，不能编造坐标"
            onChange={(dualModelRelay) => update({ dualModelRelay })} />
          <Toggle id={`${id}-confirm`} checked={form.circuitConfirmFirst} disabled={disabled}
            title="电路网表先确认" description="学生核对节点和支路后，逻辑模型才列 KCL/KVL"
            onChange={(circuitConfirmFirst) => update({ circuitConfirmFirst })} />
          <Toggle id={`${id}-suggest`} checked={form.suggestReplyEnabled} disabled={disabled}
            title="建议回复" description="保留给公共聊天服务的建议回复开关"
            onChange={(suggestReplyEnabled) => update({ suggestReplyEnabled })} />
        </div>
      </div>

      {outcome && (
        <p className={outcome.tone === "ok" ? styles.outcomeOk : styles.outcomeError} role="status">
          {outcome.tone === "ok" && <CheckCircle2 size={14} aria-hidden />}
          {outcome.text}
        </p>
      )}
    </section>
  );
}

"use client";

import { useEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import { BarChart3, Brain, CheckCircle2, RefreshCw, Settings2, Trash2, X } from "lucide-react";
import { useI18n } from "@/components/LanguageProvider";
import { chatApi } from "@/lib/chat/api";
import { toApiError } from "@/lib/api/errors";
import { MODELS_CHANGED_EVENT, modelLibraryApi, type CatalogModel, type ModelLibraryClient } from "@/lib/api/model-library";
import type {
  ConversationSummary, LearnerMemory, MemoryKind, SpaceInput, SpaceMemoryNotes, SpaceMemoryNoteWrite, SpaceMemorySync,
  SpaceThreadNote, SpaceUsage, Subject, TokenUsage,
} from "@/lib/chat/types";
import { cx } from "@/lib/cx";
import { KIND_KEY, MemoryItem } from "./MemoryDrawer";
import { choiceFor, groupCatalog, reasoningLabel, usesDefaultModel } from "./ModelPicker";
import { SpaceAppearancePicker } from "./SpaceAppearancePicker";
import { DEFAULT_SPACE_ICON } from "./SpaceIcon";
import styles from "./SpaceSettingsDialog.module.css";

export type SpaceSettingsTab = "general" | "memory" | "usage";

type MemoryItemProps = ComponentProps<typeof MemoryItem>;
type Tx = (text: string, vars?: Record<string, string | number>) => string;

interface SpaceSettingsDialogProps {
  subject: Subject;
  initialTab?: SpaceSettingsTab;
  /** 全部学习记忆；这里只显示属于本空间的。 */
  memories: LearnerMemory[];
  subjects: Subject[];
  conversationTitles: Record<string, string>;
  onClose: () => void;
  onUpdate: (id: string, input: SpaceInput) => Promise<boolean>;
  /** 主线对话当前的模型；null 表示用全局默认。 */
  mainModelKey: string | null;
  /** 改主线对话的模型（和对话框里的模型选择是同一个设置）。 */
  onMainModelChange: (modelKey: string | null) => Promise<boolean>;
  /** 测试时替换模型目录的读取。 */
  modelClient?: Pick<ModelLibraryClient, "listSelectableModels">;
  onDelete: () => Promise<boolean>;
  onUpdateMemory: MemoryItemProps["onUpdate"];
  onDeleteMemory: MemoryItemProps["onDelete"];
  /** 打开这个空间里的一段对话（主线或支线），留在空间页里。 */
  onOpenConversation: (id: string) => void;
  /** 针对一个待巩固的卡点开一条巩固支线；没有主线时不提供。 */
  onPractice?: (memory: LearnerMemory) => void;
}

const MEMORY_GROUPS: MemoryKind[] = ["misconception", "mastery", "preference"];
const TABLE_ROWS = 5;
const HISTORY_ROWS = 8;
const NOTE_TAG = /^\[(结论|进度|疑问|约定)\]\s*/;
const NOTE_TAG_EN: Record<string, string> = { 结论: "Conclusion", 进度: "Progress", 疑问: "Open question", 约定: "Convention" };
const REASONING_EN: Record<string, string> = { 低: "Low", 中: "Medium", 高: "High" };

export function compactTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(value);
}

const tokenTotal = (usage: TokenUsage) => usage.inputTokens + usage.outputTokens;

/** 相对时间：不到 1 小时说「刚刚 / 马上」，不到 24 小时按小时，再往后按整天（向下取整）。 */
export function relativeTime(iso: string | null, tx: Tx, now = Date.now()): string {
  const time = iso ? Date.parse(iso) : Number.NaN;
  if (Number.isNaN(time)) return "";
  const diff = time - now;
  const hours = Math.floor(Math.abs(diff) / 3_600_000);
  const days = Math.floor(hours / 24);
  if (diff >= 0) {
    if (hours < 1) return tx("马上");
    if (days < 1) return tx("{hours} 小时后", { hours });
    return days === 1 ? tx("1 天后") : tx("{days} 天后", { days });
  }
  if (hours < 1) return tx("刚刚");
  if (days < 1) return tx("{hours} 小时前", { hours });
  return days === 1 ? tx("1 天前") : tx("{days} 天前", { days });
}

/** 组件卸载后不再 setState（切分区、关弹窗时请求还在路上）。 */
function useAlive() {
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  return alive;
}

function useLatest<T>(value: T) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

/**
 * 学习空间设置：通用（名称、目标、模型、删除）、记忆（教学说明、Memory.md、支线记录、误区与掌握、汇总进总记忆）、
 * 用量（学习足迹与 Token）。改动即时保存；关弹窗或切分区时，还没失焦的输入也会保存。
 */
export function SpaceSettingsDialog(props: SpaceSettingsDialogProps) {
  const { onClose } = props;
  const { t, tx } = useI18n();
  const [tab, setTab] = useState<SpaceSettingsTab>(props.initialTab ?? "general");
  const dialogRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // 输入法候选框里的 Esc 只是取消候选，不关弹窗；关弹窗时别让外层（记忆抽屉等）也收到这次 Esc
      if (event.key !== "Escape" || event.isComposing) return;
      event.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // 打开时把焦点移进弹窗，关闭时还给打开它的按钮
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => { if (opener && document.contains(opener)) opener.focus(); };
  }, []);

  useEffect(() => {
    if (paneRef.current) paneRef.current.scrollTop = 0;
  }, [tab]);

  const tabs: Array<{ key: SpaceSettingsTab; label: string; icon: typeof Settings2 }> = [
    { key: "general", label: tx("通用"), icon: Settings2 },
    { key: "memory", label: tx("记忆"), icon: Brain },
    { key: "usage", label: tx("用量"), icon: BarChart3 },
  ];
  const active = tabs.find((item) => item.key === tab) ?? tabs[0];

  return (
    <div className={styles.backdrop} onMouseDown={onClose}>
      <div
        ref={dialogRef}
        tabIndex={-1}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="space-settings-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className={styles.top}>
          <h2 id="space-settings-title">{t("space.settings")}</h2>
          <button type="button" className={styles.close} onClick={onClose} aria-label={t("common.close")}>
            <X size={16} />
          </button>
        </header>
        <div className={styles.body}>
          <nav className={styles.nav} aria-label={t("space.settings")}>
            {tabs.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.key}
                  type="button"
                  className={cx(styles.navItem, tab === item.key && styles.navItemActive)}
                  aria-current={tab === item.key ? "page" : undefined}
                  onClick={() => setTab(item.key)}
                >
                  <Icon size={15} aria-hidden />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </nav>
          <section ref={paneRef} className={styles.pane} aria-label={active.label}>
            <h3 className={styles.paneTitle}>{active.label}</h3>
            {tab === "general" && <GeneralPane {...props} />}
            {tab === "memory" && <MemoryPane {...props} />}
            {tab === "usage" && <UsagePane {...props} />}
          </section>
        </div>
      </div>
    </div>
  );
}

function useSavedFlash() {
  const [saved, setSaved] = useState(false);
  const timer = useRef(0);
  const alive = useAlive();
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const flash = () => {
    if (!alive.current) return;
    setSaved(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { if (alive.current) setSaved(false); }, 1600);
  };
  return [saved, flash] as const;
}

function GeneralPane(props: SpaceSettingsDialogProps) {
  const { subject, onUpdate, onDelete } = props;
  const { t, tx } = useI18n();
  const [name, setName] = useState(subject.name);
  const [goal, setGoal] = useState(subject.goal);
  const [appearance, setAppearance] = useState({ icon: subject.icon || DEFAULT_SPACE_ICON, color: subject.color });
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [saved, flash] = useSavedFlash();
  const alive = useAlive();
  const latest = useLatest({ name, goal, subject, onUpdate });
  // 已经发出去（或已确认）的名称和目标：失焦刚发过的，卸载时不再重复发
  const sent = useRef({ name: subject.name, goal: subject.goal });
  // 正在删除这个空间：卸载时不要再给它补发保存
  const deletingRef = useRef(false);
  // 外观连点时只认最后一次；失败时回到最近一次确认成功的外观
  const appearanceTicket = useRef(0);
  const confirmedAppearance = useRef(appearance);

  /** 还没保存的名称、目标：失焦时保存，关弹窗或切分区（卸载）时也保存。 */
  const pendingPatch = (): SpaceInput => {
    const { name: nextName, goal: nextGoal } = latest.current;
    const patch: SpaceInput = {};
    const trimmed = nextName.trim().slice(0, 40);
    if (trimmed && trimmed !== sent.current.name) patch.name = trimmed;
    if (nextGoal.trim() !== sent.current.goal) patch.goal = nextGoal.trim();
    return patch;
  };
  /** 发出保存；失败时把「已发出」记录改回去，界面也回滚。 */
  const save = async (patch: SpaceInput, rollback?: () => void) => {
    const before = { ...sent.current };
    sent.current = { name: patch.name ?? sent.current.name, goal: patch.goal ?? sent.current.goal };
    const ok = await latest.current.onUpdate(latest.current.subject.id, patch);
    if (ok) { flash(); return; }
    sent.current = before;
    if (alive.current) rollback?.();
  };
  useEffect(() => () => {
    if (deletingRef.current) return;
    const patch = pendingPatch();
    if (Object.keys(patch).length) void save(patch);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在卸载时读最新值
  }, []);

  const changeAppearance = async (next: { icon: string; color: string }) => {
    const ticket = ++appearanceTicket.current;
    setAppearance(next);
    const ok = await onUpdate(subject.id, next);
    if (ok) {
      confirmedAppearance.current = next;
      flash();
    } else if (alive.current && ticket === appearanceTicket.current) {
      setAppearance(confirmedAppearance.current);
    }
  };

  return (
    <>
      <div className={styles.row}>
        <label className={styles.rowLabel} htmlFor="space-settings-name">{tx("名称与图标")}</label>
        <div className={styles.nameBox}>
          <SpaceAppearancePicker
            icon={appearance.icon}
            color={appearance.color}
            onChange={(next) => void changeAppearance(next)}
          />
          <input
            id="space-settings-name"
            value={name}
            maxLength={40}
            onChange={(event) => setName(event.target.value)}
            onBlur={() => {
              if (!name.trim()) { setName(subject.name); return; }
              const patch = pendingPatch();
              if (patch.name) void save({ name: patch.name }, () => setName(sent.current.name));
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) event.currentTarget.blur();
            }}
          />
        </div>
      </div>

      <label className={styles.block}>
        <span className={styles.rowLabel}>{t("createSpace.goalLabel")}</span>
        <textarea
          value={goal}
          maxLength={400}
          rows={4}
          placeholder={t("createSpace.goalPlaceholder")}
          onChange={(event) => setGoal(event.target.value)}
          onBlur={() => {
            const patch = pendingPatch();
            if (patch.goal !== undefined) void save({ goal: patch.goal }, () => setGoal(sent.current.goal));
          }}
        />
        <span className={styles.counter}>{goal.length} / 400</span>
      </label>

      <p className={styles.savedLine} aria-live="polite">{saved ? tx("已保存") : ""}</p>

      <ModelSection {...props} onSaved={flash} />

      <hr className={styles.divider} />

      <div className={styles.dangerZone}>
        <div className={styles.row}>
          <div>
            <p className={styles.rowLabel}>{tx("删除学习空间")}</p>
            <p className={styles.rowHint}>{t("space.deleteWarning")}</p>
          </div>
          {!confirming && (
            <button type="button" className={styles.dangerBtn} onClick={() => setConfirming(true)}>
              <Trash2 size={14} aria-hidden />
              <span>{t("common.delete")}</span>
            </button>
          )}
        </div>
        {confirming && (
          // 确认放在下面单独一行：不和「删除」在同一个位置，误双击不会直接删掉
          <div className={styles.confirmRow} role="group" aria-label={tx("确认删除学习空间")}>
            <span>{tx("确定删除「{name}」吗？", { name: subject.name })}</span>
            <button type="button" className={styles.ghostBtn} onClick={() => setConfirming(false)} disabled={deleting}>
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className={styles.dangerBtn}
              disabled={deleting}
              onClick={async () => {
                setDeleting(true);
                deletingRef.current = true;
                try {
                  if (!(await onDelete())) deletingRef.current = false;
                } catch {
                  deletingRef.current = false; // 删除失败：空间还在，失败提示由上层负责
                } finally {
                  if (alive.current) setDeleting(false);
                }
              }}
            >
              {deleting ? t("common.processing") : tx("确认删除")}
            </button>
          </div>
        )}
      </div>
    </>
  );
}

function MemoryPane(props: SpaceSettingsDialogProps) {
  const { subject, onUpdate } = props;
  const { t, tx } = useI18n();
  const [instructions, setInstructions] = useState(subject.instructions);
  const [saved, flash] = useSavedFlash();
  const [sync, setSync] = useState<SpaceMemorySync | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncNote, setSyncNote] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const alive = useAlive();
  const latest = useLatest({ instructions, subject, onUpdate });
  // 已经发出去（或已确认）的教学说明：失焦刚发过的，卸载时不再重复发
  const sentInstructions = useRef(subject.instructions);
  const spaceMemories = useMemo(
    () => props.memories.filter((memory) => memory.subjectId === subject.id),
    [props.memories, subject.id],
  );

  useEffect(() => {
    chatApi.spaceMemorySync(subject.id).then((state) => { if (alive.current) setSync(state); }).catch(() => {});
  }, [subject.id, alive]);

  // 关弹窗或切分区时，没失焦的教学说明也保存
  const saveInstructions = async (text: string) => {
    const before = sentInstructions.current;
    sentInstructions.current = text;
    const ok = await latest.current.onUpdate(latest.current.subject.id, { instructions: text });
    if (ok) flash();
    else {
      sentInstructions.current = before;
      if (alive.current) setInstructions(before);
    }
  };
  useEffect(() => () => {
    const text = latest.current.instructions.trim();
    if (text !== sentInstructions.current) void saveInstructions(text);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在卸载时读最新值
  }, []);

  const syncNow = async () => {
    setSyncing(true);
    setSyncNote(null);
    try {
      const result = await chatApi.syncSpaceMemory(subject.id);
      if (!alive.current) return;
      setSync(result);
      setSyncNote(result.status === "error"
        ? { tone: "error", text: result.message || tx("没有写进总记忆。") }
        : result.status === "unchanged"
          ? { tone: "ok", text: result.entry ? tx("总记忆里已经是最新的。") : tx("这个空间还没有可以汇总的记忆。") }
          : { tone: "ok", text: tx("已写进总记忆。") });
    } catch {
      if (alive.current) setSyncNote({ tone: "error", text: tx("同步失败，稍后再试。") });
    } finally {
      if (alive.current) setSyncing(false);
    }
  };

  return (
    <>
      <label className={styles.block}>
        <span className={styles.rowLabel}>{tx("教学说明")}</span>
        <span className={styles.rowHint}>{tx("这个空间里每段对话都会读取并遵守，比如讲解方式、用哪本教材。")}</span>
        <textarea
          value={instructions}
          maxLength={4000}
          rows={4}
          placeholder={tx("告诉模型在这个空间里怎么教你…")}
          onChange={(event) => setInstructions(event.target.value)}
          onBlur={() => {
            const text = instructions.trim();
            if (text !== sentInstructions.current) void saveInstructions(text);
          }}
        />
        <span className={styles.counter}>{saved ? tx("已保存") : `${instructions.length} / 4000`}</span>
      </label>

      <MemoryNotesSection subjectId={subject.id} />
      <ThreadNotesSection subjectId={subject.id} onOpen={props.onOpenConversation} />

      <div className={styles.block}>
        <span className={styles.rowLabel}>{tx("误区与掌握")}</span>
        <span className={styles.rowHint}>{tx("对话中有依据时逐条记下，用于召回、测验和知识图谱；只在这个空间里使用，其他空间看不到。")}</span>
        {spaceMemories.length === 0 ? (
          <p className={styles.empty}>{t("space.noMemories")}</p>
        ) : (
          MEMORY_GROUPS.map((kind) => {
            const items = spaceMemories.filter((memory) => memory.kind === kind);
            if (!items.length) return null;
            return (
              <div key={kind} className={styles.memoryGroup}>
                <p className={styles.groupLabel}>{t(KIND_KEY[kind])} · {items.length}</p>
                {items.map((memory) => (
                  <MemoryItem
                    key={memory.id}
                    memory={memory}
                    subjects={props.subjects}
                    showKind={false}
                    conversationTitles={props.conversationTitles}
                    onUpdate={props.onUpdateMemory}
                    onDelete={props.onDeleteMemory}
                    onOpenConversation={props.onOpenConversation}
                  />
                ))}
              </div>
            );
          })
        )}
      </div>

      <div className={styles.block}>
        <div className={styles.row}>
          <div>
            <span className={styles.rowLabel}>{tx("汇总到总记忆")}</span>
            <p className={styles.rowHint}>
              {(sync?.intervalDays ?? 1) === 1
                ? tx("每天把这个空间的掌握情况和待巩固点汇总成一条，写进总记忆，空间外的对话也能参考。对话原文不会写进去。")
                : tx("每 {days} 天把这个空间的掌握情况和待巩固点汇总成一条，写进总记忆，空间外的对话也能参考。对话原文不会写进去。", { days: sync?.intervalDays ?? 1 })}
              {" "}
              {tx("开了「写入前确认」时不会自动写，点「立即同步」才写。")}
            </p>
          </div>
          <button type="button" className={styles.ghostBtn} onClick={() => void syncNow()} disabled={syncing}>
            <RefreshCw size={13} className={cx(syncing && styles.spinning)} aria-hidden />
            <span>{syncing ? tx("同步中…") : tx("立即同步")}</span>
          </button>
        </div>
        <div className={styles.syncCard}>
          <p className={styles.syncEntry}>{sync?.entry ?? tx("总记忆里还没有这个空间的摘要。")}</p>
          <p className={styles.syncMeta}>
            {sync?.syncedAt
              ? tx("上次同步：{last} · 下次自动同步：{next}", {
                last: relativeTime(sync.syncedAt, tx), next: relativeTime(sync.nextSyncAt, tx),
              })
              : tx("还没有同步过；在这个空间里继续学习后会自动同步。")}
          </p>
        </div>
        {syncNote && (
          <p className={cx(styles.syncNote, syncNote.tone === "error" && styles.syncNoteError)} role="status">
            {syncNote.text}
          </p>
        )}
      </div>
    </>
  );
}

/** 一个模型在下拉里的文字：名称，带推理强度时加在后面。 */
function modelText(model: CatalogModel, lang: string): string {
  const reasoning = reasoningLabel(model.tags.reasoning);
  if (!reasoning) return model.name;
  return `${model.name} · ${lang === "en" ? REASONING_EN[reasoning] ?? reasoning : reasoning}`;
}

/** 通用 · 模型：主线用哪个模型、本空间的支线默认用哪个模型。 */
function ModelSection(props: SpaceSettingsDialogProps & { onSaved: () => void }) {
  const { subject, onUpdate, onMainModelChange, onSaved } = props;
  const { lang, tx } = useI18n();
  const client = props.modelClient ?? modelLibraryApi;
  const [models, setModels] = useState<CatalogModel[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mainKey, setMainKey] = useState<string | null>(props.mainModelKey);
  const [threadKey, setThreadKey] = useState<string | null>(subject.threadModelKey);
  const alive = useAlive();
  const request = useRef({ main: 0, thread: 0 });
  // 最近一次确认成功的值：连选都失败时回到这里，而不是回到另一个也没存上的选择
  const confirmed = useRef({ main: props.mainModelKey, thread: subject.threadModelKey });

  // 外面（比如对话框里）改了模型，这里跟着变
  useEffect(() => { setMainKey(props.mainModelKey); confirmed.current.main = props.mainModelKey; }, [props.mainModelKey]);
  useEffect(() => {
    setThreadKey(subject.threadModelKey);
    confirmed.current.thread = subject.threadModelKey;
  }, [subject.threadModelKey]);

  useEffect(() => {
    const load = () => client.listSelectableModels()
      .then((items) => { if (alive.current) { setModels(items); setError(null); } })
      .catch((err) => { if (alive.current) setError(toApiError(err).message); });
    void load();
    if (typeof window === "undefined" || !window.addEventListener) return undefined;
    window.addEventListener(MODELS_CHANGED_EVENT, load);
    return () => window.removeEventListener(MODELS_CHANGED_EVENT, load);
  }, [client, alive]);

  const fallback = models?.find((model) => model.isDefault) ?? null;
  const inCatalog = (key: string | null) => Boolean(key && models?.some((model) => model.key === key));
  // 主线：选全局默认那个模型等于「用默认」；支线：null 表示跟随主线，选全局默认模型要原样存下
  const mainShown = models && !usesDefaultModel(models, mainKey) ? mainKey : null;
  const threadShown = inCatalog(threadKey) ? threadKey : null;
  const nameOf = (key: string | null) => models?.find((model) => model.key === key)?.name ?? fallback?.name ?? "";

  /** 快速连选时只认最后一次：旧请求回来（成功或失败）都不再改界面。 */
  const pick = async (which: "main" | "thread", key: string | null) => {
    const ticket = ++request.current[which];
    (which === "main" ? setMainKey : setThreadKey)(key);
    const ok = which === "main" ? await onMainModelChange(key) : await onUpdate(subject.id, { threadModelKey: key });
    if (ok) confirmed.current[which] = key;
    if (!alive.current || ticket !== request.current[which]) return;
    if (ok) onSaved();
    else (which === "main" ? setMainKey : setThreadKey)(confirmed.current[which]);
  };
  const normalizeMain = (raw: string) => {
    const model = models?.find((item) => item.key === raw);
    return model && models ? choiceFor(model, models) : null;
  };

  const noMain = !subject.mainConversationId;
  const rows = [
    {
      id: "space-model-main",
      label: tx("主线"),
      hint: noMain
        ? tx("这个空间还没有主线对话。")
        : tx("这个空间的主线对话用的模型，和对话框里的模型选择是同一个设置。"),
      value: mainShown,
      defaultText: tx("默认（{name}）", { name: fallback?.name ?? tx("未配置") }),
      disabled: noMain,
      onPick: (raw: string) => pick("main", raw ? normalizeMain(raw) : null),
    },
    {
      id: "space-model-thread",
      label: tx("支线"),
      hint: tx("新开和已有的支线默认用这个模型；在某条支线里单独选过的，以那条支线的选择为准。"),
      value: threadShown,
      defaultText: tx("跟随主线（{name}）", { name: nameOf(mainShown) || tx("未配置") }),
      disabled: false,
      onPick: (raw: string) => pick("thread", raw || null),
    },
  ];

  return (
    <div className={styles.block}>
      <span className={styles.rowLabel}>{tx("模型")}</span>
      {error && <p className={cx(styles.syncNote, styles.syncNoteError)} role="alert">{tx("读不到模型列表：{error}", { error })}</p>}
      {rows.map((row) => (
        <div key={row.id} className={styles.modelRow}>
          <div className={styles.modelText}>
            <div className={styles.modelLabel}>
              <label htmlFor={row.id}>{row.label}</label>
              {row.value && (
                <button type="button" className={styles.linkBtn} onClick={() => void row.onPick("")}>
                  {tx("使用默认")}
                </button>
              )}
            </div>
            <p className={styles.rowHint}>{row.hint}</p>
          </div>
          <select
            id={row.id}
            className={styles.modelSelect}
            value={row.value ?? ""}
            disabled={!models || row.disabled}
            onChange={(event) => void row.onPick(event.target.value)}
          >
            <option value="">{models ? row.defaultText : tx("读取中…")}</option>
            {models && groupCatalog(models).map((group) => (
              <optgroup key={group.providerId} label={group.providerName}>
                {group.models.map((model) => (
                  <option key={model.key} value={model.key}>{modelText(model, lang)}</option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>
      ))}
    </div>
  );
}

/** Memory.md：主线整理的学习记录。可以直接编辑；每次自动写入都能单独撤销。 */
function MemoryNotesSection({ subjectId }: { subjectId: string }) {
  const { lang, tx } = useI18n();
  const [notes, setNotes] = useState<SpaceMemoryNotes | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const alive = useAlive();

  useEffect(() => {
    chatApi.spaceMemoryNotes(subjectId)
      .then((next) => { if (alive.current) setNotes(next); })
      .catch((err) => { if (alive.current) setError(toApiError(err).message); });
  }, [subjectId, alive]);

  const run = async (action: () => Promise<SpaceMemoryNotes>, after?: () => void) => {
    setBusy(true);
    setError(null);
    try {
      const next = await action();
      if (!alive.current) return;
      setNotes(next);
      after?.();
    } catch (err) {
      if (alive.current) setError(toApiError(err).message);
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  // 编辑时按正在写的内容计数（和后端一样：每行一条，空行不算）
  const draftSize = draft.split("\n").map((line) => line.trim()).filter(Boolean).join("\n").length;
  const used = editing ? draftSize : notes?.size ?? 0;
  const sourceLabel = (item: SpaceMemoryNoteWrite) => item.source === "thread"
    ? tx("支线「{title}」合并", { title: item.sourceTitle || tx("已删除的支线") })
    : item.source === "main" ? tx("主线整理") : tx("你手动编辑");
  const actionLabel: Record<SpaceMemoryNoteWrite["action"], string> = {
    add: tx("新增"), patch: tx("修改"), remove: tx("删除"), replace: tx("整体编辑"),
  };
  const tagLabel = (tag: string) => (lang === "en" ? NOTE_TAG_EN[tag] ?? tag : tag);
  const history = notes?.history ?? [];

  return (
    <div className={styles.block}>
      <div className={styles.row}>
        <div>
          <span className={styles.rowLabel}>Memory.md</span>
          <p className={styles.rowHint}>
            {tx("主线整理的学习记录：支线合并、主线复盘时自动更新，主线和支线每轮都会读取。")}
          </p>
        </div>
        {!editing && notes && (
          <button
            type="button"
            className={styles.ghostBtn}
            onClick={() => { setDraft(notes.entries.join("\n")); setEditing(true); setError(null); }}
          >
            {tx("编辑")}
          </button>
        )}
      </div>

      {editing ? (
        <>
          <textarea
            value={draft}
            rows={8}
            aria-label={tx("编辑 Memory.md，每行一条")}
            placeholder={tx("每行一条，例如：[结论] 栈是后进先出")}
            onChange={(event) => setDraft(event.target.value)}
          />
          <div className={styles.row}>
            <span className={styles.rowHint}>{tx("每行一条，建议用 [结论] [进度] [疑问] [约定] 开头。")}</span>
            <div className={styles.inlineActions}>
              <button type="button" className={styles.ghostBtn} disabled={busy} onClick={() => setEditing(false)}>
                {tx("取消")}
              </button>
              <button
                type="button"
                className={styles.primaryBtn}
                disabled={busy || (notes !== null && draftSize > notes.limit)}
                onClick={() => void run(() => chatApi.saveSpaceMemoryNotes(subjectId, draft), () => setEditing(false))}
              >
                {busy ? tx("保存中…") : tx("保存")}
              </button>
            </div>
          </div>
        </>
      ) : notes && notes.entries.length > 0 ? (
        <ul className={styles.noteList}>
          {notes.entries.map((entry, index) => {
            const tag = entry.match(NOTE_TAG)?.[1];
            return (
              <li key={`${index}:${entry}`}>
                {tag && <span className={cx(styles.noteTag, tag === "疑问" && styles.noteTagOpen)}>{tagLabel(tag)}</span>}
                <span>{entry.replace(NOTE_TAG, "")}</span>
              </li>
            );
          })}
        </ul>
      ) : notes ? (
        <p className={styles.empty}>{tx("还没有内容。合并一条支线，或在主线里多学几轮后，主线会把结论整理到这里。")}</p>
      ) : null}

      {notes && (
        <span className={cx(styles.counter, used > notes.limit && styles.counterOver)}>
          {tx("{used} / {limit} 字", { used, limit: notes.limit })}
        </span>
      )}
      {error && <p className={cx(styles.syncNote, styles.syncNoteError)} role="alert">{error}</p>}

      {history.length > 0 && (
        <>
          <button type="button" className={styles.linkBtn} onClick={() => setShowHistory((value) => !value)}>
            {showHistory ? tx("收起最近更新") : tx("最近更新（{count}）", { count: history.length })}
          </button>
          {showHistory && (
            <>
              <ul className={styles.historyList}>
                {history.slice(0, HISTORY_ROWS).map((item) => (
                  <li key={item.id} className={cx(item.revoked && styles.historyRevoked)}>
                    <div>
                      <p className={styles.historyMeta}>
                        {sourceLabel(item)} · {actionLabel[item.action]} · {relativeTime(item.createdAt, tx)}
                      </p>
                      {item.action !== "replace" && (
                        <p className={styles.historyText}>{item.action === "remove" ? item.oldText : item.content}</p>
                      )}
                    </div>
                    {item.revoked ? (
                      <span className={styles.rowHint}>{tx("已撤销")}</span>
                    ) : (
                      <button
                        type="button"
                        className={styles.ghostBtn}
                        disabled={busy}
                        onClick={() => void run(() => chatApi.revokeSpaceMemoryNote(subjectId, item.id))}
                      >
                        {tx("撤销")}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
              {history.length > HISTORY_ROWS && (
                <p className={styles.rowHint}>{tx("只显示最近 {count} 次更新。", { count: HISTORY_ROWS })}</p>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

/** 每条已合并支线的小结卡：支线的记忆，主线据此整理 Memory.md。 */
function ThreadNotesSection({ subjectId, onOpen }: { subjectId: string; onOpen: (id: string) => void }) {
  const { tx } = useI18n();
  const [cards, setCards] = useState<SpaceThreadNote[] | null>(null);
  const alive = useAlive();

  useEffect(() => {
    chatApi.spaceThreadNotes(subjectId)
      .then((next) => { if (alive.current) setCards(next); })
      .catch(() => { if (alive.current) setCards([]); });
  }, [subjectId, alive]);

  return (
    <div className={styles.block}>
      <span className={styles.rowLabel}>{tx("支线记录")}</span>
      <span className={styles.rowHint}>{tx("每条支线合并时留下的小结卡，主线据此整理 Memory.md。")}</span>
      {cards && cards.length === 0 && <p className={styles.empty}>{tx("还没有合并过支线。")}</p>}
      {cards && cards.length > 0 && (
        <ul className={styles.threadCards}>
          {cards.map((card) => (
            <li key={card.threadId}>
              <details>
                <summary>
                  <span className={styles.threadTitle}>{card.title}</span>
                  <span className={styles.rowHint}>{relativeTime(card.mergedAt, tx)}</span>
                </summary>
                <p className={styles.threadSummary}>{card.summary}</p>
                {card.takeaways.length > 0 && (
                  <ul className={styles.takeaways}>
                    {card.takeaways.map((item, index) => <li key={index}>{item}</li>)}
                  </ul>
                )}
                {card.status !== "deleted" && (
                  <button type="button" className={styles.linkBtn} onClick={() => onOpen(card.threadId)}>
                    {tx("打开这条支线")}
                  </button>
                )}
              </details>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function UsagePane(props: SpaceSettingsDialogProps) {
  const { subject } = props;
  const { tx } = useI18n();
  const [usage, setUsage] = useState<SpaceUsage | null>(null);
  const [threads, setThreads] = useState<ConversationSummary[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const alive = useAlive();
  const spaceMemories = useMemo(
    () => props.memories.filter((memory) => memory.subjectId === subject.id),
    [props.memories, subject.id],
  );

  useEffect(() => {
    // 两个请求各管各的：一个失败不连累另一个
    chatApi.spaceUsage(subject.id)
      .then((next) => { if (alive.current) setUsage(next); })
      .catch(() => { if (alive.current) setFailed(true); });
    chatApi.listThreads(subject.id)
      .then((next) => { if (alive.current) setThreads(next); })
      .catch(() => { if (alive.current) setThreads([]); });
  }, [subject.id, alive]);

  const weak = spaceMemories.filter((memory) => memory.kind === "misconception" && memory.status !== "resolved");
  const mastered = spaceMemories.filter((memory) => memory.kind !== "preference"
    && (memory.kind === "mastery" || memory.status === "resolved"));
  const doneThreads = threads?.filter((thread) => thread.threadStatus === "resolved").length;
  const openThreads = threads?.filter((thread) => thread.threadStatus !== "resolved").length;
  const titles: Record<string, string> = {
    ...props.conversationTitles,
    ...Object.fromEntries((threads ?? []).map((thread) => [thread.id, thread.title])),
  };
  if (subject.mainConversationId) titles[subject.mainConversationId] = tx("主线");

  const total = usage?.total;
  const grand = total ? tokenTotal(total) : 0;
  const cached = total?.cachedTokens ?? 0;
  const freshInput = total ? Math.max(0, total.inputTokens - cached) : 0;
  const segments = total && grand > 0 ? [
    { key: "input", label: tx("输入"), value: freshInput, className: styles.segInput },
    { key: "cached", label: tx("缓存命中"), value: cached, className: styles.segCached },
    { key: "output", label: tx("输出"), value: total.outputTokens, className: styles.segOutput },
  ] : [];
  const rows = Object.entries(usage?.conversations ?? {})
    .map(([id, item]) => ({ id, tokens: tokenTotal(item) }))
    .filter((row) => row.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens);
  const visibleRows = showAll ? rows : rows.slice(0, TABLE_ROWS);

  return (
    <>
      <div className={styles.block}>
        <span className={styles.rowLabel}>{tx("学习足迹")}</span>
        <div className={styles.stats}>
          <Stat value={weak.length} label={tx("待巩固")} />
          <Stat value={mastered.length} label={tx("已掌握")} />
          <Stat value={doneThreads} label={tx("已完成支线")} />
          <Stat value={openThreads} label={tx("进行中支线")} />
          <Stat value={subject.materialCount} label={tx("资料")} />
        </div>
        {weak.length > 0 && (
          <ul className={styles.weakList}>
            {weak.map((memory) => (
              <li key={memory.id}>
                <div>
                  <strong>{memory.topic}</strong>
                  <p>{memory.summary}</p>
                </div>
                {props.onPractice && (
                  <button type="button" className={styles.ghostBtn} onClick={() => props.onPractice?.(memory)}>
                    {tx("专项攻克")}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {mastered.length > 0 && (
          <ul className={styles.doneList}>
            {mastered.map((memory) => (
              <li key={memory.id}>
                <CheckCircle2 size={13} aria-hidden />
                <span>{tx("{topic}：{summary}", { topic: memory.topic, summary: memory.summary })}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className={styles.block}>
        <div className={styles.row}>
          <span className={styles.rowLabel}>{tx("Token 用量")}</span>
          <span className={styles.bigNumber}>{total ? compactTokens(grand) : "—"}</span>
        </div>
        {failed && <p className={styles.empty}>{tx("读不到用量数据。")}</p>}
        {!failed && total && grand === 0 && <p className={styles.empty}>{tx("这个空间还没有产生用量。")}</p>}
        {segments.length > 0 && (
          <>
            <div className={styles.bar} role="img" aria-label={segments.map((seg) => `${seg.label} ${compactTokens(seg.value)}`).join(" · ")}>
              {segments.map((seg) => seg.value > 0 && (
                <span key={seg.key} className={seg.className} style={{ flexGrow: seg.value }} />
              ))}
            </div>
            <ul className={styles.legend}>
              {segments.map((seg) => (
                <li key={seg.key}>
                  <i className={seg.className} aria-hidden />
                  <span>{seg.label}</span>
                  <strong>{compactTokens(seg.value)}</strong>
                </li>
              ))}
            </ul>
          </>
        )}
        {rows.length > 0 && (
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">{tx("对话")}</th>
                <th scope="col">{tx("Token")}</th>
                <th scope="col">{tx("占比")}</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row) => (
                <tr key={row.id}>
                  <td>
                    <button type="button" className={styles.linkBtn} onClick={() => props.onOpenConversation(row.id)}>
                      {titles[row.id] || tx("未命名对话")}
                    </button>
                  </td>
                  <td>{compactTokens(row.tokens)}</td>
                  <td>{grand ? `${Math.round((row.tokens / grand) * 100)}%` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {rows.length > TABLE_ROWS && (
          <button type="button" className={styles.linkBtn} onClick={() => setShowAll((value) => !value)}>
            {showAll ? tx("收起") : tx("再显示 {count} 条", { count: rows.length - TABLE_ROWS })}
          </button>
        )}
        <p className={styles.rowHint}>{tx("按这个空间里的对话统计，包含回复和后台的记忆分析；没有回报用量的请求不计入。")}</p>
      </div>
    </>
  );
}

function Stat({ value, label }: { value: number | undefined; label: string }) {
  return (
    <div className={styles.stat}>
      <strong>{value ?? "—"}</strong>
      <span>{label}</span>
    </div>
  );
}

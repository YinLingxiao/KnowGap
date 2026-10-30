"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Brain, Cpu, FolderOpen, Gauge, Monitor, Moon, Plus, Search, Settings, Sliders, Sparkles, Sun, Trash2, Upload, User, X,
} from "lucide-react";
import { chatApi } from "@/lib/chat/api";
import { useI18n } from "@/components/LanguageProvider";
import type { Language, MessageKey } from "@/lib/i18n";
import type { LearnerMemory, TokenUsage } from "@/lib/chat/types";
import { updatePassword, type AuthUser } from "@/lib/api/auth";
import type { HealthState } from "@/hooks/useWorkbench";
import {
  applyAppearance, readAppearance, writeAppearance,
  type Appearance, type ChatWidth, type MotionChoice, type TextSize,
} from "@/lib/appearance";
import type { DataSource } from "@/lib/config";
import { cx } from "@/lib/cx";
import { THEME_KEY, useThemeChoice, type ThemeChoice } from "../ThemeToggle";
import type { AIConfigStatus } from "@/lib/api/ai-config";
import { ModelAccessCard, type ModelSignal } from "./ModelAccessCard";
import { SearchKeyCard } from "./SearchKeyCard";
import { ServiceModelsSection } from "./ServiceModelsSection";
import { useDevMode, writeDevMode } from "@/lib/devMode";
import styles from "./Settings.module.css";
import { UpdateRows } from "./UpdateRows";

declare global {
  interface Window {
    knowgap?: {
      windowChrome?: { platform: "win32" | "darwin" | "linux" };
      selectFolder: (defaultPath?: string) => Promise<string | null>;
      setTheme?: (theme: "system" | "light" | "dark") => Promise<string>;
      /** 主窗口：快问浮窗请求打开某个对话；未订阅时桌面壳会刷新主窗口 */
      onOpenConversation?: (listener: (conversationId: string) => void) => () => void;
      /** 仅快问浮窗窗口使用 */
      quick?: {
        hide: () => Promise<void>;
        resize: (height: number) => Promise<void>;
        shortcut: () => Promise<string | null>;
        openInMain: (conversationId?: string) => Promise<void>;
        onShown: (listener: () => void) => () => void;
      };
      showMain?: () => void;
      setTrayStatus?: (status: { todayCount?: number }) => void;
      getDesktopSettings?: () => Promise<{ closeToTray: boolean; openAtLogin: boolean }>;
      setDesktopSettings?: (
        patch: Partial<{ closeToTray: boolean; openAtLogin: boolean }>,
      ) => Promise<{ closeToTray: boolean; openAtLogin: boolean }>;
    };
  }
}

export type SettingsTab = "general" | "account" | "usage" | "memory" | "preferences" | "reflect" | "models" | "workspace" | "skills";
type Tab = SettingsTab;
type Effort = "off" | "low" | "medium" | "high";

const EFFORT_STORAGE_KEY = "knowgap.thinking.effort.v1";
const EFFORT_EVENT = "knowgap:thinking-effort";

const GROUPS: Array<{ titleKey: MessageKey; items: Array<{ key: Tab; labelKey: MessageKey; icon: typeof Settings }> }> = [
  {
    titleKey: "settings.group.settings",
    items: [
      { key: "general", labelKey: "settings.tab.general", icon: Settings },
      { key: "account", labelKey: "settings.tab.account", icon: User },
      { key: "usage", labelKey: "settings.tab.usage", icon: Gauge },
      { key: "memory", labelKey: "settings.tab.memory", icon: Brain },
      { key: "preferences", labelKey: "settings.tab.preferences", icon: Sparkles },
      { key: "reflect", labelKey: "settings.tab.reflect", icon: Sparkles },
    ],
  },
  {
    titleKey: "settings.group.local",
    items: [
      { key: "models", labelKey: "settings.tab.models", icon: Cpu },
      { key: "workspace", labelKey: "settings.tab.workspace", icon: FolderOpen },
    ],
  },
  {
    titleKey: "settings.group.custom",
    items: [{ key: "skills", labelKey: "settings.tab.skills", icon: Sliders }],
  },
];

const THEME_OPTIONS: Array<{ id: ThemeChoice; icon: typeof Monitor }> = [
  { id: "system", icon: Monitor },
  { id: "light", icon: Sun },
  { id: "dark", icon: Moon },
];
const TEXT_SIZES: Array<{ id: TextSize; labelKey: MessageKey }> = [
  { id: "small", labelKey: "settings.textSize.small" },
  { id: "medium", labelKey: "settings.textSize.medium" },
  { id: "large", labelKey: "settings.textSize.large" },
];
const WIDTHS: Array<{ id: ChatWidth; labelKey: MessageKey }> = [
  { id: "narrow", labelKey: "settings.width.narrow" },
  { id: "medium", labelKey: "settings.width.medium" },
  { id: "wide", labelKey: "settings.width.wide" },
  { id: "full", labelKey: "settings.width.full" },
];
const MOTIONS: Array<{ id: MotionChoice; labelKey: MessageKey }> = [
  { id: "system", labelKey: "settings.motion.system" },
  { id: "reduced", labelKey: "settings.motion.reduced" },
];
const LANGUAGE_OPTIONS: Array<{ id: Language; label: string }> = [
  { id: "zh", label: "中文" },
  { id: "en", label: "English" },
];
const EFFORTS: Array<{ id: Effort; label: string }> = [
  { id: "off", label: "标准" },
  { id: "low", label: "低" },
  { id: "medium", label: "中" },
  { id: "high", label: "高" },
];
const INTEREST_DOMAINS = [
  "编程与计算机",
  "数学与统计",
  "物理与工程",
  "经济与金融",
  "语言与文学",
  "法学与社科",
  "设计与创意",
  "生物与医学",
  "考研与资格考",
  "科研与论文",
];
const SKILLS = [
  {
    key: "deep_explain",
    name: "深度原理精讲",
    role: "支线优先注入",
    desc: "一句话交代主线 → 列三步计划 → 构造贯穿全文的最小例子 → 根据用户偏好调整推导顺序",
  },
  {
    key: "socratic_practice",
    name: "启发式带练与诊断",
    role: "支线优先注入",
    desc: "结合校验过的练习判据与用户互动偏好，先确认正确部分，再用最小步进提示引导思考",
  },
  {
    key: "study_note_builder",
    name: "结构化图解讲义构建",
    role: "支线优先注入",
    desc: "梳理概念框架、编写贯穿示例与对比表，支持在工作区生成结构化文档或代码演练",
  },
  {
    key: "roadmap_planner",
    name: "学习路线规划",
    role: "项目主线专属",
    desc: "对齐空间目标、基础与截止日，跳过已掌握知识点，针对薄弱点拆解候选支线",
  },
];

interface SettingsDialogProps {
  source: DataSource;
  health: HealthState;
  studentId: string;
  modelSignal: ModelSignal;
  modelError?: string;
  onCheckHealth: () => void;
  onConfigChange: (config: AIConfigStatus, saved: boolean) => void;
  onClose: () => void;
  user?: AuthUser;
  initialTab?: SettingsTab;
  onLogout?: () => void;
  onRename?: (name: string) => Promise<void>;
}

export function SettingsDialog({
  source, health, studentId, modelSignal, modelError = "", onCheckHealth, onConfigChange, onClose, user, initialTab = "general", onLogout, onRename,
}: SettingsDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const [tab, setTab] = useState<Tab>(initialTab);
  const [query, setQuery] = useState("");
  const userId = user?.id || studentId;
  const { t, tx } = useI18n();

  useEffect(() => {
    setTab(initialTab);
  }, [initialTab]);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  const groups = useMemo(() => {
    const localized = GROUPS.map((group) => ({
      title: t(group.titleKey),
      items: group.items.map((item) => ({ ...item, label: t(item.labelKey) })),
    }));
    const needle = query.trim().toLowerCase();
    if (!needle) return localized;
    return localized.map((group) => ({
      ...group,
      items: group.items.filter(
        (item) => item.label.toLowerCase().includes(needle) || group.title.toLowerCase().includes(needle),
      ),
    })).filter((group) => group.items.length > 0);
  }, [query, t]);

  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      aria-labelledby="settings-title"
      onClose={onClose}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
    >
      <div className={styles.frame}>
        <h2 id="settings-title" className="sr-only">{t("settings.title")}</h2>
        <div className={styles.layout}>
          <aside className={styles.sidebar}>
            <label className={styles.searchBox}>
              <Search size={13} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("settings.searchPlaceholder")}
                aria-label={t("settings.searchAria")}
              />
            </label>
            {groups.map((group) => (
              <div key={group.title} className={styles.navGroup}>
                <p className={styles.groupTitle}>{group.title}</p>
                {group.items.map((item) => {
                  const Icon = item.icon;
                  return (
                    <button
                      key={item.key}
                      type="button"
                      className={cx(styles.navItem, tab === item.key && styles.navItemActive)}
                      onClick={() => setTab(item.key)}
                    >
                      <Icon size={15} />
                      {item.label}
                    </button>
                  );
                })}
              </div>
            ))}
          </aside>
          <div className={styles.content}>
            <button className={styles.closeBtn} onClick={onClose} aria-label={t("settings.close")}>
              <X size={16} />
            </button>
            <div className={styles.contentScroll}>
              <div key={tab} className={styles.tabPane}>
                {tab === "general" && <GeneralPane userId={userId} />}
                {tab === "account" && (
                  <AccountPane
                    user={user}
                    studentId={studentId}
                    onLogout={onLogout}
                    onRename={onRename}
                    onOpenPreferences={() => setTab("preferences")}
                    onClose={onClose}
                  />
                )}
                {tab === "usage" && <UsagePane />}
                {tab === "memory" && <MemoryPane />}
                {tab === "preferences" && <PreferencesPane />}
                {tab === "reflect" && <ReflectPane />}
                {tab === "models" && (
                  <section>
                    <h2 className={styles.sectionTitle}>{tx("模型接入与服务模型分工")}</h2>
                    <EffortRow />
                    <ModelAccessCard
                      plain
                      source={source}
                      health={health}
                      signal={modelSignal}
                      setupError={modelError}
                      onCheckHealth={onCheckHealth}
                      onConfigChange={onConfigChange}
                    />
                    <div style={{ marginTop: 18 }}>
                      <ServiceModelsSection />
                    </div>
                    <SearchKeyCard />
                  </section>
                )}
                {tab === "workspace" && <WorkspacePane />}
                {tab === "skills" && <SkillsPane />}
              </div>
            </div>
          </div>
        </div>
      </div>
    </dialog>
  );
}

function SettingRow({ title, desc, children }: { title: string; desc?: string; children: ReactNode }) {
  return (
    <div className={styles.settingRow}>
      <div className={styles.settingRowInfo}>
        <p className={styles.settingRowTitle}>{title}</p>
        {desc && <p className={styles.settingRowDesc}>{desc}</p>}
      </div>
      {children}
    </div>
  );
}

function Pills<T extends string>({
  label, value, options, onChange,
}: {
  label: string;
  value: T;
  options: Array<{ id: T; label: string; icon?: typeof Monitor }>;
  onChange: (id: T) => void;
}) {
  return (
    <div className={styles.pillGroup} role="radiogroup" aria-label={label}>
      {options.map((option) => {
        const Icon = option.icon;
        return (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={value === option.id}
            className={cx(styles.pillOption, value === option.id && styles.pillOptionActive)}
            onClick={() => onChange(option.id)}
          >
            {Icon && <Icon size={13} />}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function Toggle({ checked, label, onChange }: { checked: boolean; label: string; onChange: (value: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={cx(styles.switch, checked && styles.switchOn)}
      onClick={() => onChange(!checked)}
    >
      <span className={styles.thumb} />
    </button>
  );
}

function DesktopRows() {
  const { t } = useI18n();
  const [desktop, setDesktop] = useState<{ closeToTray: boolean; openAtLogin: boolean } | null>(null);
  useEffect(() => {
    const api = window.knowgap;
    if (!api?.getDesktopSettings) return;
    let cancelled = false;
    void api.getDesktopSettings().then((value) => {
      if (!cancelled && value && typeof value.closeToTray === "boolean" && typeof value.openAtLogin === "boolean") {
        setDesktop(value);
      }
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  if (!desktop) return null;
  const patch = (next: Partial<{ closeToTray: boolean; openAtLogin: boolean }>) => {
    setDesktop({ ...desktop, ...next });
    void window.knowgap?.setDesktopSettings?.(next).catch(() => {
      void window.knowgap?.getDesktopSettings?.().then((value) => {
        if (value && typeof value.closeToTray === "boolean" && typeof value.openAtLogin === "boolean") setDesktop(value);
      }).catch(() => undefined);
    });
  };
  return (
    <>
      <p className={styles.sectionLabel}>{t("settings.desktop.section")}</p>
      <SettingRow title={t("settings.desktop.closeToTray")} desc={t("settings.desktop.closeToTrayDesc")}>
        <Toggle checked={desktop.closeToTray} label={t("settings.desktop.closeToTray")} onChange={(closeToTray) => patch({ closeToTray })} />
      </SettingRow>
      <SettingRow title={t("settings.desktop.openAtLogin")} desc={t("settings.desktop.openAtLoginDesc")}>
        <Toggle checked={desktop.openAtLogin} label={t("settings.desktop.openAtLogin")} onChange={(openAtLogin) => patch({ openAtLogin })} />
      </SettingRow>
    </>
  );
}

function GeneralPane({ userId }: { userId: string }) {
  const { lang, setLang, t } = useI18n();
  const [theme, setTheme] = useThemeChoice();
  const [look, setLook] = useState<Appearance>(() => readAppearance(userId));
  useEffect(() => {
    applyAppearance(look);
  }, [look]);
  function patch(next: Appearance) {
    setLook(next);
    writeAppearance(userId, next);
  }
  return (
    <section>
      <h2 className={styles.sectionTitle}>{t("settings.general.title")}</h2>
      <p className={styles.sectionLabel}>{t("settings.general.section")}</p>
      <SettingRow title={t("settings.general.language")} desc={t("settings.general.languageDesc")}>
        <Pills
          label={t("settings.general.languageAria")}
          value={lang}
          options={LANGUAGE_OPTIONS}
          onChange={setLang}
        />
      </SettingRow>
      <SettingRow title={t("settings.general.theme")} desc={t("settings.general.themeDesc")}>
        <Pills
          label={t("settings.general.theme")}
          value={theme}
          options={THEME_OPTIONS.map((item) => ({ ...item, label: t(THEME_KEY[item.id]) }))}
          onChange={setTheme}
        />
      </SettingRow>
      <SettingRow title={t("settings.general.textSize")} desc={t("settings.general.textSizeDesc")}>
        <Pills
          label={t("settings.general.textSize")}
          value={look.textSize}
          options={TEXT_SIZES.map((item) => ({ ...item, label: t(item.labelKey) }))}
          onChange={(textSize) => patch({ ...look, textSize })}
        />
      </SettingRow>
      <SettingRow title={t("settings.general.width")} desc={t("settings.general.widthDesc")}>
        <Pills
          label={t("settings.general.width")}
          value={look.width}
          options={WIDTHS.map((item) => ({ ...item, label: t(item.labelKey) }))}
          onChange={(width) => patch({ ...look, width })}
        />
      </SettingRow>
      <SettingRow title={t("settings.general.motion")} desc={t("settings.general.motionDesc")}>
        <Pills
          label={t("settings.general.motion")}
          value={look.motion}
          options={MOTIONS.map((item) => ({ ...item, label: t(item.labelKey) }))}
          onChange={(motion) => patch({ ...look, motion })}
        />
      </SettingRow>
      <DesktopRows />
      <UpdateRows />
    </section>
  );
}

function PreferencesPane() {
  const { tx } = useI18n();
  const [entries, setEntries] = useState({ background: "", explanation: "", interaction: "" });
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    chatApi.learningPreferences().then((next) => { if (live) setEntries(next); }).catch(() => { if (live) setNote(tx("读不到已保存的偏好。")); });
    return () => { live = false; };
  }, [tx]);

  const fields = [
    ["background", "学习背景", "最近在学什么，学到哪了"],
    ["explanation", "讲解偏好", "先看例子，还是先看定义"],
    ["interaction", "互动偏好", "先给提示，还是直接解析"],
  ] as const;

  return (
    <section>
      <h2 className={styles.sectionTitle}>{tx("学习偏好")}</h2>
      <p className={styles.settingRowDesc}>{tx("可选。写完才会记住，不填也能直接学。")}</p>
      <form
        className={styles.fields}
        onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
          setNote("");
          void chatApi.saveLearningPreferences(entries)
            .then((saved) => { setEntries(saved); setNote(tx("已记住")); })
            .catch((error: unknown) => setNote(error instanceof Error ? error.message : tx("没能保存")))
            .finally(() => setBusy(false));
        }}
      >
        {fields.map(([key, label, placeholder]) => (
          <label key={key} className={styles.fieldFull}>
            <span className={styles.fieldLabel}>{tx(label)}</span>
            <input
              className={styles.input}
              maxLength={220}
              aria-label={tx(label)}
              placeholder={tx(placeholder)}
              value={entries[key]}
              onChange={(event) => setEntries((current) => ({ ...current, [key]: event.target.value }))}
            />
          </label>
        ))}
        <button className={styles.rowBtnPrimary} type="submit" disabled={busy}>{tx("记住这些偏好")}</button>
      </form>
      <SettingRow title={tx("演示数据")} desc={tx("删掉本账号里导入的演示空间和日程。")}>
        <button
          className={styles.rowBtn}
          type="button"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setNote("");
            void chatApi.resetDemo()
              .then(() => setNote(tx("演示数据已清除")))
              .catch((error: unknown) => setNote(error instanceof Error ? error.message : tx("没能清除")))
              .finally(() => setBusy(false));
          }}
        >
          {tx("清除演示数据")}
        </button>
      </SettingRow>
      {note && <p className={styles.fieldHint}>{note}</p>}
    </section>
  );
}

function AccountPane({
  user, studentId, onLogout, onRename, onOpenPreferences, onClose,
}: {
  user?: AuthUser;
  studentId: string;
  onLogout?: () => void;
  onRename?: (name: string) => Promise<void>;
  onOpenPreferences?: () => void;
  onClose: () => void;
}) {
  const { tx } = useI18n();
  const [name, setName] = useState(user?.displayName || "演示学习者");
  const [curPw, setCurPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [domains, setDomains] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const providerLabel = user?.provider === "email" ? tx("邮箱账号") : tx("本机演示身份");

  useEffect(() => {
    void chatApi
      .agentNotes()
      .then((notes) => {
        const line = splitEntries(notes.user).find((item) => item.startsWith("常学领域："));
        if (line) {
          const parsed = line
            .replace(/^常学领域：/, "")
            .split(/[、，,\s]+/)
            .map((s) => s.trim())
            .filter(Boolean);
          setDomains(parsed);
        }
      })
      .catch(() => {});
  }, []);

  const toggleDomain = async (domain: string) => {
    const next = domains.includes(domain) ? domains.filter((d) => d !== domain) : [...domains, domain];
    setDomains(next);
    try {
      const notes = await chatApi.agentNotes();
      const kept = splitEntries(notes.user).filter((item) => !item.startsWith("常学领域："));
      const updated = next.length > 0 ? [...kept, `常学领域：${next.join("、")}`] : kept;
      await chatApi.saveAgentNote("user", updated.join("\n§\n"));
    } catch {
      setNote(tx("保存常学领域失败"));
    }
  };

  return (
    <section>
      <h2 className={styles.sectionTitle}>{tx("个人资料与账户")}</h2>
      <div className={styles.groupCard}>
        <div className={styles.groupCardHead}>{tx("账户信息")}</div>
        <div className={styles.groupCardBody}>
          <div className={styles.accountHead}>
            <span className={styles.accountAvatar}>{user?.avatarText || name.slice(0, 1) || tx("学")}</span>
            <div>
              <p className={styles.settingRowTitle}>{user?.displayName || name}</p>
              <p className={styles.settingRowDesc}>{user?.username || studentId} · {providerLabel}</p>
            </div>
          </div>

          <SettingRow title={tx("显示昵称")} desc={tx("用于侧栏底部头像与首页问候语。")}>
            <form
              className={styles.nameForm}
              onSubmit={(event) => {
                event.preventDefault();
                if (!onRename) return;
                setBusy(true);
                void onRename(name)
                  .then(() => setNote(tx("昵称已保存")))
                  .catch((error: unknown) => {
                    setNote(error instanceof Error ? error.message : tx("保存失败"));
                  })
                  .finally(() => setBusy(false));
              }}
            >
              <input value={name} maxLength={30} onChange={(event) => setName(event.target.value)} aria-label={tx("昵称")} />
              <button className={styles.rowBtn} type="submit" disabled={busy || !name.trim()}>
                {tx("保存")}
              </button>
            </form>
          </SettingRow>

          {/* 参照 LobeHub 图 4「兴趣/常学领域」多选胶囊墙 */}
          <div className={styles.domainRow}>
            <div className={styles.settingRowInfo}>
              <p className={styles.settingRowTitle}>{tx("常学与关注领域")}</p>
              <p className={styles.settingRowDesc}>{tx("点选后自动同步至 USER 画像，AI 举例时会优先贴合你的领域背景。")}</p>
            </div>
            <div className={styles.domainGrid} role="group" aria-label={tx("常学领域")}>
              {INTEREST_DOMAINS.map((domain) => {
                const active = domains.includes(domain);
                return (
                  <button
                    key={domain}
                    type="button"
                    aria-pressed={active}
                    className={cx(styles.domainTag, active && styles.domainTagActive)}
                    onClick={() => void toggleDomain(domain)}
                  >
                    <span>{tx(domain)}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {user?.provider === "email" && (
            <SettingRow title={tx("修改密码")} desc={tx("输入当前密码与新密码（至少 6 位）。")}>
              <form
                className={styles.nameForm}
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!curPw || newPw.length < 6 || busy) return;
                  setBusy(true);
                  void updatePassword(curPw, newPw)
                    .then(() => {
                      setCurPw("");
                      setNewPw("");
                      setNote(tx("密码已更新"));
                    })
                    .catch((error: unknown) => {
                      setNote(error instanceof Error ? error.message : tx("密码修改失败"));
                    })
                    .finally(() => setBusy(false));
                }}
              >
                <input
                  type="password"
                  value={curPw}
                  placeholder={tx("当前密码")}
                  aria-label={tx("当前密码")}
                  onChange={(event) => setCurPw(event.target.value)}
                />
                <input
                  type="password"
                  value={newPw}
                  placeholder={tx("新密码（6位+）")}
                  aria-label={tx("新密码")}
                  onChange={(event) => setNewPw(event.target.value)}
                />
                <button className={styles.rowBtn} type="submit" disabled={busy || !curPw || newPw.length < 6}>
                  {tx("更新密码")}
                </button>
              </form>
            </SettingRow>
          )}

          <SettingRow title={tx("学习偏好")} desc={tx("可选。写下背景和讲法，之后的讲解会按这个来。")}>
            <button className={styles.rowBtn} type="button" onClick={() => onOpenPreferences?.()}>
              {tx("去填写")}
            </button>
          </SettingRow>

          <SettingRow title={tx("退出登录")} desc={tx("清除本机登录会话并返回认证界面。")}>
            <button
              className={cx(styles.rowBtn, styles.textBtnDanger)}
              type="button"
              onClick={() => {
                onClose();
                void onLogout?.();
              }}
            >
              {tx("退出当前账号")}
            </button>
          </SettingRow>
        </div>
      </div>
      {note && <p className={styles.emptyLine}>{note}</p>}
    </section>
  );
}

function UsagePane() {
  const { tx } = useI18n();
  const [total, setTotal] = useState<TokenUsage | null>(null);
  const [spaces, setSpaces] = useState<Array<TokenUsage & { id: string; name: string }>>([]);
  const [note, setNote] = useState("");
  useEffect(() => {
    void chatApi
      .accountUsage()
      .then((data) => {
        setTotal(data.total);
        setSpaces(data.spaces);
      })
      .catch(() => setNote(tx("读不到用量")));
  }, [tx]);
  return (
    <section>
      <h2 className={styles.sectionTitle}>{tx("用量")}</h2>
      {total && (
        <SettingRow
          title={tx("当前账号总计")}
          desc={tx("共 {requests} 次请求 · 输入 {input} Tokens · 输出 {output} Tokens", {
            requests: total.requests,
            input: total.inputTokens.toLocaleString(),
            output: total.outputTokens.toLocaleString(),
          })}
        >
          <span className={styles.skillMeta}>{tx("缓存命中 {count}", { count: (total.cachedTokens ?? 0).toLocaleString() })}</span>
        </SettingRow>
      )}
      {spaces.length > 0 && <p className={styles.sectionLabel}>{tx("按学习空间拆分")}</p>}
      {spaces.map((space) => (
        <SettingRow
          key={space.id}
          title={space.name}
          desc={tx("{requests} 次请求 · 输入 {input} · 输出 {output}", {
            requests: space.requests,
            input: space.inputTokens.toLocaleString(),
            output: space.outputTokens.toLocaleString(),
          })}
        >
          <span className={styles.skillMeta}>{tx("缓存 {count}", { count: (space.cachedTokens ?? 0).toLocaleString() })}</span>
        </SettingRow>
      ))}
      {!total && !note && <p className={styles.emptyLine}>{tx("正在读取用量…")}</p>}
      {note && <p className={styles.emptyLine}>{note}</p>}
      {total && spaces.length === 0 && <p className={styles.emptyLine}>{tx("还没有按学习空间拆分的用量。")}</p>}
    </section>
  );
}

function splitEntries(content: string) {
  return content.split(/\s*§\s*/).map((item) => item.trim()).filter(Boolean);
}

type LayerId = "identity" | "preference" | "context" | "activity" | "experience";

const MEMORY_LAYERS: Array<{ id: LayerId; tag: string; label: string; hint: string }> = [
  { id: "identity", tag: "Identity", label: "身份与技能栈", hint: "你是谁、已掌握哪些旧知" },
  { id: "preference", tag: "Preference", label: "教学偏好", hint: "喜欢怎样被教" },
  { id: "context", tag: "Context", label: "目标与约束", hint: "学习目标、截止时间、限制" },
  { id: "activity", tag: "Activity", label: "近期动态", hint: "最近学了什么、复盘结论" },
  { id: "experience", tag: "Experience", label: "经验法则", hint: "沉淀下来的学习方法" },
];

const PRIOR_PREFIX = "先验技能：";
const PRIOR_SKILLS = [
  "C / C++", "Python", "Java / JS", "高等数学", "线性代数", "概率统计", "大学物理", "电路原理", "数据结构与算法",
];

const LAYER_PREFIX_RE = /^\[(Identity|Preference|Context|Activity|Experience)\]\s*/i;

function layerOf(entry: string): LayerId {
  const explicit = LAYER_PREFIX_RE.exec(entry);
  if (explicit) return explicit[1].toLowerCase() as LayerId;
  if (/^(先验技能|常学领域|身份|专业|年级|技能栈)/.test(entry)) return "identity";
  if (/^(阶段目标|背景约束|目标|截止|约束|时间|考试|背景)/.test(entry)) return "context";
  if (/^(近期动态|阶段复盘|近期|最近|本周)/.test(entry)) return "activity";
  if (/^(经验法则|经验|法则|心得|教训|方法)/.test(entry)) return "experience";
  return "preference";
}

function stripLayer(entry: string) {
  return entry.replace(LAYER_PREFIX_RE, "");
}

function parsePriorSkills(notes: string[]) {
  const line = notes.map(stripLayer).find((item) => item.startsWith(PRIOR_PREFIX));
  if (!line) return [];
  return line.slice(PRIOR_PREFIX.length).split(/[、，,;；]+/).map((item) => item.trim()).filter(Boolean);
}

function MemoryPane() {
  const { tx } = useI18n();
  const [approval, setApproval] = useState(false);
  const [workspace, setWorkspace] = useState("");
  const [autoApprove, setAutoApprove] = useState(false);
  const [userNotes, setUserNotes] = useState<string[]>([]);
  const [memoryNotes, setMemoryNotes] = useState<string[]>([]);
  const [limits, setLimits] = useState({ user: 1375, memory: 2200 });
  const [draft, setDraft] = useState("");
  const [target, setTarget] = useState<"user" | "memory">("user");
  const [layer, setLayer] = useState<LayerId>("preference");
  const [customSkill, setCustomSkill] = useState("");
  const [note, setNote] = useState("");

  useEffect(() => {
    void chatApi
      .agentSettings()
      .then((settings) => {
        setApproval(settings.memoryWriteApproval);
        setWorkspace(settings.workspace);
        setAutoApprove(settings.autoApprove);
      })
      .catch(() => setNote(tx("读不到记忆设置")));
    void chatApi
      .agentNotes()
      .then((notes) => {
        setUserNotes(splitEntries(notes.user));
        setMemoryNotes(splitEntries(notes.memory));
        setLimits(notes.limits);
      })
      .catch(() => setNote(tx("读不到画像")));
  }, [tx]);

  async function saveApproval(next: boolean) {
    setApproval(next);
    try {
      await chatApi.saveAgentSettings({ workspace, autoApprove, memoryWriteApproval: next });
    } catch (error) {
      setApproval(!next);
      setNote(error instanceof Error ? error.message : tx("保存失败"));
    }
  }

  async function save(kind: "user" | "memory", items: string[]) {
    const saved = await chatApi.saveAgentNote(kind, items.join("\n§\n"));
    setUserNotes(splitEntries(saved.user));
    setMemoryNotes(splitEntries(saved.memory));
    setLimits(saved.limits);
  }

  const userChars = userNotes.join("\n§\n").length;
  const memChars = memoryNotes.join("\n§\n").length;
  const priorSkills = parsePriorSkills(userNotes);
  const skillOptions = [...PRIOR_SKILLS, ...priorSkills.filter((item) => !PRIOR_SKILLS.includes(item))];

  async function setPriorSkills(next: string[]) {
    const kept = userNotes.filter((item) => !stripLayer(item).startsWith(PRIOR_PREFIX));
    const updated = next.length > 0 ? [...kept, `${PRIOR_PREFIX}${next.join("、")}`] : kept;
    try {
      await save("user", updated);
    } catch (error) {
      setNote(error instanceof Error ? error.message : tx("保存先验技能失败"));
    }
  }

  const togglePrior = (skill: string) =>
    void setPriorSkills(priorSkills.includes(skill) ? priorSkills.filter((item) => item !== skill) : [...priorSkills, skill]);

  const layerCounts = MEMORY_LAYERS.map((item) => ({
    ...item,
    count: userNotes.filter((entry) => layerOf(entry) === item.id).length,
  }));

  return (
    <section>
      <h2 className={styles.sectionTitle}>{tx("记忆")}</h2>
      <SettingRow title={tx("记忆写入需确认")} desc={tx("开启后，Agent 修改长期笔记前会先进入待确认列表。")}>
        <Toggle checked={approval} label={tx("记忆写入需确认")} onChange={(value) => void saveApproval(value)} />
      </SettingRow>
      <div className={styles.sectionHeaderRow}>
        <p className={styles.sectionLabel}>{tx("五层白盒记忆 USER（5-Layer White-Box Memory）")}</p>
        <span className={styles.capacityTag}>{tx("{used} / {limit} 字", { used: userChars, limit: limits.user })}</span>
      </div>

      <div className={styles.anchorBox}>
        <div className={styles.settingRowInfo}>
          <p className={styles.settingRowTitle}>{tx("Identity · 先验技能锚点（我已掌握的旧知）")}</p>
          <p className={styles.settingRowDesc}>{tx("点选后同步到 USER 的「先验技能：」条目，AI 会用你熟悉的旧知做类比迁移。")}</p>
        </div>
        <div className={styles.domainGrid} role="group" aria-label={tx("先验技能锚点")}>
          {skillOptions.map((skill) => (
            <button
              key={skill}
              type="button"
              aria-pressed={priorSkills.includes(skill)}
              className={cx(styles.domainTag, priorSkills.includes(skill) && styles.domainTagActive)}
              onClick={() => togglePrior(skill)}
            >
              {skill}
            </button>
          ))}
        </div>
        <form
          className={styles.noteComposer}
          onSubmit={(event) => {
            event.preventDefault();
            const skill = customSkill.trim();
            if (!skill) return;
            if (!priorSkills.includes(skill)) togglePrior(skill);
            setCustomSkill("");
          }}
        >
          <input
            className={styles.noteInput}
            value={customSkill}
            maxLength={30}
            aria-label={tx("自定义先验技能")}
            placeholder={tx("自定义已掌握的技能或课程，如「离散数学」")}
            onChange={(event) => setCustomSkill(event.target.value)}
          />
          <button className={styles.rowBtn} type="submit" disabled={!customSkill.trim()}>
            {tx("添加锚点")}
          </button>
        </form>
      </div>

      <div className={styles.layerLegend} aria-label={tx("五层白盒记忆分布")}>
        {layerCounts.map((item) => (
          <span key={item.id} className={cx(styles.layerBadge, styles[`layer_${item.id}`])} title={tx(item.hint)}>
            [{item.tag} {tx(item.label)}] {item.count}
          </span>
        ))}
      </div>
      <UserEntries
        items={userNotes}
        onDelete={(index) =>
          void save("user", userNotes.filter((_, item) => item !== index)).catch((error: unknown) =>
            setNote(error instanceof Error ? error.message : tx("删除失败")),
          )
        }
      />
      <div className={styles.sectionHeaderRow}>
        <p className={styles.sectionLabel}>{tx("环境笔记 MEMORY（路径、资料约定与环境事实）")}</p>
        <span className={styles.capacityTag}>{tx("{used} / {limit} 字", { used: memChars, limit: limits.memory })}</span>
      </div>
      <Entries
        items={memoryNotes}
        onDelete={(index) =>
          void save("memory", memoryNotes.filter((_, item) => item !== index)).catch((error: unknown) =>
            setNote(error instanceof Error ? error.message : tx("删除失败")),
          )
        }
      />
      <form
        className={styles.noteComposer}
        onSubmit={(event) => {
          event.preventDefault();
          const text = draft.trim();
          if (!text) return;
          const layerTag = MEMORY_LAYERS.find((item) => item.id === layer)?.tag ?? "Preference";
          const userText = LAYER_PREFIX_RE.test(text) ? text : `[${layerTag}] ${text}`;
          const items = target === "user" ? [...userNotes, userText] : [...memoryNotes, text];
          void save(target, items)
            .then(() => setDraft(""))
            .catch((error: unknown) => setNote(error instanceof Error ? error.message : tx("保存失败")));
        }}
      >
        <Pills
          label={tx("写入位置")}
          value={target}
          options={[
            { id: "user", label: "USER" },
            { id: "memory", label: "MEMORY" },
          ]}
          onChange={setTarget}
        />
        {target === "user" && (
          <select
            className={styles.layerSelect}
            value={layer}
            aria-label={tx("所属白盒层级")}
            onChange={(event) => setLayer(event.target.value as LayerId)}
          >
            {MEMORY_LAYERS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.tag} · {tx(item.label)}
              </option>
            ))}
          </select>
        )}
        <input
          className={styles.noteInput}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={target === "user" ? tx("新增用户画像条目（将带上所选层级前缀）…") : tx("新增环境事实条目…")}
        />
        <button className={styles.rowBtn} type="submit" disabled={!draft.trim()}>
          {tx("添加")}
        </button>
      </form>
      {note && <p className={styles.emptyLine}>{note}</p>}
    </section>
  );
}

function Entries({ items, onDelete }: { items: string[]; onDelete: (index: number) => void }) {
  const { tx } = useI18n();
  if (!items.length) return <p className={styles.emptyLine}>{tx("还没有条目。")}</p>;
  return (
    <div className={styles.entryList}>
      {items.map((item, index) => (
        <div key={`${item}-${index}`} className={styles.entry}>
          <span>{item}</span>
          <button type="button" className={styles.textBtn} onClick={() => onDelete(index)}>
            {tx("删除")}
          </button>
        </div>
      ))}
    </div>
  );
}

function UserEntries({ items, onDelete }: { items: string[]; onDelete: (index: number) => void }) {
  const { tx } = useI18n();
  if (!items.length) return <p className={styles.emptyLine}>{tx("还没有条目。")}</p>;
  return (
    <div className={styles.entryList}>
      {items.map((item, index) => {
        const id = layerOf(item);
        const meta = MEMORY_LAYERS.find((layer) => layer.id === id) ?? MEMORY_LAYERS[1];
        return (
          <div key={`${item}-${index}`} className={styles.entry}>
            <span className={styles.entryBody}>
              <span className={cx(styles.layerBadge, styles[`layer_${id}`])}>
                [{meta.tag} {tx(meta.label)}]
              </span>
              <span>{stripLayer(item)}</span>
            </span>
            <button type="button" className={styles.textBtn} onClick={() => onDelete(index)}>
              {tx("删除")}
            </button>
          </div>
        );
      })}
    </div>
  );
}

function evolved(memory: LearnerMemory) {
  return memory.kind === "mastery" || memory.status === "improving" || memory.status === "resolved";
}

function ReflectPane() {
  const { tx } = useI18n();
  const [items, setItems] = useState<LearnerMemory[]>([]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void chatApi.listMemories().then(setItems).catch(() => setNote(tx("读不到学习记忆")));
  }, [tx]);

  const toReview = items.filter((m) => m.kind === "misconception" && (m.status === "suspected" || m.status === "needs_review"));
  const improving = items.filter((m) => m.status === "improving");
  const mastered = items.filter((m) => m.kind === "mastery" || m.status === "resolved");
  const evolvedRows = items.filter(evolved);

  return (
    <section>
      <h2 className={styles.sectionTitle}>{tx("复盘 (Reflect)")}</h2>
      <div className={styles.reflectStats}>
        <div className={styles.reflectStatCard}>
          <span className={styles.reflectStatValue}>{toReview.length}</span>
          <span className={styles.reflectStatLabel}>{tx("待巩固卡点")}</span>
        </div>
        <div className={styles.reflectStatCard}>
          <span className={styles.reflectStatValue}>{improving.length}</span>
          <span className={styles.reflectStatLabel}>{tx("改善演进中")}</span>
        </div>
        <div className={styles.reflectStatCard}>
          <span className={styles.reflectStatValue}>{mastered.length}</span>
          <span className={styles.reflectStatLabel}>{tx("已攻克掌握")}</span>
        </div>
      </div>

      <p className={styles.sectionLabel}>{tx("认知蜕变记录（Before vs. After 原话对比）")}</p>
      {evolvedRows.map((memory) => {
        const first = memory.evidence[0]?.quote;
        const latest = memory.evidence[memory.evidence.length - 1]?.quote;
        return (
          <div key={memory.id} className={styles.settingRow}>
            <div className={styles.settingRowInfo}>
              <p className={styles.settingRowTitle}>
                {memory.topic}
                <span className={styles.reflectBadge}>
                  {memory.status === "improving" ? tx("改善中") : tx("已掌握")}
                </span>
              </p>
              <p className={styles.settingRowDesc}>{memory.summary}</p>
              {first && <p className={styles.quote}>{tx("最初原话：“{quote}”", { quote: first })}</p>}
              {latest && latest !== first && <p className={styles.quoteAfter}>{tx("最新原话：“{quote}”", { quote: latest })}</p>}
            </div>
          </div>
        );
      })}
      {!evolvedRows.length && (
        <p className={styles.emptyLine}>
          {tx("当你在对话中攻克曾记录的误区或独立讲清概念时，这里会自动生成前后原话对比。")}
        </p>
      )}

      {toReview.length > 0 && (
        <>
          <p className={styles.sectionLabel}>{tx("当前待巩固盲区")}</p>
          {toReview.map((memory) => (
            <div key={memory.id} className={styles.settingRow}>
              <div className={styles.settingRowInfo}>
                <p className={styles.settingRowTitle}>{memory.topic}</p>
                <p className={styles.settingRowDesc}>{memory.summary}</p>
                {memory.evidence[0]?.quote && <p className={styles.quote}>{tx("原话依据：“{quote}”", { quote: memory.evidence[0].quote })}</p>}
              </div>
            </div>
          ))}
        </>
      )}

      <SettingRow title={tx("同步阶段复盘到用户画像")} desc={tx("将当前待巩固重点与已掌握进展浓缩同步至 USER 画像。")}>
        <button
          className={styles.rowBtn}
          type="button"
          disabled={busy || (evolvedRows.length === 0 && toReview.length === 0)}
          onClick={() => {
            setBusy(true);
            const parts: string[] = [];
            if (toReview.length > 0) {
              parts.push(`待巩固重点：${toReview.slice(0, 3).map((m) => m.topic).join("、")}`);
            }
            if (evolvedRows.length > 0) {
              parts.push(`近期已掌握：${evolvedRows.slice(0, 3).map((m) => m.topic).join("、")}`);
            }
            const line = `阶段复盘：${parts.join("；")}`;
            void chatApi
              .agentNotes()
              .then((notes) => {
                const kept = splitEntries(notes.user).filter((entry) => !entry.startsWith("阶段复盘："));
                return chatApi.saveAgentNote("user", [...kept, line].join("\n§\n"));
              })
              .then(() => setNote(tx("已将阶段复盘同步至 USER 画像")))
              .catch((error: unknown) => setNote(error instanceof Error ? error.message : tx("复盘同步失败")))
              .finally(() => setBusy(false));
          }}
        >
          {tx("同步复盘至画像")}
        </button>
      </SettingRow>
      {note && <p className={styles.emptyLine}>{note}</p>}
    </section>
  );
}

function EffortRow() {
  const { tx } = useI18n();
  const [effort, setEffort] = useState<Effort>("medium");
  useEffect(() => {
    void chatApi.agentSettings().then((settings) => setEffort(settings.reasoningEffort)).catch(() => undefined);
  }, []);
  return (
    <SettingRow title={tx("默认思考深度")} desc={tx("控制模型在每轮回复前的推演深度，与聊天框右下角实时同步。")}>
      <Pills
        label={tx("默认思考深度")}
        value={effort}
        options={EFFORTS.map((item) => ({ ...item, label: tx(item.label) }))}
        onChange={(next) => {
          setEffort(next);
          try {
            localStorage.setItem(EFFORT_STORAGE_KEY, next);
          } catch { /* ignore */ }
          window.dispatchEvent(new CustomEvent<Effort>(EFFORT_EVENT, { detail: next }));
          void chatApi.saveReasoningEffort(next);
        }}
      />
    </SettingRow>
  );
}

function WorkspacePane() {
  const { tx } = useI18n();
  const [workspace, setWorkspace] = useState("");
  const [autoApprove, setAutoApprove] = useState(false);
  const [memoryApproval, setMemoryApproval] = useState(false);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const devMode = useDevMode();
  useEffect(() => {
    void chatApi
      .agentSettings()
      .then((settings) => {
        setWorkspace(settings.workspace);
        setAutoApprove(settings.autoApprove);
        setMemoryApproval(settings.memoryWriteApproval);
      })
      .catch(() => setNote(tx("读不到工作区设置")));
  }, [tx]);
  async function save(next = { workspace, autoApprove, memoryWriteApproval: memoryApproval }) {
    setSaving(true);
    try {
      const saved = await chatApi.saveAgentSettings(next);
      setWorkspace(saved.workspace);
      setAutoApprove(saved.autoApprove);
      setMemoryApproval(saved.memoryWriteApproval);
      setNote(tx("已保存"));
    } catch (error) {
      setNote(error instanceof Error ? error.message : tx("保存失败"));
    } finally {
      setSaving(false);
    }
  }
  return (
    <section>
      <h2 className={styles.sectionTitle}>{tx("开发者工具")}</h2>
      <SettingRow
        title={tx("开发者模式")}
        desc={tx("让 AI 读写你指定文件夹里的文件、执行终端命令，适合做编程项目。学习用不到，默认关闭；关闭时会解除工作区绑定和自动批准。")}
      >
        <Toggle
          checked={devMode || Boolean(workspace) || autoApprove}
          label={tx("开发者模式")}
          onChange={(value) => {
            writeDevMode(value);
            if (!value && (workspace || autoApprove)) {
              setWorkspace("");
              setAutoApprove(false);
              void save({ workspace: "", autoApprove: false, memoryWriteApproval: memoryApproval });
            }
          }}
        />
      </SettingRow>
      {(devMode || Boolean(workspace) || autoApprove) && (<>
      <SettingRow title={tx("信任的工作区文件夹")} desc={tx("Agent 的文件读写工具仅限在此目录内操作。")}>
        <div className={styles.pathRow}>
          <input
            className={styles.pathInput}
            value={workspace}
            onChange={(event) => setWorkspace(event.target.value)}
            placeholder={tx("选择或粘贴本地文件夹路径")}
          />
          <button
            className={styles.rowBtn}
            type="button"
            onClick={() =>
              void window.knowgap?.selectFolder().then((picked) => {
                if (picked) setWorkspace(picked);
              })
            }
          >
            {tx("选择文件夹")}
          </button>
          <button className={styles.rowBtn} type="button" disabled={saving} onClick={() => void save()}>
            {saving ? tx("保存中") : tx("保存")}
          </button>
        </div>
      </SettingRow>
      <SettingRow title={tx("文件写入自动批准")} desc={tx("开启后写文件无需逐次确认；终端命令仍始终需要确认。")}>
        <Toggle
          checked={autoApprove}
          label={tx("文件写入自动批准")}
          onChange={(value) => {
            setAutoApprove(value);
            void save({ workspace, autoApprove: value, memoryWriteApproval: memoryApproval });
          }}
        />
      </SettingRow>
      </>)}
      {note && <p className={styles.emptyLine}>{note}</p>}
    </section>
  );
}

const SKILL_ROLES: Array<{ id: "thread" | "chat" | "main"; label: string }> = [
  { id: "thread", label: "支线执行" },
  { id: "chat", label: "平行对话" },
  { id: "main", label: "空间主线" },
];

const ROLE_LABEL: Record<"thread" | "chat" | "main", string> = {
  thread: "支线注入",
  chat: "平行对话注入",
  main: "主线注入",
};

/** 解析上传的 SKILL.md / .md / .txt 文件（支持可选 YAML frontmatter） */
function parseUploadedSkillFile(fileName: string, rawText: string): {
  name: string;
  role: "thread" | "chat" | "main";
  triggerKeywords: string;
  content: string;
} {
  let name = fileName.replace(/\.(md|txt|markdown)$/i, "").trim() || "自定义技能";
  let role: "thread" | "chat" | "main" = "thread";
  let triggerKeywords = "";
  let body = rawText.trim();

  const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(body);
  if (fmMatch) {
    const frontmatter = fmMatch[1];
    body = fmMatch[2].trim();
    for (const line of frontmatter.split(/\r?\n/)) {
      const idx = line.indexOf(":");
      if (idx < 0) continue;
      const key = line.slice(0, idx).trim().toLowerCase();
      const val = line.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
      if (key === "name" && val) name = val.slice(0, 60);
      if (key === "role" && (val === "thread" || val === "chat" || val === "main")) role = val;
      if ((key === "trigger" || key === "triggers" || key === "keywords") && val) triggerKeywords = val.slice(0, 200);
    }
  }
  return { name, role, triggerKeywords, content: body || rawText.trim() };
}

function SkillsPane() {
  const { tx } = useI18n();
  const fileRef = useRef<HTMLInputElement>(null);
  const [customSkills, setCustomSkills] = useState<
    Array<{ id: string; name: string; role: "thread" | "chat" | "main"; triggerKeywords: string; content: string; enabled: boolean }>
  >([]);
  const [composerOpen, setComposerOpen] = useState(false);
  const [name, setName] = useState("");
  const [role, setRole] = useState<"thread" | "chat" | "main">("thread");
  const [triggerKeywords, setTriggerKeywords] = useState("");
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState("");

  useEffect(() => {
    void chatApi
      .listCustomSkills()
      .then(setCustomSkills)
      .catch(() => setNote(tx("读不到自定义技能列表")));
  }, [tx]);

  const handleFileUpload = async (file: File) => {
    setNote("");
    if (file.size > 512 * 1024) {
      setNote(tx("Skill 文件大小不能超过 512 KB。"));
      return;
    }
    try {
      const text = await file.text();
      const parsed = parseUploadedSkillFile(file.name, text);
      setName(parsed.name);
      setRole(parsed.role);
      setTriggerKeywords(parsed.triggerKeywords);
      setContent(parsed.content);
      setComposerOpen(true);
      setNote(tx("已解析「{name}」，核对挂载角色后点击保存即可生效。", { name: file.name }));
    } catch {
      setNote(tx("读取 Skill 文件失败，请确认文件为 UTF-8 编码。"));
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const handleSaveSkill = async () => {
    if (!name.trim() || !content.trim() || saving) return;
    setSaving(true);
    setNote("");
    try {
      const created = await chatApi.createCustomSkill({
        name: name.trim(),
        role,
        triggerKeywords: triggerKeywords.trim(),
        content: content.trim(),
      });
      setCustomSkills((prev) => [created, ...prev]);
      setComposerOpen(false);
      setName("");
      setTriggerKeywords("");
      setContent("");
      setNote(tx("已添加技能「{name}」，将在对应角色对话中自动注入。", { name: created.name }));
    } catch (error) {
      setNote(error instanceof Error ? error.message : tx("保存技能失败"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section>
      <div className={styles.skillHeadRow}>
        <div>
          <h2 className={styles.sectionTitle}>{tx("技能 (Skills)")}</h2>
          <p className={styles.settingRowDesc}>
            {tx("支持上传 .md / SKILL.md / .txt 技能文件，按角色（支线 / 平行对话 / 主线）自动注入系统提示。")}
          </p>
        </div>
        <div className={styles.skillHeadActions}>
          <input
            ref={fileRef}
            type="file"
            accept=".md,.txt,.markdown"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleFileUpload(file);
            }}
          />
          <button type="button" className={styles.rowBtn} onClick={() => fileRef.current?.click()}>
            <Upload size={13} aria-hidden />
            <span>{tx("上传 Skill 文件")}</span>
          </button>
          <button
            type="button"
            className={styles.rowBtnPrimary}
            onClick={() => {
              setComposerOpen((v) => !v);
              setNote("");
            }}
          >
            <Plus size={13} aria-hidden />
            <span>{composerOpen ? tx("收起表单") : tx("新建技能")}</span>
          </button>
        </div>
      </div>

      {note && <p className={styles.skillNotice}>{note}</p>}

      {composerOpen && (
        <div className={styles.skillEditorCard}>
          <div className={styles.skillEditorGrid}>
            <label className={styles.skillField}>
              <span>{tx("技能名称")}</span>
              <input
                className={styles.noteInput}
                value={name}
                maxLength={60}
                placeholder={tx("例如：费曼反转追问法、考研真题拆解器")}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <div className={styles.skillField}>
              <span>{tx("挂载角色")}</span>
              <Pills label={tx("挂载角色")} value={role} options={SKILL_ROLES.map((item) => ({ ...item, label: tx(item.label) }))} onChange={setRole} />
            </div>
          </div>

          <label className={styles.skillField}>
            <span>{tx("触发关键词（可选，多个词用逗号分隔；留空则在该角色下始终生效）")}</span>
            <input
              className={styles.noteInput}
              value={triggerKeywords}
              maxLength={200}
              placeholder={tx("例如：费曼, 考考我, 挑刺（留空则每次该角色对话均挂载）")}
              onChange={(e) => setTriggerKeywords(e.target.value)}
            />
          </label>

          <label className={styles.skillField}>
            <span>{tx("Skill 指令内容（支持粘贴或通过上方按钮上传 SKILL.md）")}</span>
            <textarea
              className={styles.skillTextarea}
              rows={5}
              maxLength={8000}
              value={content}
              placeholder={tx("编写该 Skill 的具体步骤规范、输出格式与教学策略…")}
              onChange={(e) => setContent(e.target.value)}
            />
          </label>

          <div className={styles.skillEditorActions}>
            <button type="button" className={styles.rowBtn} onClick={() => setComposerOpen(false)}>
              {tx("取消")}
            </button>
            <button
              type="button"
              className={styles.rowBtnPrimary}
              disabled={!name.trim() || !content.trim() || saving}
              onClick={() => void handleSaveSkill()}
            >
              {saving ? tx("保存中…") : tx("保存并启用技能")}
            </button>
          </div>
        </div>
      )}

      <p className={styles.sectionLabel}>{tx("我上传 / 创建的技能 ({count})", { count: customSkills.length })}</p>
      {customSkills.length === 0 ? (
        <p className={styles.emptyLine}>
          {tx("还没有自定义技能。点击右上角「上传 Skill 文件」导入本地 .md 技能包，或点击「新建技能」。")}
        </p>
      ) : (
        customSkills.map((sk) => (
          <div key={sk.id} className={styles.settingRow}>
            <div className={styles.settingRowInfo}>
              <p className={styles.settingRowTitle}>
                {sk.name}
                <span className={styles.skillBadgeInline}>{tx(ROLE_LABEL[sk.role])}</span>
                <span className={styles.skillTriggerTag}>
                  {sk.triggerKeywords ? tx("触发词：{words}", { words: sk.triggerKeywords }) : tx("始终生效")}
                </span>
              </p>
              <p className={styles.skillContentPreview}>{sk.content}</p>
            </div>
            <div className={styles.skillRowControls}>
              <Toggle
                checked={sk.enabled}
                label={tx("启用 {name}", { name: sk.name })}
                onChange={(next) => {
                  setCustomSkills((prev) => prev.map((item) => (item.id === sk.id ? { ...item, enabled: next } : item)));
                  void chatApi.updateCustomSkill(sk.id, { enabled: next }).catch(() => {
                    setCustomSkills((prev) => prev.map((item) => (item.id === sk.id ? { ...item, enabled: !next } : item)));
                  });
                }}
              />
              <button
                type="button"
                className={cx(styles.textBtn, styles.textBtnDanger)}
                aria-label={tx("删除 {name}", { name: sk.name })}
                onClick={() => {
                  void chatApi.deleteCustomSkill(sk.id).then(() => {
                    setCustomSkills((prev) => prev.filter((item) => item.id !== sk.id));
                  });
                }}
              >
                <Trash2 size={13} aria-hidden />
              </button>
            </div>
          </div>
        ))
      )}

      <p className={styles.sectionLabel}>{tx("系统内置核心教学技能")}</p>
      {SKILLS.map((skill) => (
        <SettingRow key={skill.key} title={tx(skill.name)} desc={tx(skill.desc)}>
          <span className={styles.skillBadge}>{tx(skill.role)}</span>
        </SettingRow>
      ))}
    </section>
  );
}

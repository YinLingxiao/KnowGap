"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Brain, Cpu, FolderOpen, Gauge, Monitor, Moon, Plus, Search, Settings, Sliders, Sparkles, Sun, Trash2, Upload, User, X,
} from "lucide-react";
import { chatApi } from "@/lib/chat/api";
import type { LearnerMemory, TokenUsage } from "@/lib/chat/types";
import { updatePassword, type AuthUser } from "@/lib/api/auth";
import type { HealthState } from "@/hooks/useWorkbench";
import {
  applyAppearance, readAppearance, writeAppearance,
  type Appearance, type ChatWidth, type MotionChoice, type TextSize,
} from "@/lib/appearance";
import type { DataSource } from "@/lib/config";
import { cx } from "@/lib/cx";
import { THEME_LABEL, useThemeChoice, type ThemeChoice } from "../ThemeToggle";
import type { AIConfigStatus } from "@/lib/api/ai-config";
import { ModelAccessCard, type ModelSignal } from "./ModelAccessCard";
import { ServiceModelsSection } from "./ServiceModelsSection";
import styles from "./Settings.module.css";

declare global {
  interface Window {
    knowgap?: {
      selectFolder: () => Promise<string | null>;
      setTheme?: (theme: "system" | "light" | "dark") => Promise<string>;
    };
  }
}

export type SettingsTab = "general" | "account" | "usage" | "memory" | "reflect" | "models" | "workspace" | "skills";
type Tab = SettingsTab;
type Effort = "off" | "low" | "medium" | "high";

const EFFORT_STORAGE_KEY = "knowgap.thinking.effort.v1";
const EFFORT_EVENT = "knowgap:thinking-effort";

const GROUPS: Array<{ title: string; items: Array<{ key: Tab; label: string; icon: typeof Settings }> }> = [
  {
    title: "设置",
    items: [
      { key: "general", label: "通用", icon: Settings },
      { key: "account", label: "账号", icon: User },
      { key: "usage", label: "用量", icon: Gauge },
      { key: "memory", label: "记忆", icon: Brain },
      { key: "reflect", label: "复盘 (Reflect)", icon: Sparkles },
    ],
  },
  {
    title: "本机与环境",
    items: [
      { key: "models", label: "模型接入", icon: Cpu },
      { key: "workspace", label: "工作区", icon: FolderOpen },
    ],
  },
  {
    title: "定制",
    items: [{ key: "skills", label: "技能 (Skills)", icon: Sliders }],
  },
];

const THEME_OPTIONS: Array<{ id: ThemeChoice; icon: typeof Monitor }> = [
  { id: "system", icon: Monitor },
  { id: "light", icon: Sun },
  { id: "dark", icon: Moon },
];
const TEXT_SIZES: Array<{ id: TextSize; label: string }> = [
  { id: "small", label: "小" },
  { id: "medium", label: "标准" },
  { id: "large", label: "大" },
];
const WIDTHS: Array<{ id: ChatWidth; label: string }> = [
  { id: "narrow", label: "紧凑" },
  { id: "medium", label: "标准" },
  { id: "wide", label: "宽屏" },
];
const MOTIONS: Array<{ id: MotionChoice; label: string }> = [
  { id: "system", label: "跟随系统" },
  { id: "reduced", label: "减弱" },
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
    role: "Thread 优先注入",
    desc: "一句话交代主线 → 列三步计划 → 构造贯穿全文的最小例子 → 根据用户偏好调整推导顺序",
  },
  {
    key: "socratic_practice",
    name: "启发式带练与诊断",
    role: "Thread 优先注入",
    desc: "结合校验过的练习判据与用户互动偏好，先确认正确部分，再用最小步进提示引导思考",
  },
  {
    key: "study_note_builder",
    name: "结构化图解讲义构建",
    role: "Thread 优先注入",
    desc: "梳理概念框架、编写贯穿示例与对比表，支持在工作区生成结构化文档或代码演练",
  },
  {
    key: "roadmap_planner",
    name: "学习路线规划",
    role: "项目主对话专属",
    desc: "对齐空间目标、基础与截止日，跳过已掌握知识点，针对薄弱点拆解候选 Thread",
  },
];

interface SettingsDialogProps {
  source: DataSource;
  health: HealthState;
  studentId: string;
  modelSignal: ModelSignal;
  onCheckHealth: () => void;
  onConfigChange: (config: AIConfigStatus, saved: boolean) => void;
  onClose: () => void;
  user?: AuthUser;
  initialTab?: SettingsTab;
  onLogout?: () => void;
  onRename?: (name: string) => Promise<void>;
  onRestartOnboarding?: () => Promise<void> | void;
}

export function SettingsDialog({
  source, health, studentId, modelSignal, onCheckHealth, onConfigChange, onClose, user, initialTab = "general", onLogout, onRename, onRestartOnboarding,
}: SettingsDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const [tab, setTab] = useState<Tab>(initialTab);
  const [query, setQuery] = useState("");
  const userId = user?.id || studentId;

  useEffect(() => {
    setTab(initialTab);
  }, [initialTab]);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return GROUPS;
    return GROUPS.map((group) => ({
      ...group,
      items: group.items.filter(
        (item) => item.label.toLowerCase().includes(needle) || group.title.toLowerCase().includes(needle),
      ),
    })).filter((group) => group.items.length > 0);
  }, [query]);

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
        <h2 id="settings-title" className="sr-only">设置</h2>
        <div className={styles.layout}>
          <aside className={styles.sidebar}>
            <label className={styles.searchBox}>
              <Search size={13} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索设置…"
                aria-label="搜索设置"
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
            <button className={styles.closeBtn} onClick={onClose} aria-label="关闭设置">
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
                    onRestart={onRestartOnboarding}
                    onClose={onClose}
                  />
                )}
                {tab === "usage" && <UsagePane />}
                {tab === "memory" && <MemoryPane />}
                {tab === "reflect" && <ReflectPane />}
                {tab === "models" && (
                  <section>
                    <h2 className={styles.sectionTitle}>模型接入与服务模型分工</h2>
                    <EffortRow />
                    <ModelAccessCard
                      plain
                      source={source}
                      health={health}
                      signal={modelSignal}
                      onCheckHealth={onCheckHealth}
                      onConfigChange={onConfigChange}
                    />
                    <div style={{ marginTop: 18 }}>
                      <ServiceModelsSection />
                    </div>
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

function GeneralPane({ userId }: { userId: string }) {
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
      <h2 className={styles.sectionTitle}>通用</h2>
      <p className={styles.sectionLabel}>外观与排版</p>
      <SettingRow title="主题" desc="选择深色、浅色或跟随操作系统。">
        <Pills
          label="主题"
          value={theme}
          options={THEME_OPTIONS.map((item) => ({ ...item, label: THEME_LABEL[item.id] }))}
          onChange={setTheme}
        />
      </SettingRow>
      <SettingRow title="对话字号" desc="调整消息正文与阅读区域的字体大小。">
        <Pills
          label="对话字号"
          value={look.textSize}
          options={TEXT_SIZES}
          onChange={(textSize) => patch({ ...look, textSize })}
        />
      </SettingRow>
      <SettingRow title="对话列宽" desc="调整对话流与底部输入框的最大阅读宽度。">
        <Pills
          label="对话列宽"
          value={look.width}
          options={WIDTHS}
          onChange={(width) => patch({ ...look, width })}
        />
      </SettingRow>
      <SettingRow title="界面动效" desc="减弱下拉框、弹窗与流式响应的过渡动画。">
        <Pills
          label="界面动效"
          value={look.motion}
          options={MOTIONS}
          onChange={(motion) => patch({ ...look, motion })}
        />
      </SettingRow>
    </section>
  );
}

function AccountPane({
  user, studentId, onLogout, onRename, onRestart, onClose,
}: {
  user?: AuthUser;
  studentId: string;
  onLogout?: () => void;
  onRename?: (name: string) => Promise<void>;
  onRestart?: () => Promise<void> | void;
  onClose: () => void;
}) {
  const [name, setName] = useState(user?.displayName || "演示学习者");
  const [curPw, setCurPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [domains, setDomains] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const providerLabel = user?.provider === "email" ? "邮箱账号" : "本机演示身份";

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
      setNote("保存常学领域失败");
    }
  };

  return (
    <section>
      <h2 className={styles.sectionTitle}>个人资料与账户</h2>
      <div className={styles.groupCard}>
        <div className={styles.groupCardHead}>账户信息</div>
        <div className={styles.groupCardBody}>
          <div className={styles.accountHead}>
            <span className={styles.accountAvatar}>{user?.avatarText || name.slice(0, 1) || "学"}</span>
            <div>
              <p className={styles.settingRowTitle}>{user?.displayName || name}</p>
              <p className={styles.settingRowDesc}>{user?.username || studentId} · {providerLabel}</p>
            </div>
          </div>

          <SettingRow title="显示昵称" desc="用于侧栏底部头像与首页问候语。">
            <form
              className={styles.nameForm}
              onSubmit={(event) => {
                event.preventDefault();
                if (!onRename) return;
                setBusy(true);
                void onRename(name)
                  .then(() => setNote("昵称已保存"))
                  .catch((error: unknown) => {
                    setNote(error instanceof Error ? error.message : "保存失败");
                  })
                  .finally(() => setBusy(false));
              }}
            >
              <input value={name} maxLength={30} onChange={(event) => setName(event.target.value)} aria-label="昵称" />
              <button className={styles.rowBtn} type="submit" disabled={busy || !name.trim()}>
                保存
              </button>
            </form>
          </SettingRow>

          {/* 参照 LobeHub 图 4「兴趣/常学领域」多选胶囊墙 */}
          <div className={styles.domainRow}>
            <div className={styles.settingRowInfo}>
              <p className={styles.settingRowTitle}>常学与关注领域</p>
              <p className={styles.settingRowDesc}>点选后自动同步至 USER 画像，AI 举例时会优先贴合你的领域背景。</p>
            </div>
            <div className={styles.domainGrid} role="group" aria-label="常学领域">
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
                    <span>{domain}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {user?.provider === "email" && (
            <SettingRow title="修改密码" desc="输入当前密码与新密码（至少 6 位）。">
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
                      setNote("密码已更新");
                    })
                    .catch((error: unknown) => {
                      setNote(error instanceof Error ? error.message : "密码修改失败");
                    })
                    .finally(() => setBusy(false));
                }}
              >
                <input
                  type="password"
                  value={curPw}
                  placeholder="当前密码"
                  aria-label="当前密码"
                  onChange={(event) => setCurPw(event.target.value)}
                />
                <input
                  type="password"
                  value={newPw}
                  placeholder="新密码（6位+）"
                  aria-label="新密码"
                  onChange={(event) => setNewPw(event.target.value)}
                />
                <button className={styles.rowBtn} type="submit" disabled={busy || !curPw || newPw.length < 6}>
                  更新密码
                </button>
              </form>
            </SettingRow>
          )}

          <SettingRow title="学习画像初识访谈" desc="重新发起三问三答初识对话，校准你的 USER 长期画像。">
            <button className={styles.rowBtn} type="button" onClick={() => void onRestart?.()}>
              重新进行初识访谈
            </button>
          </SettingRow>

          <SettingRow title="退出登录" desc="清除本机登录会话并返回认证界面。">
            <button
              className={cx(styles.rowBtn, styles.textBtnDanger)}
              type="button"
              onClick={() => {
                onClose();
                void onLogout?.();
              }}
            >
              退出当前账号
            </button>
          </SettingRow>
        </div>
      </div>
      {note && <p className={styles.emptyLine}>{note}</p>}
    </section>
  );
}

function UsagePane() {
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
      .catch(() => setNote("读不到用量"));
  }, []);
  return (
    <section>
      <h2 className={styles.sectionTitle}>用量</h2>
      {total && (
        <SettingRow
          title="当前账号总计"
          desc={`共 ${total.requests} 次请求 · 输入 ${total.inputTokens.toLocaleString()} Tokens · 输出 ${total.outputTokens.toLocaleString()} Tokens`}
        >
          <span className={styles.skillMeta}>缓存命中 {(total.cachedTokens ?? 0).toLocaleString()}</span>
        </SettingRow>
      )}
      {spaces.length > 0 && <p className={styles.sectionLabel}>按学习空间拆分</p>}
      {spaces.map((space) => (
        <SettingRow
          key={space.id}
          title={space.name}
          desc={`${space.requests} 次请求 · 输入 ${space.inputTokens.toLocaleString()} · 输出 ${space.outputTokens.toLocaleString()}`}
        >
          <span className={styles.skillMeta}>缓存 {(space.cachedTokens ?? 0).toLocaleString()}</span>
        </SettingRow>
      ))}
      {!total && !note && <p className={styles.emptyLine}>正在读取用量…</p>}
      {note && <p className={styles.emptyLine}>{note}</p>}
      {total && spaces.length === 0 && <p className={styles.emptyLine}>还没有按学习空间拆分的用量。</p>}
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
      .catch(() => setNote("读不到记忆设置"));
    void chatApi
      .agentNotes()
      .then((notes) => {
        setUserNotes(splitEntries(notes.user));
        setMemoryNotes(splitEntries(notes.memory));
        setLimits(notes.limits);
      })
      .catch(() => setNote("读不到画像"));
  }, []);

  async function saveApproval(next: boolean) {
    setApproval(next);
    try {
      await chatApi.saveAgentSettings({ workspace, autoApprove, memoryWriteApproval: next });
    } catch (error) {
      setApproval(!next);
      setNote(error instanceof Error ? error.message : "保存失败");
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
      setNote(error instanceof Error ? error.message : "保存先验技能失败");
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
      <h2 className={styles.sectionTitle}>记忆</h2>
      <SettingRow title="记忆写入需确认" desc="开启后，Agent 修改长期笔记前会先进入待确认列表。">
        <Toggle checked={approval} label="记忆写入需确认" onChange={(value) => void saveApproval(value)} />
      </SettingRow>
      <div className={styles.sectionHeaderRow}>
        <p className={styles.sectionLabel}>五层白盒记忆 USER（5-Layer White-Box Memory）</p>
        <span className={styles.capacityTag}>{userChars} / {limits.user} 字</span>
      </div>

      <div className={styles.anchorBox}>
        <div className={styles.settingRowInfo}>
          <p className={styles.settingRowTitle}>Identity · 先验技能锚点（我已掌握的旧知）</p>
          <p className={styles.settingRowDesc}>点选后同步到 USER 的「先验技能：」条目，AI 会用你熟悉的旧知做类比迁移。</p>
        </div>
        <div className={styles.domainGrid} role="group" aria-label="先验技能锚点">
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
            aria-label="自定义先验技能"
            placeholder="自定义已掌握的技能或课程，如「离散数学」"
            onChange={(event) => setCustomSkill(event.target.value)}
          />
          <button className={styles.rowBtn} type="submit" disabled={!customSkill.trim()}>
            添加锚点
          </button>
        </form>
      </div>

      <div className={styles.layerLegend} aria-label="五层白盒记忆分布">
        {layerCounts.map((item) => (
          <span key={item.id} className={cx(styles.layerBadge, styles[`layer_${item.id}`])} title={item.hint}>
            [{item.tag} {item.label}] {item.count}
          </span>
        ))}
      </div>
      <UserEntries
        items={userNotes}
        onDelete={(index) =>
          void save("user", userNotes.filter((_, item) => item !== index)).catch((error: unknown) =>
            setNote(error instanceof Error ? error.message : "删除失败"),
          )
        }
      />
      <div className={styles.sectionHeaderRow}>
        <p className={styles.sectionLabel}>环境笔记 MEMORY（路径、资料约定与环境事实）</p>
        <span className={styles.capacityTag}>{memChars} / {limits.memory} 字</span>
      </div>
      <Entries
        items={memoryNotes}
        onDelete={(index) =>
          void save("memory", memoryNotes.filter((_, item) => item !== index)).catch((error: unknown) =>
            setNote(error instanceof Error ? error.message : "删除失败"),
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
            .catch((error: unknown) => setNote(error instanceof Error ? error.message : "保存失败"));
        }}
      >
        <Pills
          label="写入位置"
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
            aria-label="所属白盒层级"
            onChange={(event) => setLayer(event.target.value as LayerId)}
          >
            {MEMORY_LAYERS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.tag} · {item.label}
              </option>
            ))}
          </select>
        )}
        <input
          className={styles.noteInput}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={target === "user" ? "新增用户画像条目（将带上所选层级前缀）…" : "新增环境事实条目…"}
        />
        <button className={styles.rowBtn} type="submit" disabled={!draft.trim()}>
          添加
        </button>
      </form>
      {note && <p className={styles.emptyLine}>{note}</p>}
    </section>
  );
}

function Entries({ items, onDelete }: { items: string[]; onDelete: (index: number) => void }) {
  if (!items.length) return <p className={styles.emptyLine}>还没有条目。</p>;
  return (
    <div className={styles.entryList}>
      {items.map((item, index) => (
        <div key={`${item}-${index}`} className={styles.entry}>
          <span>{item}</span>
          <button type="button" className={styles.textBtn} onClick={() => onDelete(index)}>
            删除
          </button>
        </div>
      ))}
    </div>
  );
}

function UserEntries({ items, onDelete }: { items: string[]; onDelete: (index: number) => void }) {
  if (!items.length) return <p className={styles.emptyLine}>还没有条目。</p>;
  return (
    <div className={styles.entryList}>
      {items.map((item, index) => {
        const id = layerOf(item);
        const meta = MEMORY_LAYERS.find((layer) => layer.id === id) ?? MEMORY_LAYERS[1];
        return (
          <div key={`${item}-${index}`} className={styles.entry}>
            <span className={styles.entryBody}>
              <span className={cx(styles.layerBadge, styles[`layer_${id}`])}>
                [{meta.tag} {meta.label}]
              </span>
              <span>{stripLayer(item)}</span>
            </span>
            <button type="button" className={styles.textBtn} onClick={() => onDelete(index)}>
              删除
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
  const [items, setItems] = useState<LearnerMemory[]>([]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void chatApi.listMemories().then(setItems).catch(() => setNote("读不到学习记忆"));
  }, []);

  const toReview = items.filter((m) => m.kind === "misconception" && (m.status === "suspected" || m.status === "needs_review"));
  const improving = items.filter((m) => m.status === "improving");
  const mastered = items.filter((m) => m.kind === "mastery" || m.status === "resolved");
  const evolvedRows = items.filter(evolved);

  return (
    <section>
      <h2 className={styles.sectionTitle}>复盘 (Reflect)</h2>
      <div className={styles.reflectStats}>
        <div className={styles.reflectStatCard}>
          <span className={styles.reflectStatValue}>{toReview.length}</span>
          <span className={styles.reflectStatLabel}>待巩固卡点</span>
        </div>
        <div className={styles.reflectStatCard}>
          <span className={styles.reflectStatValue}>{improving.length}</span>
          <span className={styles.reflectStatLabel}>改善演进中</span>
        </div>
        <div className={styles.reflectStatCard}>
          <span className={styles.reflectStatValue}>{mastered.length}</span>
          <span className={styles.reflectStatLabel}>已攻克掌握</span>
        </div>
      </div>

      <p className={styles.sectionLabel}>认知蜕变记录（Before vs. After 原话对比）</p>
      {evolvedRows.map((memory) => {
        const first = memory.evidence[0]?.quote;
        const latest = memory.evidence[memory.evidence.length - 1]?.quote;
        return (
          <div key={memory.id} className={styles.settingRow}>
            <div className={styles.settingRowInfo}>
              <p className={styles.settingRowTitle}>
                {memory.topic}
                <span className={styles.reflectBadge}>
                  {memory.status === "improving" ? "改善中" : "已掌握"}
                </span>
              </p>
              <p className={styles.settingRowDesc}>{memory.summary}</p>
              {first && <p className={styles.quote}>最初原话：“{first}”</p>}
              {latest && latest !== first && <p className={styles.quoteAfter}>最新原话：“{latest}”</p>}
            </div>
          </div>
        );
      })}
      {!evolvedRows.length && (
        <p className={styles.emptyLine}>
          当你在对话中攻克曾记录的误区或独立讲清概念时，这里会自动生成前后原话对比。
        </p>
      )}

      {toReview.length > 0 && (
        <>
          <p className={styles.sectionLabel}>当前待巩固盲区</p>
          {toReview.map((memory) => (
            <div key={memory.id} className={styles.settingRow}>
              <div className={styles.settingRowInfo}>
                <p className={styles.settingRowTitle}>{memory.topic}</p>
                <p className={styles.settingRowDesc}>{memory.summary}</p>
                {memory.evidence[0]?.quote && <p className={styles.quote}>原话依据：“{memory.evidence[0].quote}”</p>}
              </div>
            </div>
          ))}
        </>
      )}

      <SettingRow title="同步阶段复盘到用户画像" desc="将当前待巩固重点与已掌握进展浓缩同步至 USER 画像。">
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
              .then(() => setNote("已将阶段复盘同步至 USER 画像"))
              .catch((error: unknown) => setNote(error instanceof Error ? error.message : "复盘同步失败"))
              .finally(() => setBusy(false));
          }}
        >
          同步复盘至画像
        </button>
      </SettingRow>
      {note && <p className={styles.emptyLine}>{note}</p>}
    </section>
  );
}

function EffortRow() {
  const [effort, setEffort] = useState<Effort>("medium");
  useEffect(() => {
    void chatApi.agentSettings().then((settings) => setEffort(settings.reasoningEffort)).catch(() => undefined);
  }, []);
  return (
    <SettingRow title="默认思考深度" desc="控制模型在每轮回复前的推演深度，与聊天框右下角实时同步。">
      <Pills
        label="默认思考深度"
        value={effort}
        options={EFFORTS}
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
  const [workspace, setWorkspace] = useState("");
  const [autoApprove, setAutoApprove] = useState(false);
  const [memoryApproval, setMemoryApproval] = useState(false);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    void chatApi
      .agentSettings()
      .then((settings) => {
        setWorkspace(settings.workspace);
        setAutoApprove(settings.autoApprove);
        setMemoryApproval(settings.memoryWriteApproval);
      })
      .catch(() => setNote("读不到工作区设置"));
  }, []);
  async function save(next = { workspace, autoApprove, memoryWriteApproval: memoryApproval }) {
    setSaving(true);
    try {
      const saved = await chatApi.saveAgentSettings(next);
      setWorkspace(saved.workspace);
      setAutoApprove(saved.autoApprove);
      setMemoryApproval(saved.memoryWriteApproval);
      setNote("已保存");
    } catch (error) {
      setNote(error instanceof Error ? error.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }
  return (
    <section>
      <h2 className={styles.sectionTitle}>工作区</h2>
      <SettingRow title="信任的工作区文件夹" desc="Agent 的文件读写工具仅限在此目录内操作。">
        <div className={styles.pathRow}>
          <input
            className={styles.pathInput}
            value={workspace}
            onChange={(event) => setWorkspace(event.target.value)}
            placeholder="选择或粘贴本地文件夹路径"
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
            选择文件夹
          </button>
          <button className={styles.rowBtn} type="button" disabled={saving} onClick={() => void save()}>
            {saving ? "保存中" : "保存"}
          </button>
        </div>
      </SettingRow>
      <SettingRow title="文件写入自动批准" desc="开启后写文件无需逐次确认；终端命令仍始终需要确认。">
        <Toggle
          checked={autoApprove}
          label="文件写入自动批准"
          onChange={(value) => {
            setAutoApprove(value);
            void save({ workspace, autoApprove: value, memoryWriteApproval: memoryApproval });
          }}
        />
      </SettingRow>
      {note && <p className={styles.emptyLine}>{note}</p>}
    </section>
  );
}

const SKILL_ROLES: Array<{ id: "thread" | "chat" | "main"; label: string }> = [
  { id: "thread", label: "Thread 执行" },
  { id: "chat", label: "平行对话" },
  { id: "main", label: "空间主对话" },
];

const ROLE_LABEL: Record<"thread" | "chat" | "main", string> = {
  thread: "Thread 注入",
  chat: "平行对话注入",
  main: "主对话注入",
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
      .catch(() => setNote("读不到自定义技能列表"));
  }, []);

  const handleFileUpload = async (file: File) => {
    setNote("");
    if (file.size > 512 * 1024) {
      setNote("Skill 文件大小不能超过 512 KB。");
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
      setNote(`已解析「${file.name}」，核对挂载角色后点击保存即可生效。`);
    } catch {
      setNote("读取 Skill 文件失败，请确认文件为 UTF-8 编码。");
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
      setNote(`已添加技能「${created.name}」，将在对应角色对话中自动注入。`);
    } catch (error) {
      setNote(error instanceof Error ? error.message : "保存技能失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section>
      <div className={styles.skillHeadRow}>
        <div>
          <h2 className={styles.sectionTitle}>技能 (Skills)</h2>
          <p className={styles.settingRowDesc}>
            支持上传 <code>.md</code> / <code>SKILL.md</code> / <code>.txt</code> 技能文件，按角色（Thread / 平行对话 / 主对话）自动注入系统提示。
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
            <span>上传 Skill 文件</span>
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
            <span>{composerOpen ? "收起表单" : "新建技能"}</span>
          </button>
        </div>
      </div>

      {note && <p className={styles.skillNotice}>{note}</p>}

      {composerOpen && (
        <div className={styles.skillEditorCard}>
          <div className={styles.skillEditorGrid}>
            <label className={styles.skillField}>
              <span>技能名称</span>
              <input
                className={styles.noteInput}
                value={name}
                maxLength={60}
                placeholder="例如：费曼反转追问法、考研真题拆解器"
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <div className={styles.skillField}>
              <span>挂载角色</span>
              <Pills label="挂载角色" value={role} options={SKILL_ROLES} onChange={setRole} />
            </div>
          </div>

          <label className={styles.skillField}>
            <span>触发关键词（可选，多个词用逗号分隔；留空则在该角色下始终生效）</span>
            <input
              className={styles.noteInput}
              value={triggerKeywords}
              maxLength={200}
              placeholder="例如：费曼, 考考我, 挑刺（留空则每次该角色对话均挂载）"
              onChange={(e) => setTriggerKeywords(e.target.value)}
            />
          </label>

          <label className={styles.skillField}>
            <span>Skill 指令内容（支持粘贴或通过上方按钮上传 SKILL.md）</span>
            <textarea
              className={styles.skillTextarea}
              rows={5}
              maxLength={8000}
              value={content}
              placeholder="编写该 Skill 的具体步骤规范、输出格式与教学策略…"
              onChange={(e) => setContent(e.target.value)}
            />
          </label>

          <div className={styles.skillEditorActions}>
            <button type="button" className={styles.rowBtn} onClick={() => setComposerOpen(false)}>
              取消
            </button>
            <button
              type="button"
              className={styles.rowBtnPrimary}
              disabled={!name.trim() || !content.trim() || saving}
              onClick={() => void handleSaveSkill()}
            >
              {saving ? "保存中…" : "保存并启用技能"}
            </button>
          </div>
        </div>
      )}

      <p className={styles.sectionLabel}>我上传 / 创建的技能 ({customSkills.length})</p>
      {customSkills.length === 0 ? (
        <p className={styles.emptyLine}>
          还没有自定义技能。点击右上角「上传 Skill 文件」导入本地 <code>.md</code> 技能包，或点击「新建技能」。
        </p>
      ) : (
        customSkills.map((sk) => (
          <div key={sk.id} className={styles.settingRow}>
            <div className={styles.settingRowInfo}>
              <p className={styles.settingRowTitle}>
                {sk.name}
                <span className={styles.skillBadgeInline}>{ROLE_LABEL[sk.role]}</span>
                <span className={styles.skillTriggerTag}>
                  {sk.triggerKeywords ? `触发词：${sk.triggerKeywords}` : "始终生效"}
                </span>
              </p>
              <p className={styles.skillContentPreview}>{sk.content}</p>
            </div>
            <div className={styles.skillRowControls}>
              <Toggle
                checked={sk.enabled}
                label={`启用 ${sk.name}`}
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
                aria-label={`删除 ${sk.name}`}
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

      <p className={styles.sectionLabel}>系统内置核心教学技能</p>
      {SKILLS.map((skill) => (
        <SettingRow key={skill.key} title={skill.name} desc={skill.desc}>
          <span className={styles.skillBadge}>{skill.role}</span>
        </SettingRow>
      ))}
    </section>
  );
}

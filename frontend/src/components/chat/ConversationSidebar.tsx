"use client";

import {
  useEffect, useLayoutEffect, useMemo, useRef, useState,
  type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent,
} from "react";
import { BrandMark, BrandWordmark } from "@/components/Brand";
import { createPortal } from "react-dom";
import {
  ArrowUpDown, Brain, CalendarCheck, ChevronRight, ChevronUp, CircleHelp, FolderKanban, ListPlus, MoreHorizontal,
  PanelLeftClose, Pencil, Plus, Search, Settings, Trash2, User, X,
} from "lucide-react";
import type { ApiError } from "@/lib/api/errors";
import { useI18n } from "@/components/LanguageProvider";
import { errorText } from "@/lib/i18n/errors";
import { COMPOSE_TASK_EVENT } from "@/lib/agenda/types";
import type { ConversationSummary, Subject } from "@/lib/chat/types";
import { cx } from "@/lib/cx";
import type { SettingsTab } from "../settings/SettingsDialog";
import { THEME_ICON, THEME_KEY, useThemeChoice, type ThemeChoice } from "../ThemeToggle";
import { UpdateIndicator } from "../desktop/UpdateIndicator";
import styles from "./ConversationSidebar.module.css";

export type SidebarMode = "chat" | "learn";
type SortField = "updated" | "created";
type ChatGroup = "today" | "yesterday" | "week" | "month" | "earlier";

const GROUP_ORDER: ChatGroup[] = ["today", "yesterday", "week", "month", "earlier"];
const GROUP_MESSAGE = {
  today: "sidebar.groupToday",
  yesterday: "sidebar.groupYesterday",
  week: "sidebar.groupWeek",
  month: "sidebar.groupMonth",
  earlier: "sidebar.groupEarlier",
} as const;

interface SidebarProps {
  conversations: ConversationSummary[];
  subjects: Subject[];
  loading: boolean;
  error: ApiError | null;
  /** 当前打开的对话；显示 Subject 页或资料页时为 null */
  activeId: string | null;
  activeSubjectId: string | null;
  generatingIds: string[];
  modelIssue: boolean;
  materialsActive: boolean;
  onNewChat: () => void;
  onOpen: (id: string) => void;
  onOpenSubject: (id: string) => void;
  onOpenSpaces: () => void;
  onCreateSpace: () => void;
  spacesActive: boolean;
  onOpenAgenda: () => void;
  agendaActive: boolean;
  onRename: (id: string, title: string) => Promise<boolean>;
  onDelete: (id: string) => Promise<boolean>;
  onRetry: () => void;
  onOpenMemory: () => void;
  onOpenMaterials: () => void;
  onOpenSettings: (tab?: SettingsTab) => void;
  onOpenHelp: () => void;
  helpOpen: boolean;
  onCollapse: () => void;
  displayName?: string;
  avatarText?: string;
  /** 当前侧栏模式；缺省按对话模式渲染 */
  mode?: SidebarMode;
  onModeChange?: (mode: SidebarMode) => void;
  /** 学习列表里打开支线：优先进入空间并选中该支线，保持学习模式 */
  onOpenThread?: (threadId: string, subjectId: string) => void;
}

function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** 分组按会话最近更新时间、本地日历日判断；未来时间与无法解析的时间各自兜底 */
function chatGroupOf(iso: string, now: Date): ChatGroup {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "earlier";
  const today = startOfDay(now);
  const yesterday = startOfDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  if (time >= today) return "today";
  if (time >= yesterday) return "yesterday";
  const mondayOffset = (now.getDay() + 6) % 7;
  const weekStart = startOfDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - mondayOffset));
  if (time >= weekStart) return "week";
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  if (time >= monthStart) return "month";
  return "earlier";
}

function ModeSwitch({ mode, onModeChange }: {
  mode: SidebarMode;
  onModeChange?: (mode: SidebarMode) => void;
}) {
  const { t } = useI18n();
  const modes: SidebarMode[] = ["chat", "learn"];
  return (
    <div className={styles.segmented} role="tablist" aria-label={t("sidebar.modeAria")}>
      {modes.map((value) => (
        <button
          key={value}
          type="button"
          role="tab"
          data-mode={value}
          aria-selected={mode === value}
          className={cx(styles.segment, mode === value && styles.segmentActive)}
          onClick={() => onModeChange?.(value)}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            const next: SidebarMode = value === "chat" ? "learn" : "chat";
            onModeChange?.(next);
            const parent = event.currentTarget.parentElement;
            window.requestAnimationFrame(() => {
              parent?.querySelector<HTMLButtonElement>(`[data-mode="${next}"]`)?.focus();
            });
          }}
        >
          {t(value === "chat" ? "sidebar.modeChat" : "sidebar.modeLearn")}
        </button>
      ))}
    </div>
  );
}

function ConversationItem({
  conversation, active, generating, attention, variant = "chat", onOpen, onRename, onDelete,
}: {
  conversation: ConversationSummary;
  active: boolean;
  generating: boolean;
  attention?: boolean;
  variant?: "chat" | "thread";
  onOpen: () => void;
  onRename: (title: string) => Promise<boolean>;
  onDelete: () => Promise<boolean>;
}) {
  const { t } = useI18n();
  const [mode, setMode] = useState<"view" | "menu" | "rename" | "confirm">("view");
  const [title, setTitle] = useState(conversation.title);
  const [working, setWorking] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLLIElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [menuPosition, setMenuPosition] = useState({ left: 0, top: 0 });
  const variantClass = variant === "thread" ? styles.threadItem : undefined;

  useLayoutEffect(() => {
    if (mode !== "menu" || !triggerRef.current || !popupRef.current) return;
    const anchor = triggerRef.current.getBoundingClientRect();
    const { offsetWidth: width, offsetHeight: height } = popupRef.current;
    setMenuPosition({
      left: Math.max(8, Math.min(anchor.right - width, window.innerWidth - width - 8)),
      top: Math.max(8, Math.min(
        anchor.bottom + height + 4 <= window.innerHeight - 8
          ? anchor.bottom + 4 : anchor.top - height - 4,
        window.innerHeight - height - 8,
      )),
    });
    popupRef.current.querySelector<HTMLButtonElement>("button")?.focus();
  }, [mode]);

  useEffect(() => {
    if (mode === "rename") inputRef.current?.select();
    if (mode !== "menu") return;
    const close = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node) &&
          !popupRef.current?.contains(event.target as Node)) setMode("view");
    };
    const dismiss = () => setMode("view");
    const onScroll = (event: Event) => {
      if (!popupRef.current?.contains(event.target as Node)) dismiss();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        dismiss();
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", dismiss);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", dismiss);
    };
  }, [mode]);

  const save = async () => {
    const next = title.trim();
    if (!next || next === conversation.title) {
      setMode("view");
      return;
    }
    setWorking(true);
    if (await onRename(next.slice(0, 60))) setMode("view");
    setWorking(false);
  };

  if (mode === "rename") {
    return (
      <li className={cx(styles.item, variantClass, styles.editing)}>
        <input
          ref={inputRef}
          className={styles.renameInput}
          value={title}
          maxLength={60}
          disabled={working}
          aria-label={t("sidebar.conversationTitle")}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={() => void save()}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) void save();
            if (event.key === "Escape") {
              setTitle(conversation.title);
              setMode("view");
            }
          }}
        />
      </li>
    );
  }

  if (mode === "confirm") {
    return (
      <li className={cx(styles.item, variantClass, styles.panel)} role="group" aria-label={t("sidebar.confirmDeleteAria")}>
        <span className={styles.panelTitle}>{t("sidebar.confirmDeleteTitle", { title: conversation.title })}</span>
        <div className={styles.confirmActions}>
          <button onClick={() => setMode("view")} disabled={working}>{t("common.cancel")}</button>
          <button
            className={styles.danger}
            disabled={working}
            onClick={async () => {
              setWorking(true);
              if (!(await onDelete())) {
                setWorking(false);
                setMode("view");
              }
            }}
          >
            {t("common.delete")}
          </button>
        </div>
      </li>
    );
  }

  return (
    <li ref={menuRef} className={cx(styles.item, variantClass, active && styles.active, mode === "menu" && styles.menuOpen)}>
      <button className={styles.itemButton} onClick={onOpen} aria-current={active ? "page" : undefined} title={conversation.title}>
        <span className={styles.itemTitle}>{conversation.title}</span>
        {generating ? (
          <span className={styles.genDot} role="img" aria-label={t("sidebar.generating")} />
        ) : attention ? (
          <span className={styles.attentionDot} role="img" aria-label={t("sidebar.threadAttention")} />
        ) : null}
      </button>
      <button
        ref={triggerRef}
        className={styles.more}
        onClick={() => setMode(mode === "menu" ? "view" : "menu")}
        aria-label={t("sidebar.moreActions", { title: conversation.title })}
        aria-haspopup="menu"
        aria-expanded={mode === "menu"}
      >
        <MoreHorizontal size={15} />
      </button>
      {mode === "menu" && createPortal(
        <div ref={popupRef} className={styles.menu} role="menu" style={menuPosition}>
          <button role="menuitem" onClick={() => { setTitle(conversation.title); setMode("rename"); }}>
            <Pencil size={13} aria-hidden />
            {t("sidebar.rename")}
          </button>
          <button role="menuitem" className={styles.menuDanger} onClick={() => setMode("confirm")}>
            <Trash2 size={13} aria-hidden />
            {t("common.delete")}
          </button>
        </div>,
        document.body,
      )}
    </li>
  );
}

function SpaceSection({
  subject, threads, expanded, active, activeId, generatingIds, onToggle, onOpen, onOpenThread, onRename, onDelete,
}: {
  subject: Subject;
  threads: ConversationSummary[];
  expanded: boolean;
  active: boolean;
  activeId: string | null;
  generatingIds: string[];
  onToggle: () => void;
  onOpen: () => void;
  onOpenThread: (thread: ConversationSummary) => void;
  onRename: (id: string, title: string) => Promise<boolean>;
  onDelete: (id: string) => Promise<boolean>;
}) {
  const { t } = useI18n();
  const needsYou = threads.some((thread) => thread.executionStatus === "waiting" || thread.executionStatus === "failed");
  const expandLabel = t(expanded ? "sidebar.collapseSpace" : "sidebar.expandSpace", { name: subject.name });
  return (
    <li className={styles.spaceItem}>
      <div className={cx(styles.spaceRow, active && styles.spaceRowActive)}>
        <button
          type="button"
          className={styles.spaceButton}
          onClick={onOpen}
          aria-current={active ? "page" : undefined}
          title={subject.name}
        >
          <span className={styles.spaceRing} style={{ color: subject.color }} aria-hidden />
          <span className={styles.itemTitle}>{subject.name}</span>
          {needsYou && <span className={styles.attentionDot} role="img" aria-label={t("sidebar.threadAttention")} />}
        </button>
        <button
          type="button"
          className={styles.expandButton}
          onClick={onToggle}
          aria-expanded={expanded}
          aria-label={expandLabel}
          title={expandLabel}
        >
          <ChevronRight size={13} className={cx(styles.expandChevron, expanded && styles.expandChevronOpen)} aria-hidden />
        </button>
      </div>
      {expanded && (
        threads.length === 0 ? (
          <p className={styles.empty}>{t("sidebar.noThreads")}</p>
        ) : (
          <ul className={cx(styles.list, styles.threadList)}>
            {threads.map((thread) => (
              <ConversationItem
                key={thread.id}
                conversation={thread}
                variant="thread"
                active={thread.id === activeId}
                generating={generatingIds.includes(thread.id)}
                attention={thread.threadStatus !== "resolved"}
                onOpen={() => onOpenThread(thread)}
                onRename={(title) => onRename(thread.id, title)}
                onDelete={() => onDelete(thread.id)}
              />
            ))}
          </ul>
        )
      )}
    </li>
  );
}

function AvatarMenu({
  displayName, avatarText, modelIssue, helpOpen, onOpenHelp, onOpenSettings,
}: {
  displayName?: string;
  avatarText?: string;
  modelIssue: boolean;
  helpOpen: boolean;
  onOpenHelp: () => void;
  onOpenSettings: (tab?: SettingsTab) => void;
}) {
  const { t } = useI18n();
  const [themeChoice, setThemeChoice] = useThemeChoice();
  const [open, setOpen] = useState(false);
  const [systemDark, setSystemDark] = useState(true);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    setSystemDark(media.matches);
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current || !menuRef.current) return;
    const anchor = triggerRef.current.getBoundingClientRect();
    const { offsetWidth: width, offsetHeight: height } = menuRef.current;
    const above = anchor.top - height - 6;
    setPosition({
      left: Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8)),
      top: above >= 8 ? above : Math.min(anchor.bottom + 6, window.innerHeight - height - 8),
    });
    menuRef.current.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node) && !triggerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const dismiss = () => setOpen(false);
    const onScroll = (event: Event) => {
      if (!menuRef.current?.contains(event.target as Node)) dismiss();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("mousedown", closeOutside);
    document.addEventListener("keydown", onKey);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", dismiss);
    return () => {
      document.removeEventListener("mousedown", closeOutside);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", dismiss);
    };
  }, [open]);

  const moveFocus = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    if (!items.length) return;
    const current = items.findIndex((item) => item === document.activeElement);
    let index = current;
    if (event.key === "ArrowDown") index = current < items.length - 1 ? current + 1 : 0;
    else if (event.key === "ArrowUp") index = current <= 0 ? items.length - 1 : current - 1;
    else if (event.key === "Home") index = 0;
    else if (event.key === "End") index = items.length - 1;
    else return;
    event.preventDefault();
    items[index]?.focus();
  };

  const effectiveDark = themeChoice === "dark" || (themeChoice === "system" && systemDark);
  const nextTheme: ThemeChoice = effectiveDark ? "light" : "dark";
  const ThemeIcon = THEME_ICON[themeChoice];

  const toggleTheme = (event: ReactMouseEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setThemeChoice(nextTheme, { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
    setOpen(false);
  };

  // 帮助面板锚定在常驻触发器上；打开菜单前先收起帮助，避免两层浮层重叠。
  const toggleMenu = () => {
    if (!open && helpOpen) onOpenHelp();
    setOpen((value) => !value);
  };

  return (
    <>
      <button
        ref={triggerRef}
        id="help-trigger"
        type="button"
        className={cx(styles.profileTrigger, open && styles.profileTriggerOpen)}
        onClick={toggleMenu}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("sidebar.accountMenuAria")}
        title={t("sidebar.accountMenuAria")}
      >
        <span className={styles.avatarWrap}>
          <span className={styles.avatar} aria-hidden>{avatarText || t("app.avatar")}</span>
          {modelIssue && <span className={styles.alertDot} aria-hidden />}
        </span>
        <span className={styles.userName}>
          {displayName || t("app.demoLearner")}
          <small className={styles.userPlan}> · {t("app.localVersion")}</small>
        </span>
        <ChevronUp size={13} className={cx(styles.profileChevron, open && styles.profileChevronOpen)} aria-hidden />
      </button>
      {open && createPortal(
        <div
          ref={menuRef}
          className={cx(styles.menu, styles.avatarMenu)}
          role="menu"
          aria-label={t("sidebar.accountMenuAria")}
          style={position}
          onKeyDown={moveFocus}
        >
          <div className={styles.avatarMenuHead} role="presentation">
            <span className={styles.avatar} aria-hidden>{avatarText || t("app.avatar")}</span>
            <span className={styles.avatarMenuName}>
              {displayName || t("app.demoLearner")}
              <small className={styles.userPlan}> · {t("app.localVersion")}</small>
            </span>
          </div>
          <button role="menuitem" onClick={() => { onOpenSettings("account"); setOpen(false); }}>
            <User size={13} aria-hidden />
            <span className={styles.menuLabel}>{t("sidebar.account")}</span>
          </button>
          <button role="menuitem" onClick={() => { onOpenHelp(); setOpen(false); }}>
            <CircleHelp size={13} aria-hidden />
            <span className={styles.menuLabel}>{t("sidebar.help")}</span>
          </button>
          <button
            role="menuitem"
            onClick={() => { onOpenSettings(); setOpen(false); }}
            title={modelIssue ? t("sidebar.modelAttention") : undefined}
          >
            <Settings size={13} aria-hidden />
            <span className={styles.menuLabel}>{t("sidebar.settings")}</span>
            {modelIssue && <span className={styles.menuAlertDot} aria-hidden />}
          </button>
          <button role="menuitem" onClick={toggleTheme}>
            <ThemeIcon size={13} aria-hidden />
            <span className={styles.menuLabel}>{t("sidebar.theme")}</span>
            <span className={styles.menuMeta}>{t(THEME_KEY[themeChoice])}</span>
          </button>
        </div>,
        document.body,
      )}
    </>
  );
}

export function ConversationSidebar(props: SidebarProps) {
  const { lang, t } = useI18n();
  const { conversations, subjects, loading, error, activeId, generatingIds } = props;
  const mode = props.mode ?? "chat";
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [sort, setSort] = useState<SortField>("updated");
  const [expandedSpaces, setExpandedSpaces] = useState<string[]>([]);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const keyword = query.trim().toLowerCase();
  const searchActive = searchOpen || Boolean(query);

  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  useEffect(() => {
    const id = props.activeSubjectId;
    if (!id) return;
    setExpandedSpaces((prev) => (prev.includes(id) ? prev : [...prev, id]));
  }, [props.activeSubjectId]);

  const chatItems = useMemo(
    () => conversations
      .filter((item) => (item.kind ?? "chat") === "chat" && !item.subjectId)
      .filter((item) => item.title !== "初识引导 · 定制你的学习画像")
      .filter((item) => !keyword || item.title.toLowerCase().includes(keyword))
      .slice()
      .sort((a, b) => (sort === "created"
        ? b.createdAt.localeCompare(a.createdAt)
        : b.updatedAt.localeCompare(a.updatedAt))),
    [conversations, keyword, sort],
  );

  const chatGroups = useMemo(() => {
    if (!chatItems.length) return [] as Array<{ key: ChatGroup; items: ConversationSummary[] }>;
    const now = new Date();
    const buckets = new Map<ChatGroup, ConversationSummary[]>();
    for (const item of chatItems) {
      const key = chatGroupOf(item.updatedAt, now);
      const bucket = buckets.get(key);
      if (bucket) bucket.push(item);
      else buckets.set(key, [item]);
    }
    return GROUP_ORDER
      .filter((key) => buckets.has(key))
      .map((key) => ({ key, items: buckets.get(key) ?? [] }));
  }, [chatItems]);

  const learnSpaces = useMemo(() => {
    const sorted = [...subjects].sort(
      (a, b) => (b.progress?.lastStudiedAt ?? b.updatedAt).localeCompare(a.progress?.lastStudiedAt ?? a.updatedAt),
    );
    const threadsBySpace = new Map<string, ConversationSummary[]>();
    for (const conversation of conversations) {
      if ((conversation.kind ?? "chat") !== "thread" || !conversation.subjectId) continue;
      const bucket = threadsBySpace.get(conversation.subjectId);
      if (bucket) bucket.push(conversation);
      else threadsBySpace.set(conversation.subjectId, [conversation]);
    }
    for (const bucket of threadsBySpace.values()) {
      bucket.sort((a, b) => {
        const aResolved = a.threadStatus === "resolved" ? 1 : 0;
        const bResolved = b.threadStatus === "resolved" ? 1 : 0;
        return aResolved - bResolved || b.updatedAt.localeCompare(a.updatedAt);
      });
    }

    const entries: Array<{ subject: Subject; threads: ConversationSummary[]; forceOpen: boolean }> = [];
    for (const subject of sorted) {
      const allThreads = threadsBySpace.get(subject.id) ?? [];
      const nameMatch = !keyword || subject.name.toLowerCase().includes(keyword);
      const matchingThreads = keyword
        ? allThreads.filter((thread) => thread.title.toLowerCase().includes(keyword))
        : allThreads;
      if (keyword && !nameMatch && matchingThreads.length === 0) continue;
      entries.push({
        subject,
        threads: keyword && !nameMatch ? matchingThreads : allThreads,
        forceOpen: Boolean(keyword),
      });
    }
    return entries;
  }, [conversations, keyword, subjects]);

  const toggleSpace = (id: string) => {
    setExpandedSpaces((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]));
  };

  const openThread = (thread: ConversationSummary) => {
    if (props.onOpenThread && thread.subjectId) props.onOpenThread(thread.id, thread.subjectId);
    else props.onOpen(thread.id);
  };

  const errorBlock = error && conversations.length === 0 ? (
    <div className={styles.listError}>
      <p>{errorText(error, t, lang)}</p>
      <button onClick={props.onRetry}>{t("common.reload")}</button>
    </div>
  ) : null;
  const loadingBlock = loading && conversations.length === 0 && subjects.length === 0
    ? <p className={styles.empty}>{t("sidebar.loading")}</p>
    : null;

  return (
    <nav className={styles.sidebar} aria-label={t("sidebar.label")}>
      <header className={styles.brand}>
        <BrandMark size={24} />
        <span className={styles.brandName}><BrandWordmark width={112} /></span>
        <button className={styles.iconButton} onClick={props.onCollapse} aria-label={t("sidebar.collapse")} title={t("sidebar.collapse")}>
          <PanelLeftClose size={16} />
        </button>
      </header>

      <div className={styles.topArea}>
        <ModeSwitch mode={mode} onModeChange={props.onModeChange} />
        <div className={styles.quickRow} role="group" aria-label={t("sidebar.quickActions")}>
          <button
            type="button"
            className={cx(styles.quickButton, props.agendaActive && styles.quickButtonActive)}
            onClick={props.onOpenAgenda}
            aria-label={t("sidebar.agenda")}
            title={t("sidebar.agenda")}
          >
            <CalendarCheck size={16} aria-hidden />
          </button>
          <button
            type="button"
            className={cx(styles.quickButton, props.materialsActive && styles.quickButtonActive)}
            onClick={props.onOpenMaterials}
            aria-label={t("sidebar.materials")}
            title={t("sidebar.materials")}
          >
            <FolderKanban size={16} aria-hidden />
          </button>
          <button
            type="button"
            className={styles.quickButton}
            onClick={props.onOpenMemory}
            aria-label={t("sidebar.memories")}
            title={t("sidebar.memories")}
          >
            <Brain size={16} aria-hidden />
          </button>
          <button
            type="button"
            className={cx(styles.quickButton, searchActive && styles.quickButtonActive)}
            onClick={() => {
              if (searchActive) {
                setQuery("");
                setSearchOpen(false);
              } else {
                setSearchOpen(true);
              }
            }}
            aria-label={t("sidebar.search")}
            aria-expanded={searchActive}
            title={t("sidebar.search")}
          >
            <Search size={16} aria-hidden />
          </button>
          <button
            type="button"
            className={styles.quickButton}
            onClick={() => window.dispatchEvent(new CustomEvent(COMPOSE_TASK_EVENT))}
            aria-label={t("sidebar.addTask")}
            title={t("sidebar.addTask")}
          >
            <ListPlus size={16} aria-hidden />
          </button>
        </div>
        {searchActive && (
          <div className={cx(styles.searchField, styles.searchFieldActive)}>
            <Search size={14} aria-hidden />
            <input
              ref={searchInputRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onBlur={() => {
                if (!query) setSearchOpen(false);
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setQuery("");
                  setSearchOpen(false);
                }
              }}
              placeholder={t("sidebar.searchPlaceholder")}
              aria-label={t("sidebar.searchAria")}
            />
            {query && (
              <button type="button" className={styles.searchClear} onClick={() => setQuery("")} aria-label={t("sidebar.clearSearch")}>
                <X size={12} />
              </button>
            )}
          </div>
        )}
      </div>

      <div className={styles.scroll}>
        <div className={styles.listFade} key={mode}>
          {mode === "chat" ? (
            errorBlock ?? loadingBlock ?? (
              chatItems.length === 0 ? (
                <p className={styles.empty}>{keyword ? t("sidebar.noMatches") : t("sidebar.empty")}</p>
              ) : (
                <>
                  <div className={styles.listToolbar}>
                    <button
                      type="button"
                      className={styles.sortButton}
                      onClick={() => setSort((value) => (value === "updated" ? "created" : "updated"))}
                      aria-label={t("sidebar.sortAria", {
                        sort: t(sort === "updated" ? "sidebar.sortRecent" : "sidebar.sortCreated"),
                      })}
                    >
                      <ArrowUpDown size={12} aria-hidden />
                      <span>{t(sort === "updated" ? "sidebar.sortRecent" : "sidebar.sortCreated")}</span>
                    </button>
                  </div>
                  {chatGroups.map((group) => (
                    <section key={group.key} className={styles.group} aria-labelledby={`sidebar-chat-${group.key}`}>
                      <h3 id={`sidebar-chat-${group.key}`} className={styles.groupHead}>{t(GROUP_MESSAGE[group.key])}</h3>
                      <ul className={styles.list}>
                        {group.items.map((conversation) => (
                          <ConversationItem
                            key={conversation.id}
                            conversation={conversation}
                            active={conversation.id === activeId}
                            generating={generatingIds.includes(conversation.id)}
                            onOpen={() => props.onOpen(conversation.id)}
                            onRename={(title) => props.onRename(conversation.id, title)}
                            onDelete={() => props.onDelete(conversation.id)}
                          />
                        ))}
                      </ul>
                    </section>
                  ))}
                </>
              )
            )
          ) : (
            errorBlock ?? loadingBlock ?? (
              learnSpaces.length === 0 ? (
                <p className={styles.empty}>{keyword ? t("sidebar.noMatches") : t("sidebar.noSpaces")}</p>
              ) : (
                <ul className={cx(styles.list, styles.spaceList)}>
                  {learnSpaces.map(({ subject, threads, forceOpen }) => (
                    <SpaceSection
                      key={subject.id}
                      subject={subject}
                      threads={threads}
                      expanded={forceOpen || expandedSpaces.includes(subject.id)}
                      active={props.activeSubjectId === subject.id}
                      activeId={activeId}
                      generatingIds={generatingIds}
                      onToggle={() => toggleSpace(subject.id)}
                      onOpen={() => props.onOpenSubject(subject.id)}
                      onOpenThread={openThread}
                      onRename={props.onRename}
                      onDelete={props.onDelete}
                    />
                  ))}
                </ul>
              )
            )
          )}
        </div>
      </div>

      <div className={styles.actionBar}>
        <button
          type="button"
          className={styles.primaryAction}
          onClick={mode === "learn" ? props.onCreateSpace : props.onNewChat}
        >
          <Plus size={15} aria-hidden />
          <span>{t(mode === "learn" ? "sidebar.newSpace" : "sidebar.newChat")}</span>
        </button>
      </div>

      <footer className={styles.footer}>
        <AvatarMenu
          displayName={props.displayName}
          avatarText={props.avatarText}
          modelIssue={props.modelIssue}
          helpOpen={props.helpOpen}
          onOpenHelp={props.onOpenHelp}
          onOpenSettings={props.onOpenSettings}
        />
        <UpdateIndicator onOpenSettings={props.onOpenSettings} />
      </footer>
    </nav>
  );
}
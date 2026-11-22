"use client";

import {
  useEffect, useLayoutEffect, useMemo, useRef, useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { BrandMark, BrandWordmark } from "@/components/Brand";
import { createPortal } from "react-dom";
import {
  ArrowUpDown, BookOpen, Brain, CalendarCheck, Check, ChevronUp, CircleHelp, FolderKanban, LayoutGrid,
  MessageCircle, MoreHorizontal, PanelLeftClose, PenLine, Pencil, Plus, Search, Settings, Trash2, User, X,
} from "lucide-react";
import type { ApiError } from "@/lib/api/errors";
import { useI18n } from "@/components/LanguageProvider";
import { errorText } from "@/lib/i18n/errors";
import type { ConversationSummary, Subject } from "@/lib/chat/types";
import { cx } from "@/lib/cx";
import type { SettingsTab } from "../settings/SettingsDialog";
import { ThemeToggle } from "../ThemeToggle";
import { UpdateIndicator } from "../desktop/UpdateIndicator";
import { SpaceIcon } from "./SpaceIcon";
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
  avatarUrl?: string;
  /** 当前侧栏模式；缺省按对话模式渲染 */
  mode?: SidebarMode;
  onModeChange?: (mode: SidebarMode) => void;
}

type IsoDate = string | null | undefined;
type Translate = ReturnType<typeof useI18n>["t"];

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function timestampOf(value: IsoDate) {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function compareDatesDesc(a: IsoDate, b: IsoDate) {
  const aTime = timestampOf(a);
  const bTime = timestampOf(b);
  if (aTime === null) return bTime === null ? 0 : 1;
  if (bTime === null) return -1;
  return bTime - aTime;
}

function chatSortTime(item: ConversationSummary, sort: SortField): IsoDate {
  return sort === "created" ? item.createdAt : item.updatedAt;
}

function spaceSortTime(subject: Subject, sort: SortField): IsoDate {
  return sort === "created" ? subject.createdAt : subject.progress?.lastStudiedAt ?? subject.updatedAt;
}

function calendarDayOf(date: Date) {
  return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS);
}

function formatRelativeTime(value: IsoDate, now: Date, t: Translate) {
  const time = timestampOf(value);
  if (time === null) return "";
  const diff = now.getTime() - time;
  if (diff < HOUR_MS) return t("sidebar.timeJustNow");
  const calendarDays = calendarDayOf(now) - calendarDayOf(new Date(time));
  if (calendarDays === 0) {
    const hours = Math.max(1, Math.floor(diff / HOUR_MS));
    return hours === 1 ? t("sidebar.timeHour") : t("sidebar.timeHours", { count: hours });
  }
  if (calendarDays === 1) return t("sidebar.timeYesterday");
  if (diff < 7 * DAY_MS) {
    return calendarDays === 1 ? t("sidebar.timeDay") : t("sidebar.timeDays", { count: calendarDays });
  }
  const weeks = Math.floor(diff / (7 * DAY_MS));
  return weeks === 1 ? t("sidebar.timeWeek") : t("sidebar.timeWeeks", { count: weeks });
}

function chatGroupOf(iso: IsoDate, now: Date): ChatGroup {
  const time = timestampOf(iso);
  if (time === null) return "earlier";
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
      {modes.map((value) => {
        const Icon = value === "chat" ? MessageCircle : BookOpen;
        return (
          <button
            key={value}
            type="button"
            role="tab"
            data-mode={value}
            aria-selected={mode === value}
            className={cx(styles.segment, mode === value && styles.segmentActive)}
            onClick={() => {
              if (value !== mode) onModeChange?.(value);
            }}
            onKeyDown={(event) => {
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
              event.preventDefault();
              const next: SidebarMode = value === "chat" ? "learn" : "chat";
              if (next !== mode) onModeChange?.(next);
              const parent = event.currentTarget.parentElement;
              window.requestAnimationFrame(() => {
                parent?.querySelector<HTMLButtonElement>(`[data-mode="${next}"]`)?.focus();
              });
            }}
          >
            <Icon size={14} aria-hidden />
            <span>{t(value === "chat" ? "sidebar.modeChat" : "sidebar.modeLearn")}</span>
          </button>
        );
      })}
    </div>
  );
}

function ConversationItem({
  conversation, active, generating, relativeTime, onOpen, onRename, onDelete,
}: {
  conversation: ConversationSummary;
  active: boolean;
  generating: boolean;
  relativeTime: string;
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
      <li className={cx(styles.item, styles.editing)}>
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
      <li className={cx(styles.item, styles.panel)} role="group" aria-label={t("sidebar.confirmDeleteAria")}>
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
    <li ref={menuRef} className={cx(styles.item, active && styles.active, mode === "menu" && styles.menuOpen)}>
      <button type="button" className={styles.itemButton} onClick={onOpen} aria-current={active ? "page" : undefined} title={conversation.title}>
        <span className={styles.itemTitle}>{conversation.title}</span>
        {generating && <span className={styles.genDot} role="img" aria-label={t("sidebar.generating")} />}
      </button>
      <div className={styles.itemEnd}>
        <span className={styles.relativeTime}>{relativeTime}</span>
        <button
          type="button"
          ref={triggerRef}
          className={styles.more}
          onClick={() => setMode(mode === "menu" ? "view" : "menu")}
          aria-label={t("sidebar.moreActions", { title: conversation.title })}
          aria-haspopup="menu"
          aria-expanded={mode === "menu"}
        >
          <MoreHorizontal size={15} />
        </button>
      </div>
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

function SpaceListItem({ subject, active, attention, relativeTime, onOpen }: {
  subject: Subject;
  active: boolean;
  attention: boolean;
  relativeTime: string;
  onOpen: () => void;
}) {
  const { t } = useI18n();
  return (
    <li className={cx(styles.spaceRow, active && styles.spaceRowActive)}>
      <button
        type="button"
        className={styles.spaceButton}
        onClick={onOpen}
        aria-current={active ? "page" : undefined}
        title={subject.name}
      >
        <span className={styles.spaceIcon} style={{ color: subject.color }} aria-hidden>
          <SpaceIcon name={subject.icon} size={14} />
        </span>
        <span className={styles.itemTitle}>{subject.name}</span>
        <span className={styles.spaceMeta}>
          {attention && <span className={styles.attentionDot} role="img" aria-label={t("sidebar.threadAttention")} />}
          {relativeTime && <span className={styles.relativeTime}>{relativeTime}</span>}
        </span>
      </button>
    </li>
  );
}

function SortMenu({ sort, onSelect }: {
  sort: SortField;
  onSelect: (sort: SortField) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const options: SortField[] = ["updated", "created"];

  useLayoutEffect(() => {
    if (!open || !triggerRef.current || !menuRef.current) return;
    const anchor = triggerRef.current.getBoundingClientRect();
    const { offsetWidth: width, offsetHeight: height } = menuRef.current;
    setPosition({
      left: Math.max(8, Math.min(anchor.right - width, window.innerWidth - width - 8)),
      top: Math.max(8, Math.min(
        anchor.bottom + height + 4 <= window.innerHeight - 8
          ? anchor.bottom + 4 : anchor.top - height - 4,
        window.innerHeight - height - 8,
      )),
    });
    const current = menuRef.current.querySelector<HTMLButtonElement>('[aria-checked="true"]');
    (current ?? menuRef.current.querySelector<HTMLButtonElement>("button"))?.focus();
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
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? []);
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

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        className={styles.listTool}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown") return;
          event.preventDefault();
          setOpen(true);
        }}
        aria-label={t("sidebar.sortMenuAria")}
        aria-haspopup="menu"
        aria-expanded={open}
        title={t("sidebar.sortAria", { sort: t(sort === "updated" ? "sidebar.sortRecent" : "sidebar.sortCreated") })}
      >
        <ArrowUpDown size={13} aria-hidden />
      </button>
      {open && createPortal(
        <div
          ref={menuRef}
          className={cx(styles.menu, styles.sortMenu)}
          role="menu"
          aria-label={t("sidebar.sortMenuAria")}
          style={position}
          onKeyDown={moveFocus}
        >
          {options.map((value) => (
            <button
              key={value}
              type="button"
              role="menuitemradio"
              aria-checked={sort === value}
              onClick={() => {
                onSelect(value);
                setOpen(false);
                triggerRef.current?.focus();
              }}
            >
              <span className={styles.sortOptionCheck} aria-hidden>
                {sort === value && <Check size={13} />}
              </span>
              <span>{t(value === "updated" ? "sidebar.sortRecent" : "sidebar.sortCreated")}</span>
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}

function AvatarMenu({
  displayName, avatarText, avatarUrl, modelIssue, helpOpen, onOpenHelp, onOpenSettings,
}: {
  displayName?: string;
  avatarText?: string;
  avatarUrl?: string;
  modelIssue: boolean;
  helpOpen: boolean;
  onOpenHelp: () => void;
  onOpenSettings: (tab?: SettingsTab) => void;
}) {
  const { t } = useI18n();
  // 默认演示档案的称呼/头像跟随界面语言；用户自己改过名字时保留原名。
  const defaultProfile = !displayName || displayName === "学习者";
  const shownName = defaultProfile ? t("app.demoLearner") : displayName;
  const shownAvatar = defaultProfile ? t("app.avatar") : avatarText;
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0, width: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<number | null>(null);

  const clearCloseTimer = () => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  };

  // 给退场动画留出时间再卸载；animationend 会提前收尾，定时器只做兜底。
  const finishClose = () => {
    clearCloseTimer();
    setOpen(false);
    setClosing(false);
  };

  const closeMenu = (restoreFocus = false) => {
    if (closing) return;
    setClosing(true);
    if (restoreFocus) triggerRef.current?.focus();
    clearCloseTimer();
    closeTimerRef.current = window.setTimeout(finishClose, 200);
  };

  const openMenu = () => {
    clearCloseTimer();
    setClosing(false);
    if (helpOpen) onOpenHelp();
    setOpen(true);
  };

  const closeRef = useRef(closeMenu);
  closeRef.current = closeMenu;

  useEffect(() => () => {
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
  }, []);


  useLayoutEffect(() => {
    if (!open || !triggerRef.current || !menuRef.current) return;
    const anchor = triggerRef.current.getBoundingClientRect();
    const { offsetHeight: height } = menuRef.current;
    const width = Math.min(anchor.width, window.innerWidth - 16);
    const above = anchor.top - height - 6;
    setPosition({
      left: Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8)),
      top: above >= 8 ? above : Math.min(anchor.bottom + 6, window.innerHeight - height - 8),
      width,
    });
    menuRef.current.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node) && !triggerRef.current?.contains(event.target as Node)) {
        closeRef.current();
      }
    };
    const dismiss = () => closeRef.current();
    const onScroll = (event: Event) => {
      if (!menuRef.current?.contains(event.target as Node)) dismiss();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      closeRef.current(true);
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


  const expanded = open && !closing;

  const [avatarFailed, setAvatarFailed] = useState(false);
  useEffect(() => { setAvatarFailed(false); }, [avatarUrl]);
  const showImage = Boolean(avatarUrl && !avatarFailed);
  const avatarNode = showImage ? (
    <span className={cx(styles.avatar, styles.avatarPhoto)} aria-hidden>
      {/* eslint-disable-next-line @next/next/no-img-element -- local backend avatar URL */}
      <img src={avatarUrl} alt="" onError={() => setAvatarFailed(true)} />
    </span>
  ) : (
    <span className={styles.avatar} aria-hidden>{shownAvatar || t("app.avatar")}</span>
  );

  return (
    <>
      <button
        ref={triggerRef}
        id="help-trigger"
        type="button"
        className={cx(styles.profileTrigger, open && styles.profileTriggerOpen)}
        onClick={() => {
          if (open && !closing) closeMenu();
          else openMenu();
        }}
        aria-haspopup="menu"
        aria-expanded={expanded}
        aria-label={t("sidebar.accountMenuAria")}
        title={t("sidebar.accountMenuAria")}
      >
        <span className={styles.avatarWrap}>
          {avatarNode}
          {modelIssue && <span className={styles.alertDot} aria-hidden />}
        </span>
        <span className={styles.userName}>
          {shownName || t("app.demoLearner")}
          <small className={styles.userPlan}> · {t("app.localVersion")}</small>
        </span>
        <ChevronUp size={13} className={cx(styles.profileChevron, expanded && styles.profileChevronOpen)} aria-hidden />
      </button>
      {open && createPortal(
        <div
          ref={menuRef}
          className={cx(styles.menu, styles.avatarMenu, closing && styles.avatarMenuClosing)}
          role="menu"
          aria-label={t("sidebar.accountMenuAria")}
          aria-hidden={closing || undefined}
          inert={closing || undefined}
          style={position}
          onKeyDown={moveFocus}
          onAnimationEnd={(event) => {
            if (event.target === event.currentTarget && closing) finishClose();
          }}
        >
          <div className={styles.avatarMenuHead} role="presentation">
            {avatarNode}
            <span className={styles.avatarMenuName}>
              {shownName || t("app.demoLearner")}
              <small className={styles.userPlan}> · {t("app.localVersion")}</small>
            </span>
          </div>
          <button role="menuitem" onClick={() => { onOpenSettings("account"); closeMenu(); }}>
            <User size={13} aria-hidden />
            <span className={styles.menuLabel}>{t("sidebar.account")}</span>
          </button>
          <button role="menuitem" onClick={() => { onOpenHelp(); closeMenu(); }}>
            <CircleHelp size={13} aria-hidden />
            <span className={styles.menuLabel}>{t("sidebar.help")}</span>
          </button>
          <button
            role="menuitem"
            onClick={() => { onOpenSettings(); closeMenu(); }}
            title={modelIssue ? t("sidebar.modelAttention") : undefined}
          >
            <Settings size={13} aria-hidden />
            <span className={styles.menuLabel}>{t("sidebar.settings")}</span>
            {modelIssue && <span className={styles.menuAlertDot} aria-hidden />}
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
  const [now, setNow] = useState(() => new Date());
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchTriggerRef = useRef<HTMLButtonElement>(null);
  const keyword = query.trim().toLowerCase();
  const searchActive = searchOpen || Boolean(query);

  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const chatItems = useMemo(
    () => conversations
      .filter((item) => (item.kind ?? "chat") === "chat" && !item.subjectId)
      .filter((item) => !keyword || item.title.toLowerCase().includes(keyword))
      .slice()
      .sort((a, b) => compareDatesDesc(chatSortTime(a, sort), chatSortTime(b, sort))),
    [conversations, keyword, sort],
  );

  const chatGroups = useMemo(() => {
    if (!chatItems.length) return [] as Array<{ key: ChatGroup; items: ConversationSummary[] }>;
    const buckets = new Map<ChatGroup, ConversationSummary[]>();
    for (const item of chatItems) {
      const key = chatGroupOf(chatSortTime(item, sort), now);
      const bucket = buckets.get(key);
      if (bucket) bucket.push(item);
      else buckets.set(key, [item]);
    }
    return GROUP_ORDER
      .filter((key) => buckets.has(key))
      .map((key) => ({ key, items: buckets.get(key) ?? [] }));
  }, [chatItems, now, sort]);

  const attentionSpaces = useMemo(() => {
    const ids = new Set<string>();
    for (const conversation of conversations) {
      if ((conversation.kind ?? "chat") !== "thread" || !conversation.subjectId) continue;
      if (conversation.threadStatus === "resolved") continue;
      if (conversation.executionStatus === "waiting" || conversation.executionStatus === "failed") {
        ids.add(conversation.subjectId);
      }
    }
    return ids;
  }, [conversations]);

  const learnSpaces = useMemo(
    () => subjects
      .filter((subject) => !keyword || subject.name.toLowerCase().includes(keyword))
      .slice()
      .sort((a, b) => compareDatesDesc(spaceSortTime(a, sort), spaceSortTime(b, sort))),
    [keyword, sort, subjects],
  );

  const showError = Boolean(error && conversations.length === 0);
  const showLoading = !showError && loading && conversations.length === 0 && subjects.length === 0;
  const visibleCount = showError || showLoading ? 0 : mode === "chat" ? chatItems.length : learnSpaces.length;
  const errorBlock = showError && error ? (
    <div className={styles.listError}>
      <p>{errorText(error, t, lang)}</p>
      <button onClick={props.onRetry}>{t("common.reload")}</button>
    </div>
  ) : null;
  const loadingBlock = showLoading ? <p className={styles.empty}>{t("sidebar.loading")}</p> : null;

  return (
    <nav className={styles.sidebar} aria-label={t("sidebar.label")}>
      <header className={styles.brand}>
        <BrandMark size={24} />
        <span className={styles.brandName}><BrandWordmark width={112} /></span>
        <UpdateIndicator busy={generatingIds.length > 0} />
        <button className={styles.iconButton} onClick={props.onCollapse} aria-label={t("sidebar.collapse")} title={t("sidebar.collapse")}>
          <PanelLeftClose size={16} />
        </button>
      </header>

      <div className={styles.topArea}>
        <ModeSwitch mode={mode} onModeChange={props.onModeChange} />
        {mode === "learn" && (
          <div className={styles.learningShortcuts}>

            <button
              type="button"
              className={cx(styles.navRow, props.spacesActive && styles.navRowActive)}
              onClick={props.onOpenSpaces}
              aria-current={props.spacesActive ? "page" : undefined}
            >
              <LayoutGrid size={15} aria-hidden />
              <span>{t("sidebar.allSpaces")}</span>
            </button>
          </div>
        )}
        <section className={styles.workspace} aria-label={t("sidebar.workspace")}>
          <h2 className={styles.sectionTitle}>{t("sidebar.workspace")}</h2>
          <div className={styles.workspaceList}>
            <button
              type="button"
              className={cx(styles.navRow, props.agendaActive && styles.navRowActive)}
              onClick={props.onOpenAgenda}
              aria-current={props.agendaActive ? "page" : undefined}
            >
              <CalendarCheck size={15} aria-hidden />
              <span>{t("sidebar.agenda")}</span>
            </button>
            <button
              type="button"
              className={cx(styles.navRow, props.materialsActive && styles.navRowActive)}
              onClick={props.onOpenMaterials}
              aria-current={props.materialsActive ? "page" : undefined}
            >
              <FolderKanban size={15} aria-hidden />
              <span>{t("sidebar.workspaceMaterials")}</span>
            </button>
            <button type="button" className={styles.navRow} onClick={props.onOpenMemory}>
              <Brain size={15} aria-hidden />
              <span>{t("sidebar.workspaceMemories")}</span>
            </button>
          </div>
        </section>
      </div>

      <div className={styles.scroll}>
        <div className={styles.listFade} key={mode}>
          <div className={styles.listHeader}>
            <h2 className={styles.listTitle}>
              <span>{t(mode === "chat" ? "sidebar.chatListTitle" : "sidebar.spaceListTitle")}</span>
              <span className={styles.listCount}>{visibleCount}</span>
            </h2>
            <div className={styles.listTools}>
              <SortMenu sort={sort} onSelect={setSort} />
              <button
                type="button"
                ref={searchTriggerRef}
                className={cx(styles.listTool, searchActive && styles.listToolActive)}
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
                <Search size={13} aria-hidden />
              </button>
            </div>
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
                    event.preventDefault();
                    setQuery("");
                    setSearchOpen(false);
                    searchTriggerRef.current?.focus();
                  }
                }}
                placeholder={t(mode === "chat" ? "sidebar.searchChatPlaceholder" : "sidebar.searchSpacePlaceholder")}
                aria-label={t("sidebar.searchAria")}
              />
              {query && (
                <button type="button" className={styles.searchClear} onClick={() => setQuery("")} aria-label={t("sidebar.clearSearch")}>
                  <X size={12} />
                </button>
              )}
            </div>
          )}
          {errorBlock ?? loadingBlock ?? (mode === "chat" ? (
            chatItems.length === 0 ? (
              <p className={styles.empty}>{keyword ? t("sidebar.noMatches") : t("sidebar.empty")}</p>
            ) : (
              chatGroups.map((group) => (
                <section key={group.key} className={styles.group} aria-labelledby={`sidebar-chat-${group.key}`}>
                  <h3 id={`sidebar-chat-${group.key}`} className={styles.groupHead}>{t(GROUP_MESSAGE[group.key])}</h3>
                  <ul className={styles.list}>
                    {group.items.map((conversation) => (
                      <ConversationItem
                        key={conversation.id}
                        conversation={conversation}
                        active={conversation.id === activeId}
                        generating={generatingIds.includes(conversation.id)}
                        relativeTime={formatRelativeTime(chatSortTime(conversation, sort), now, t)}
                        onOpen={() => props.onOpen(conversation.id)}
                        onRename={(title) => props.onRename(conversation.id, title)}
                        onDelete={() => props.onDelete(conversation.id)}
                      />
                    ))}
                  </ul>
                </section>
              ))
            )
          ) : (
            learnSpaces.length === 0 ? (
              <p className={styles.empty}>{keyword ? t("sidebar.noMatches") : t("sidebar.noSpaces")}</p>
            ) : (
              <ul className={cx(styles.list, styles.spaceList)}>
                {learnSpaces.map((subject) => (
                  <SpaceListItem
                    key={subject.id}
                    subject={subject}
                    active={props.activeSubjectId === subject.id}
                    attention={attentionSpaces.has(subject.id)}
                    relativeTime={formatRelativeTime(spaceSortTime(subject, sort), now, t)}
                    onOpen={() => props.onOpenSubject(subject.id)}
                  />
                ))}
              </ul>
            )
          ))}
        </div>
      </div>

      <div className={styles.actionBar}>
        <button
          type="button"
          className={styles.primaryAction}
          onClick={mode === "learn" ? props.onCreateSpace : props.onNewChat}
        >
          {mode === "learn" ? <Plus size={15} aria-hidden /> : <PenLine size={15} aria-hidden />}
          <span>{t(mode === "learn" ? "sidebar.newSpace" : "sidebar.newChat")}</span>
        </button>
      </div>

      <footer className={styles.footer}>
        <AvatarMenu
          displayName={props.displayName}
          avatarText={props.avatarText}
          avatarUrl={props.avatarUrl}
          modelIssue={props.modelIssue}
          helpOpen={props.helpOpen}
          onOpenHelp={props.onOpenHelp}
          onOpenSettings={props.onOpenSettings}
        />
        <ThemeToggle />
      </footer>
    </nav>
  );
}
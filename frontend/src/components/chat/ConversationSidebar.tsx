"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Image from "next/image";
import {
  Brain, CalendarCheck, ChevronRight, FolderKanban, Loader, MoreHorizontal, PanelLeftClose, Pencil, Plus,
  Search, Settings, SlidersHorizontal, Trash2, X,
} from "lucide-react";
import type { ApiError } from "@/lib/api/errors";
import type { ConversationSummary, Subject } from "@/lib/chat/types";
import { cx } from "@/lib/cx";
import { ThemeToggle } from "../ThemeToggle";
import styles from "./ConversationSidebar.module.css";

interface SidebarProps {
  conversations: ConversationSummary[];
  subjects: Subject[];
  loading: boolean;
  error: ApiError | null;
  /** 当前打开的对话；显示 Subject 页或资料页时为 null */
  activeId: string | null;
  activeSubjectId: string | null;
  generatingIds: string[];
  memoryCount: number;
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
  /** 侧栏里的专注计时入口，由 ChatApp 注入 */
  focusSlot?: ReactNode;
  onRename: (id: string, title: string) => Promise<boolean>;
  onDelete: (id: string) => Promise<boolean>;
  onRetry: () => void;
  onOpenMemory: () => void;
  onOpenMaterials: () => void;
  onOpenSettings: () => void;
  onCollapse: () => void;
  displayName?: string;
  avatarText?: string;
}

function SectionHeader({
  label, count, open, onToggle,
}: {
  label: string;
  count: number;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div className={styles.sectionHead}>
      <button type="button" className={styles.sectionToggle} onClick={onToggle} aria-expanded={open}>
        <ChevronRight size={12} className={cx(styles.chevron, open && styles.chevronOpen)} aria-hidden />
        <span className={styles.sectionLabel}>{label}</span>
        <span className={styles.count}>{count}</span>
      </button>
    </div>
  );
}

function ConversationItem({
  conversation, active, generating, onOpen, onRename, onDelete,
}: {
  conversation: ConversationSummary;
  active: boolean;
  generating: boolean;
  onOpen: () => void;
  onRename: (title: string) => Promise<boolean>;
  onDelete: () => Promise<boolean>;
}) {
  const [mode, setMode] = useState<"view" | "menu" | "rename" | "confirm">("view");
  const [title, setTitle] = useState(conversation.title);
  const [working, setWorking] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLLIElement>(null);

  useEffect(() => {
    if (mode === "rename") inputRef.current?.select();
    if (mode !== "menu") return;
    const close = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMode("view");
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
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
          aria-label="对话标题"
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
      <li className={cx(styles.item, styles.panel)} role="group" aria-label="确认删除对话">
        <span className={styles.panelTitle}>删除「{conversation.title}」？</span>
        <div className={styles.confirmActions}>
          <button onClick={() => setMode("view")} disabled={working}>取消</button>
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
            删除
          </button>
        </div>
      </li>
    );
  }

  return (
    <li ref={menuRef} className={cx(styles.item, active && styles.active, mode === "menu" && styles.menuOpen)}>
      <button className={styles.itemButton} onClick={onOpen} aria-current={active ? "page" : undefined} title={conversation.title}>
        <span className={styles.itemTitle}>{conversation.title}</span>
        {generating && <Loader size={12} className={styles.spin} aria-label="正在生成" />}
      </button>
      <button
        className={styles.more}
        onClick={() => setMode(mode === "menu" ? "view" : "menu")}
        aria-label={`「${conversation.title}」的更多操作`}
        aria-haspopup="menu"
        aria-expanded={mode === "menu"}
      >
        <MoreHorizontal size={15} />
      </button>
      {mode === "menu" && (
        <div className={styles.menu} role="menu">
          <button role="menuitem" onClick={() => { setTitle(conversation.title); setMode("rename"); }}>
            <Pencil size={13} aria-hidden />
            重命名
          </button>
          <button role="menuitem" className={styles.menuDanger} onClick={() => setMode("confirm")}>
            <Trash2 size={13} aria-hidden />
            删除
          </button>
        </div>
      )}
    </li>
  );
}

export function ConversationSidebar(props: SidebarProps) {
  const { conversations, subjects, loading, error, activeId, generatingIds } = props;
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [spacesOpen, setSpacesOpen] = useState(true);
  const [recentsOpen, setRecentsOpen] = useState(true);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const keyword = query.trim().toLowerCase();
  const searchActive = searchOpen || Boolean(query);

  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  const filteredSpaces = useMemo(
    () => subjects
      .filter((subject) => !keyword || subject.name.toLowerCase().includes(keyword))
      .sort((a, b) => (b.progress?.lastStudiedAt ?? b.updatedAt).localeCompare(a.progress?.lastStudiedAt ?? a.updatedAt)),
    [keyword, subjects],
  );

  const recentChats = useMemo(
    () => conversations
      .filter((item) => (item.kind ?? "chat") === "chat" && !item.subjectId)
      .filter((item) => item.title !== "初识引导 · 定制你的学习画像")
      .filter((item) => !keyword || item.title.toLowerCase().includes(keyword))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [conversations, keyword],
  );

  const isNewChatActive = !activeId && !props.activeSubjectId && !props.spacesActive && !props.materialsActive && !props.agendaActive;

  return (
    <nav className={styles.sidebar} aria-label="对话">
      <header className={styles.brand}>
        <Image src="/brand/knowgap-logo-v1.png" alt="KnowGap" width={22} height={22} className={styles.logo} />
        <span className={styles.brandName} aria-hidden>KnowGap</span>
        <button className={styles.iconButton} onClick={props.onCollapse} aria-label="收起侧栏" title="收起侧栏">
          <PanelLeftClose size={16} />
        </button>
      </header>

      <div className={styles.nav}>
        {searchActive ? (
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
              placeholder="筛选对话与空间…"
              aria-label="搜索对话和学习空间"
            />
            {query && (
              <button type="button" className={styles.searchClear} onClick={() => setQuery("")} aria-label="清空搜索">
                <X size={12} />
              </button>
            )}
          </div>
        ) : (
          <button
            type="button"
            className={styles.searchField}
            onClick={() => setSearchOpen(true)}
            aria-label="搜索对话和学习空间"
          >
            <Search size={14} aria-hidden />
            <span>搜索</span>
          </button>
        )}

        <button
          className={cx(styles.navItem, isNewChatActive && styles.navActive)}
          onClick={props.onNewChat}
        >
          <Plus size={15} aria-hidden />
          <span>新对话</span>
        </button>
        <div className={styles.navRow}>
          <button className={cx(styles.navItem, props.spacesActive && styles.navActive)} onClick={props.onOpenSpaces}>
            <FolderKanban size={15} aria-hidden />
            <span>学习空间</span>
          </button>
          <button className={styles.sectionAction} onClick={props.onCreateSpace} aria-label="新建学习空间" title="新建学习空间">
            <Plus size={14} />
          </button>
        </div>
        <button className={cx(styles.navItem, props.agendaActive && styles.navActive)} onClick={props.onOpenAgenda}>
          <CalendarCheck size={15} aria-hidden />
          <span>日程</span>
        </button>
        {props.focusSlot}
        <button className={styles.navItem} onClick={props.onOpenMemory}>
          <Brain size={15} aria-hidden />
          <span>学习记忆</span>
          {props.memoryCount > 0 && <span className={styles.count}>{props.memoryCount}</span>}
        </button>
        <button className={cx(styles.navItem, props.materialsActive && styles.navActive)} onClick={props.onOpenMaterials}>
          <SlidersHorizontal size={15} aria-hidden />
          <span>通用资料</span>
        </button>
      </div>

      <div className={styles.scroll}>
        {filteredSpaces.length > 0 && (
          <div className={styles.group}>
            <SectionHeader
              label="学习空间"
              count={filteredSpaces.length}
              open={spacesOpen}
              onToggle={() => setSpacesOpen((value) => !value)}
            />
            {spacesOpen && (
              <ul className={styles.list} data-stagger>
                {filteredSpaces.map((subject) => (
                  <li key={subject.id} className={cx(styles.item, props.activeSubjectId === subject.id && styles.active)}>
                    <button
                      className={styles.itemButton}
                      onClick={() => props.onOpenSubject(subject.id)}
                      aria-current={props.activeSubjectId === subject.id ? "page" : undefined}
                    >
                      <span className={styles.spaceRing} style={{ color: subject.color }} aria-hidden />
                      <span className={styles.itemTitle}>{subject.name}</span>
                      {subject.progress.openThreads > 0 && (
                        <span
                          className={styles.count}
                          title={`${subject.progress.openThreads} 个 Thread 进行中`}
                        >
                          {subject.progress.openThreads}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className={styles.group}>
          <SectionHeader
            label="最近对话"
            count={recentChats.length}
            open={recentsOpen}
            onToggle={() => setRecentsOpen((value) => !value)}
          />
          {recentsOpen && (
            error && conversations.length === 0 ? (
              <div className={styles.listError}>
                <p>{error.message}</p>
                <button onClick={props.onRetry}>重新加载</button>
              </div>
            ) : loading && conversations.length === 0 && subjects.length === 0 ? (
              <p className={styles.empty}>正在加载…</p>
            ) : recentChats.length === 0 ? (
              <p className={styles.empty}>{keyword ? "没有匹配的内容。" : "开始的新对话会显示在这里。"}</p>
            ) : (
              <ul className={styles.list} data-stagger>
                {recentChats.map((conversation) => (
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
            )
          )}
        </div>
      </div>

      <footer className={styles.footer}>
        <span className={styles.avatar} aria-hidden>{props.avatarText || "学"}</span>
        <span className={styles.userName}>
          {props.displayName || "演示学习者"}
          <small className={styles.userPlan}> · 本地版</small>
        </span>
        <button className={styles.iconButton} onClick={props.onOpenSettings} aria-label="设置" title="设置">
          <Settings size={15} />
          {props.modelIssue && <span className={styles.alertDot} />}
        </button>
        <ThemeToggle />
      </footer>
    </nav>
  );
}

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import {
  Brain, FolderOpen, Loader, MoreHorizontal, PanelLeftClose, Pencil, Plus,
  Search, Settings, SquarePen, Trash2,
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
  onRename: (id: string, title: string) => Promise<boolean>;
  onDelete: (id: string) => Promise<boolean>;
  onRetry: () => void;
  onOpenMemory: () => void;
  onOpenMaterials: () => void;
  onOpenSettings: () => void;
  onCollapse: () => void;
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
  const keyword = query.trim().toLowerCase();
  const recent = useMemo(() => {
    const chats = conversations
      .filter((item) => (item.kind ?? "chat") === "chat" && !item.subjectId)
      .filter((item) => !keyword || item.title.toLowerCase().includes(keyword))
      .map((item) => ({ type: "chat" as const, at: item.updatedAt, conversation: item }));
    const spaces = subjects
      .filter((subject) => !keyword || subject.name.toLowerCase().includes(keyword))
      .map((subject) => ({ type: "space" as const, at: subject.progress?.lastStudiedAt ?? subject.updatedAt, subject }));
    return [...chats, ...spaces].sort((a, b) => b.at.localeCompare(a.at));
  }, [conversations, keyword, subjects]);

  return (
    <nav className={styles.sidebar} aria-label="对话">
      <header className={styles.brand}>
        <Image src="/brand/knowgap-logo-v1.png" alt="" width={20} height={20} className={styles.logo} />
        <span className={styles.brandName}>知隙</span>
        <button className={styles.iconButton} onClick={props.onCollapse} aria-label="收起侧栏" title="收起侧栏">
          <PanelLeftClose size={16} />
        </button>
      </header>

      <label className={styles.search}>
        <Search size={14} aria-hidden />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Escape") setQuery(""); }}
          placeholder="搜索"
          aria-label="搜索对话和学习空间"
        />
      </label>

      <div className={styles.nav}>
        <button className={cx(styles.navItem, styles.newChat)} onClick={props.onNewChat}>
          <SquarePen size={15} aria-hidden />
          新对话
        </button>
        <div className={styles.navRow}>
          <button className={cx(styles.navItem, props.spacesActive && styles.navActive)} onClick={props.onOpenSpaces}>
            <span className={styles.spaceMark} aria-hidden />
            学习空间
          </button>
          <button className={styles.sectionAction} onClick={props.onCreateSpace} aria-label="新建学习空间" title="新建学习空间">
            <Plus size={14} />
          </button>
        </div>
        <button className={styles.navItem} onClick={props.onOpenMemory}>
          <Brain size={15} aria-hidden />
          学习记忆
          {props.memoryCount > 0 && <span className={styles.count}>{props.memoryCount}</span>}
        </button>
        <button className={cx(styles.navItem, props.materialsActive && styles.navActive)} onClick={props.onOpenMaterials}>
          <FolderOpen size={15} aria-hidden />
          通用资料
        </button>
      </div>

      <div className={styles.scroll}>
        <p className={styles.section}>最近</p>
        {error && conversations.length === 0 ? (
          <div className={styles.listError}>
            <p>{error.message}</p>
            <button onClick={props.onRetry}>重新加载</button>
          </div>
        ) : loading && conversations.length === 0 && subjects.length === 0 ? (
          <p className={styles.section}>正在加载…</p>
        ) : recent.length === 0 ? (
          <p className={styles.empty}>{keyword ? "没有匹配的内容。" : "还没有对话。"}</p>
        ) : (
          <ul className={styles.list}>
            {recent.map((item) => item.type === "space" ? (
              <li key={item.subject.id} className={cx(styles.item, props.activeSubjectId === item.subject.id && styles.active)}>
                <button
                  className={styles.itemButton}
                  onClick={() => props.onOpenSubject(item.subject.id)}
                  aria-current={props.activeSubjectId === item.subject.id ? "page" : undefined}
                >
                  <span className={styles.dot} style={{ background: item.subject.color }} />
                  <span className={styles.itemTitle}>{item.subject.name}</span>
                </button>
              </li>
            ) : (
              <ConversationItem
                key={item.conversation.id}
                conversation={item.conversation}
                active={item.conversation.id === activeId}
                generating={generatingIds.includes(item.conversation.id)}
                onOpen={() => props.onOpen(item.conversation.id)}
                onRename={(title) => props.onRename(item.conversation.id, title)}
                onDelete={() => props.onDelete(item.conversation.id)}
              />
            ))}
          </ul>
        )}
      </div>

      <footer className={styles.footer}>
        <span className={styles.avatar} aria-hidden>学</span>
        <span className={styles.userName}>演示学习者</span>
        <button className={styles.iconButton} onClick={props.onOpenSettings} aria-label="设置" title="设置">
          <Settings size={16} />
          {props.modelIssue && <span className={styles.alertDot} />}
        </button>
        <ThemeToggle />
      </footer>
    </nav>
  );
}

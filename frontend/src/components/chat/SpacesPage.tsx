"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUpDown, GraduationCap, MoreHorizontal, PanelLeftOpen,
  Plus, Search, X,
} from "lucide-react";
import { levelLabel, studiedLabel } from "@/lib/chat/space";
import type { Subject } from "@/lib/chat/types";
import { cx } from "@/lib/cx";
import styles from "./SpacesPage.module.css";

type SortKey = "studied" | "created" | "name";

const SORT_LABELS: Record<SortKey, string> = {
  studied: "最近学习",
  created: "创建时间",
  name: "按名称",
};

interface SpacesPageProps {
  subjects: Subject[];
  sidebarOpen: boolean;
  onOpenSidebar: () => void;
  onOpen: (id: string) => void;
  onCreate: () => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => Promise<boolean>;
}

export function SpacesPage(props: SpacesPageProps) {
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [sort, setSort] = useState<SortKey>("studied");
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const sortRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  useEffect(() => {
    if (!sortMenuOpen) return;
    const close = (event: MouseEvent) => {
      if (!sortRef.current?.contains(event.target as Node)) setSortMenuOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [sortMenuOpen]);

  const keyword = query.trim().toLowerCase();
  const shown = useMemo(() => {
    const items = props.subjects.filter(
      (subject) => !keyword || subject.name.toLowerCase().includes(keyword) || subject.goal.toLowerCase().includes(keyword),
    );
    const stamp = (subject: Subject) => subject.progress.lastStudiedAt ?? subject.updatedAt;
    items.sort((a, b) => {
      if (sort === "name") return a.name.localeCompare(b.name, "zh");
      if (sort === "created") return b.createdAt.localeCompare(a.createdAt);
      return stamp(b).localeCompare(stamp(a));
    });
    return items;
  }, [keyword, props.subjects, sort]);

  return (
    <div className={styles.page}>
      {!props.sidebarOpen && (
        <button className={styles.floatingToggle} onClick={props.onOpenSidebar} aria-label="展开侧栏" title="展开侧栏">
          <PanelLeftOpen size={16} />
        </button>
      )}

      <div className={styles.container}>
        <header className={styles.header}>
          <h1>学习空间</h1>

          <div className={styles.actions}>
            <div className={cx(styles.searchBox, (searchOpen || Boolean(query)) && styles.searchBoxOpen)}>
              <button
                type="button"
                className={styles.searchTrigger}
                onClick={() => {
                  if (!searchOpen) {
                    setSearchOpen(true);
                    window.setTimeout(() => searchInputRef.current?.focus(), 20);
                  } else {
                    searchInputRef.current?.focus();
                  }
                }}
                aria-label="搜索学习空间"
                title="搜索"
              >
                <Search size={15} aria-hidden />
              </button>
              <input
                ref={searchInputRef}
                value={query}
                tabIndex={searchOpen || Boolean(query) ? 0 : -1}
                onChange={(event) => setQuery(event.target.value)}
                onBlur={() => {
                  if (!query.trim()) setSearchOpen(false);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    setQuery("");
                    setSearchOpen(false);
                    searchInputRef.current?.blur();
                  }
                }}
                placeholder="搜索学习空间…"
                aria-label="搜索学习空间"
              />
              <button
                type="button"
                className={styles.clearSearch}
                tabIndex={searchOpen || Boolean(query) ? 0 : -1}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  setQuery("");
                  setSearchOpen(false);
                }}
                aria-label="关闭搜索"
              >
                <X size={13} />
              </button>
            </div>

            <div className={styles.sortAnchor} ref={sortRef}>
              <button
                type="button"
                className={styles.iconBtn}
                onClick={() => setSortMenuOpen((v) => !v)}
                aria-label={`排序：${SORT_LABELS[sort]}`}
                title={`排序：${SORT_LABELS[sort]}`}
              >
                <ArrowUpDown size={16} />
              </button>
              {sortMenuOpen && (
                <div className={styles.sortMenu} role="menu">
                  {(["studied", "created", "name"] as SortKey[]).map((key) => (
                    <button
                      key={key}
                      role="menuitem"
                      className={cx(styles.sortOption, sort === key && styles.sortOptionOn)}
                      onClick={() => {
                        setSort(key);
                        setSortMenuOpen(false);
                      }}
                    >
                      {SORT_LABELS[key]}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <button className={styles.createBtn} onClick={props.onCreate}>
              <span>新建空间</span>
              <span className={styles.createDivider} aria-hidden />
              <Plus size={14} aria-hidden />
            </button>
          </div>
        </header>

        {props.subjects.length === 0 ? (
          <div className={styles.emptyCard}>
            <div className={styles.emptyIcon}>
              <GraduationCap size={20} aria-hidden />
            </div>
            <h2>还没有学习空间</h2>
            <p>每个学习空间拥有一条主对话与多个并行 Thread。在主对话规划路线，在右侧 Thread 深入解决具体卡点，并共享课程资料与学习记忆。</p>
            <button className={styles.createBtn} onClick={props.onCreate}>
              <Plus size={14} aria-hidden />
              <span>新建学习空间</span>
            </button>
          </div>
        ) : shown.length === 0 ? (
          <p className={styles.muted}>没有匹配的学习空间。</p>
        ) : (
          <div className={styles.grid} data-stagger>
            {shown.map((subject) => (
              <article
                key={subject.id}
                className={cx(styles.card, menuId === subject.id && styles.cardMenuOpen)}
                style={{ "--c": subject.color } as React.CSSProperties}
                onMouseMove={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  event.currentTarget.style.setProperty("--mx", `${event.clientX - rect.left}px`);
                  event.currentTarget.style.setProperty("--my", `${event.clientY - rect.top}px`);
                }}
              >
                <button className={styles.cardMain} onClick={() => props.onOpen(subject.id)}>
                  <span className={styles.cardIcon} style={{ color: subject.color }} aria-hidden>
                    <GraduationCap size={17} />
                  </span>
                  <div className={styles.cardBody}>
                    <div className={styles.nameRow}>
                      <span className={styles.name}>{subject.name}</span>
                      {levelLabel(subject.level) && <span className={styles.tag}>{levelLabel(subject.level)}</span>}
                    </div>
                    {subject.goal && <p className={styles.goal}>{subject.goal}</p>}
                  </div>
                  <span className={styles.meta}>
                    {studiedLabel(subject.progress.lastStudiedAt)}
                    {subject.progress.openThreads > 0 && ` · ${subject.progress.openThreads} 个 Thread 进行中`}
                    {subject.progress.toReview > 0 && ` · ${subject.progress.toReview} 个待巩固`}
                  </span>
                </button>
                <button
                  className={styles.more}
                  aria-label={`${subject.name}的更多操作`}
                  onClick={() => setMenuId(menuId === subject.id ? null : subject.id)}
                >
                  <MoreHorizontal size={15} />
                </button>
                {menuId === subject.id && confirmId !== subject.id && (
                  <div className={styles.menu}>
                    <button onClick={() => { setMenuId(null); props.onEdit(subject.id); }}>编辑</button>
                    <button className={styles.danger} onClick={() => setConfirmId(subject.id)}>删除</button>
                  </div>
                )}
                {confirmId === subject.id && (
                  <div className={cx(styles.menu, styles.confirm)}>
                    <span>删除后，主对话和 Thread 会变成普通对话。</span>
                    <div className={styles.confirmBtns}>
                      <button onClick={() => { setConfirmId(null); setMenuId(null); }}>取消</button>
                      <button
                        className={styles.danger}
                        onClick={async () => {
                          if (await props.onDelete(subject.id)) {
                            setConfirmId(null);
                            setMenuId(null);
                          }
                        }}
                      >
                        删除
                      </button>
                    </div>
                  </div>
                )}
              </article>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

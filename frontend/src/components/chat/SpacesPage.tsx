"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUpDown, GraduationCap, LayoutGrid, List, MoreHorizontal, PanelLeftOpen,
  Plus, Search, X,
} from "lucide-react";
import { levelLabel, studiedLabel } from "@/lib/chat/space";
import type { Subject } from "@/lib/chat/types";
import { useI18n } from "@/components/LanguageProvider";
import { localeOf, type MessageKey } from "@/lib/i18n";
import { cx } from "@/lib/cx";
import styles from "./SpacesPage.module.css";

type SortKey = "studied" | "created" | "name";

const SORT_KEYS: Record<SortKey, MessageKey> = {
  studied: "spaces.sortStudied",
  created: "spaces.sortCreated",
  name: "spaces.sortName",
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
  const { lang, t } = useI18n();
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [sort, setSort] = useState<SortKey>("studied");
  const [layout, setLayout] = useState<"grid" | "list">("grid");
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const sortRef = useRef<HTMLDivElement>(null);
  const totalOpenThreads = useMemo(
    () => props.subjects.reduce((sum, s) => sum + (s.progress.openThreads ?? 0), 0),
    [props.subjects],
  );
  const totalReview = useMemo(
    () => props.subjects.reduce((sum, s) => sum + (s.progress.toReview ?? 0), 0),
    [props.subjects],
  );

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
      if (sort === "name") return a.name.localeCompare(b.name, localeOf(lang));
      if (sort === "created") return b.createdAt.localeCompare(a.createdAt);
      return stamp(b).localeCompare(stamp(a));
    });
    return items;
  }, [keyword, lang, props.subjects, sort]);

  return (
    <div className={styles.page}>
      {!props.sidebarOpen && (
        <button className={styles.floatingToggle} onClick={props.onOpenSidebar} aria-label={t("sidebar.expand")} title={t("sidebar.expand")}>
          <PanelLeftOpen size={16} />
        </button>
      )}

      <div className={styles.container}>
        <header className={styles.header}>
          <div className={styles.titleGroup}>
            <h1>{t("spaces.title")}</h1>
            <span className={styles.summaryBadge}>
              {t("spaces.summary", { spaces: props.subjects.length, threads: totalOpenThreads, review: totalReview })}
            </span>
          </div>

          <div className={styles.actions}>
            <div className={styles.layoutSwitch} role="group" aria-label={t("spaces.sortAria")}>
              <button
                type="button"
                className={cx(styles.layoutBtn, layout === "grid" && styles.layoutBtnOn)}
                onClick={() => setLayout("grid")}
                aria-label={t("spaces.layoutGrid")}
                title={t("spaces.layoutGrid")}
              >
                <LayoutGrid size={14} />
              </button>
              <button
                type="button"
                className={cx(styles.layoutBtn, layout === "list" && styles.layoutBtnOn)}
                onClick={() => setLayout("list")}
                aria-label={t("spaces.layoutList")}
                title={t("spaces.layoutList")}
              >
                <List size={14} />
              </button>
            </div>
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
                aria-label={t("spaces.searchAria")}
                title={t("common.search")}
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
                placeholder={t("spaces.searchPlaceholder")}
                aria-label={t("spaces.searchAria")}
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
                aria-label={t("spaces.closeSearch")}
              >
                <X size={13} />
              </button>
            </div>

            <div className={styles.sortAnchor} ref={sortRef}>
              <button
                type="button"
                className={styles.iconBtn}
                onClick={() => setSortMenuOpen((v) => !v)}
                aria-label={`${t("spaces.sortAria")}: ${t(SORT_KEYS[sort])}`}
                title={`${t("spaces.sortAria")}: ${t(SORT_KEYS[sort])}`}
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
                      {t(SORT_KEYS[key])}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <button className={styles.createBtn} onClick={props.onCreate}>
              <span>{t("spaces.new")}</span>
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
            <h2>{t("spaces.emptyTitle")}</h2>
            <p>{t("spaces.emptyBody")}</p>
            <button className={styles.createBtn} onClick={props.onCreate}>
              <Plus size={14} aria-hidden />
              <span>{t("spaces.new")}</span>
            </button>
          </div>
        ) : shown.length === 0 ? (
          <p className={styles.muted}>{t("spaces.noMatches")}</p>
        ) : (
          <div className={cx(styles.grid, layout === "list" && styles.listMode)} data-stagger>
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
                      {levelLabel(subject.level, lang) && <span className={styles.tag}>{levelLabel(subject.level, lang)}</span>}
                    </div>
                    {subject.goal && <p className={styles.goal}>{subject.goal}</p>}
                  </div>
                  <span className={styles.meta}>
                    {studiedLabel(subject.progress.lastStudiedAt, lang)}
                    {subject.progress.openThreads > 0 && t("spaces.cardOpenThreads", { count: subject.progress.openThreads })}
                    {subject.progress.toReview > 0 && t("spaces.cardReview", { count: subject.progress.toReview })}
                  </span>
                </button>
                <button
                  className={styles.more}
                  aria-label={t("spaces.moreActions", { name: subject.name })}
                  onClick={() => setMenuId(menuId === subject.id ? null : subject.id)}
                >
                  <MoreHorizontal size={15} />
                </button>
                {menuId === subject.id && confirmId !== subject.id && (
                  <div className={styles.menu}>
                    <button onClick={() => { setMenuId(null); props.onEdit(subject.id); }}>{t("common.edit")}</button>
                    <button className={styles.danger} onClick={() => setConfirmId(subject.id)}>{t("common.delete")}</button>
                  </div>
                )}
                {confirmId === subject.id && (
                  <div className={cx(styles.menu, styles.confirm)}>
                    <span>{t("spaces.deleteWarning")}</span>
                    <div className={styles.confirmBtns}>
                      <button onClick={() => { setConfirmId(null); setMenuId(null); }}>{t("common.cancel")}</button>
                      <button
                        className={styles.danger}
                        onClick={async () => {
                          if (await props.onDelete(subject.id)) {
                            setConfirmId(null);
                            setMenuId(null);
                          }
                        }}
                      >
                        {t("common.delete")}
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

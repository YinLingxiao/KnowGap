"use client";

import { useMemo, useState } from "react";
import { MoreHorizontal, PanelLeftOpen, Plus, Search } from "lucide-react";
import { levelLabel, progressLine } from "@/lib/chat/space";
import type { Subject } from "@/lib/chat/types";
import { cx } from "@/lib/cx";
import styles from "./SpacesPage.module.css";

type SortKey = "studied" | "created" | "name";

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
  const [sort, setSort] = useState<SortKey>("studied");
  const [menuId, setMenuId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const keyword = query.trim().toLowerCase();
  const shown = useMemo(() => {
    const items = props.subjects.filter((subject) => !keyword || subject.name.toLowerCase().includes(keyword) || subject.goal.toLowerCase().includes(keyword));
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
      <header className={styles.top}>
        {!props.sidebarOpen && (
          <button className={styles.icon} onClick={props.onOpenSidebar} aria-label="展开侧栏">
            <PanelLeftOpen size={16} />
          </button>
        )}
        <h1>学习空间</h1>
      </header>
      <div className={styles.toolbar}>
        <label className={styles.search}>
          <Search size={14} aria-hidden />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索学习空间" aria-label="搜索学习空间" />
        </label>
        <select value={sort} onChange={(event) => setSort(event.target.value as SortKey)} aria-label="排序">
          <option value="studied">最近学习</option>
          <option value="created">创建时间</option>
          <option value="name">名称</option>
        </select>
        <button className={styles.create} onClick={props.onCreate}>
          <Plus size={14} aria-hidden />
          新建学习空间
        </button>
      </div>
      {props.subjects.length === 0 ? (
        <div className={styles.empty}>
          <h2>还没有学习空间</h2>
          <p>每个空间只有一条主对话，负责整体路线。遇到具体卡点时在右侧开 Thread，解决后把小结合并回主对话。</p>
          <button className={styles.create} onClick={props.onCreate}>
            <Plus size={14} aria-hidden />
            新建学习空间
          </button>
        </div>
      ) : shown.length === 0 ? (
        <p className={styles.muted}>没有匹配的学习空间。</p>
      ) : (
        <div className={styles.grid}>
          {shown.map((subject) => {
            const total = subject.progress.mastered + subject.progress.toReview;
            const width = total ? Math.round((subject.progress.mastered / total) * 100) : 0;
            return (
              <article key={subject.id} className={styles.card}>
                <button className={styles.cardMain} onClick={() => props.onOpen(subject.id)}>
                  <span className={styles.dot} style={{ background: subject.color }} />
                  <span className={styles.name}>{subject.name}</span>
                  {levelLabel(subject.level) && <span className={styles.tag}>{levelLabel(subject.level)}</span>}
                  <span className={styles.goal}>{subject.goal || "还没有写下目标"}</span>
                  <span className={styles.bar} aria-hidden>
                    <i style={{ width: `${width}%` }} />
                  </span>
                  <span className={styles.meta}>{progressLine(subject.progress)}</span>
                </button>
                <button
                  className={styles.more}
                  aria-label={`${subject.name}的更多操作`}
                  onClick={() => setMenuId(menuId === subject.id ? null : subject.id)}
                >
                  <MoreHorizontal size={16} />
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
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

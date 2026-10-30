"use client";

import { CalendarDays, CalendarRange, Inbox, Plus, Star, type LucideIcon } from "lucide-react";
import { useI18n } from "@/components/LanguageProvider";
import { cx } from "@/lib/cx";
import type { SubjectInfo } from "./AgendaList";
import { spaceIdOf, spaceView, VIEW_LABELS, type AgendaViewKey, type ViewCounts } from "./agendaModel";
import styles from "./AgendaRail.module.css";

interface AgendaRailProps {
  view: AgendaViewKey;
  counts: ViewCounts;
  subjects: SubjectInfo[];
  onChange: (view: AgendaViewKey) => void;
  onAdd: () => void;
}

const FIXED: { key: "inbox" | "today" | "upcoming" | "week"; icon: LucideIcon }[] = [
  { key: "inbox", icon: Inbox },
  { key: "today", icon: Star },
  { key: "upcoming", icon: CalendarRange },
  { key: "week", icon: CalendarDays },
];

/** 日程页左侧导航；容器宽度 ≤640px 时由 CSS 切换为顶部下拉选择 */
export function AgendaRail({ view, counts, subjects, onChange, onAdd }: AgendaRailProps) {
  const { tx } = useI18n();
  const activeSpace = spaceIdOf(view);

  return (
    <>
      <nav className={styles.rail} aria-label={tx("日程视图")}>
        <button type="button" className={styles.add} onClick={onAdd} aria-keyshortcuts="Q" title={tx("添加任务")}>
          <span className={styles.addIcon} aria-hidden><Plus size={13} strokeWidth={2.5} /></span>
          <span className={styles.name}>{tx("添加任务")}</span>
        </button>
        <ul className={styles.list}>
          {FIXED.map(({ key, icon: Icon }) => (
            <li key={key}>
              <button
                type="button"
                className={cx(styles.item, view === key && styles.active)}
                aria-current={view === key ? "page" : undefined}
                onClick={() => onChange(key)}
              >
                <Icon size={14} className={styles.icon} aria-hidden />
                <span className={styles.name}>{tx(VIEW_LABELS[key])}</span>
                {counts[key] > 0 && <span className={styles.count}>{counts[key]}</span>}
              </button>
            </li>
          ))}
        </ul>

        <h2 className={styles.section}>{tx("学习空间")}</h2>
        {subjects.length ? (
          <ul className={styles.list}>
            {subjects.map((subject) => {
              const active = activeSpace === subject.id;
              const count = counts.spaces.get(subject.id) ?? 0;
              return (
                <li key={subject.id}>
                  <button
                    type="button"
                    className={cx(styles.item, active && styles.active)}
                    aria-current={active ? "page" : undefined}
                    onClick={() => onChange(spaceView(subject.id))}
                    title={subject.name}
                  >
                    <span className={styles.dotSlot} aria-hidden>
                      <span className={styles.dot} style={{ background: subject.color }} />
                    </span>
                    <span className={styles.name}>{subject.name}</span>
                    {count > 0 && <span className={styles.count}>{count}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className={styles.empty}>{tx("还没有学习空间")}</p>
        )}
      </nav>

      <label className={styles.picker}>
        <span className="sr-only">{tx("日程视图")}</span>
        <select value={view} aria-label={tx("日程视图")} onChange={(event) => onChange(event.target.value as AgendaViewKey)}>
          <optgroup label={tx("视图")}>
            {FIXED.map(({ key }) => (
              <option key={key} value={key}>
                {tx(VIEW_LABELS[key])}{counts[key] ? tx("（{count}）", { count: counts[key] }) : ""}
              </option>
            ))}
          </optgroup>
          {subjects.length > 0 && (
            <optgroup label={tx("学习空间")}>
              {subjects.map((subject) => {
                const count = counts.spaces.get(subject.id) ?? 0;
                return (
                  <option key={subject.id} value={spaceView(subject.id)}>
                    {subject.name}{count ? tx("（{count}）", { count }) : ""}
                  </option>
                );
              })}
            </optgroup>
          )}
        </select>
      </label>
    </>
  );
}

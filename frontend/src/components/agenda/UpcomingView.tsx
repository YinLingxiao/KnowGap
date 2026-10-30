"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useI18n } from "@/components/LanguageProvider";
import { cx } from "@/lib/cx";
import { AgendaEmpty } from "./AgendaEmpty";
import { AgendaList, type AgendaListProps } from "./AgendaList";
import { addDays, dayGroupKey, mondayOf, UPCOMING_DAYS, weekdayOf, type AgendaGroup } from "./agendaModel";
import styles from "./UpcomingView.module.css";

interface UpcomingViewProps {
  groups: AgendaGroup[];
  today: string;
  listProps: Omit<AgendaListProps, "groups" | "today">;
  onBreakdown?: () => void;
}

const prefersReducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** 「预览」视图：顶部一周日期导航 + 按天分节的列表（逾期在最上方） */
export function UpcomingView({ groups, today, listProps, onBreakdown }: UpcomingViewProps) {
  const { tx } = useI18n();
  const scrollRef = useRef<HTMLDivElement>(null);
  const thisWeek = mondayOf(today);
  const lastDay = addDays(today, UPCOMING_DAYS - 1);
  const [weekStart, setWeekStart] = useState(thisWeek);
  const [picked, setPicked] = useState<string | null>(null);

  // 跨午夜后回到新的本周
  useEffect(() => setWeekStart(mondayOf(today)), [today]);

  const busyDays = useMemo(
    () => new Set(groups.filter((group) => group.nodes.length > 0).map((group) => group.key)),
    [groups],
  );
  const days = useMemo(() => Array.from({ length: 7 }, (_, index) => addDays(weekStart, index)), [weekStart]);

  const scrollTo = useCallback((day: string) => {
    const element = scrollRef.current?.querySelector<HTMLElement>(`[data-group-key="${CSS.escape(dayGroupKey(day))}"]`);
    element?.scrollIntoView({ block: "start", behavior: prefersReducedMotion() ? "auto" : "smooth" });
    setPicked(day);
  }, []);

  const goWeek = (start: string) => {
    setWeekStart(start);
    const target = start < today ? today : start;
    if (target <= lastDay) scrollTo(target);
  };

  const canPrev = weekStart > thisWeek;
  const canNext = addDays(weekStart, 7) <= lastDay;
  const middle = addDays(weekStart, 3);
  const monthLabel = tx("{year}年{month}月", { year: Number(middle.slice(0, 4)), month: Number(middle.slice(5, 7)) });

  return (
    <div className={styles.view}>
      <div className={styles.strip}>
        <div className={styles.stripHead}>
          <h2 className={styles.month}>{monthLabel}</h2>
          <div className={styles.nav}>
            <button
              type="button"
              className={styles.navBtn}
              onClick={() => goWeek(addDays(weekStart, -7))}
              disabled={!canPrev}
              aria-label={tx("上一周")}
              title={tx("上一周")}
            >
              <ChevronLeft size={14} aria-hidden />
            </button>
            <button type="button" className={styles.todayBtn} onClick={() => { setWeekStart(thisWeek); scrollTo(today); }}>
              {tx("今天")}
            </button>
            <button
              type="button"
              className={styles.navBtn}
              onClick={() => goWeek(addDays(weekStart, 7))}
              disabled={!canNext}
              aria-label={tx("下一周")}
              title={tx("下一周")}
            >
              <ChevronRight size={14} aria-hidden />
            </button>
          </div>
        </div>
        <div className={styles.days} role="group" aria-label={tx("选择日期，跳到当天")}>
          {days.map((day) => {
            const inRange = day >= today && day <= lastDay;
            const isToday = day === today;
            return (
              <button
                key={day}
                type="button"
                className={cx(styles.day, isToday && styles.dayToday, picked === day && styles.dayPicked)}
                disabled={!inRange}
                aria-pressed={picked === day}
                aria-label={`${tx("{month}月{day}日", { month: Number(day.slice(5, 7)), day: Number(day.slice(8)) })} ${weekdayOf(day, tx)}${isToday ? tx("（今天）") : ""}`}
                onClick={() => scrollTo(day)}
              >
                <span className={styles.dayName}>{tx(weekdayOf(day, tx)).replace(/^周/, "")}</span>
                <span className={styles.dayNum}>{Number(day.slice(8))}</span>
                <span className={cx(styles.dayDot, busyDays.has(dayGroupKey(day)) && styles.dayDotOn)} aria-hidden />
              </button>
            );
          })}
        </div>
      </div>

      <div ref={scrollRef} className={styles.scroll}>
        {groups.every((group) => group.nodes.length === 0) && (
          <AgendaEmpty variant="upcoming" onBreakdown={onBreakdown} />
        )}
        <AgendaList {...listProps} groups={groups} today={today} ariaLabel={tx("预览")} />
      </div>
    </div>
  );
}

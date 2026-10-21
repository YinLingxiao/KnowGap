"use client";

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ChevronLeft, ChevronRight, Flag, RotateCcw } from "lucide-react";
import type { AgendaTask, AgendaThread } from "@/lib/agenda/types";
import styles from "./WeekCalendar.module.css";

export interface WeekCalendarProps {
  weekStart: string;
  tasks: AgendaTask[];
  threads: AgendaThread[];
  today: string;
  onWeekChange: (weekStart: string) => void;
  onSelectTask: (taskId: string) => void;
  onSelectThread?: (threadId: string) => void;
  onReschedule: (taskId: string, patch: { scheduledDate: string; scheduledStartAt: string | null; durationMinutes: number | null }) => void;
  onCreateAt?: (slot: { scheduledDate: string; scheduledStartAt: string | null }) => void;
}

const START = 360;
const END = 1440;
const SCALE = 1.2;
const HEIGHT = (END - START) * SCALE;
const weekdays = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
function dateString(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function addDays(day: string, count: number) {
  const date = new Date(`${day}T12:00:00`);
  date.setDate(date.getDate() + count);
  return dateString(date);
}
function monday(day: string) {
  const date = new Date(`${day}T12:00:00`);
  return addDays(day, -((date.getDay() + 6) % 7));
}
function minutes(value: string) {
  const [h, m] = value.slice(11, 16).split(":").map(Number);
  return h * 60 + m;
}
function clock(value: number) {
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}
function clamp(value: number, min: number, max: number) { return Math.max(min, Math.min(max, value)); }

/** Connected overlap groups share a column count; touching endpoints do not overlap. */
function layout(tasks: AgendaTask[]) {
  const sorted = tasks.map(task => ({ task, start: minutes(task.scheduledStartAt!), end: minutes(task.scheduledStartAt!) + (task.durationMinutes ?? 30), column: 0, columns: 1 }))
    .sort((a, b) => a.start - b.start || b.end - a.end || a.task.id.localeCompare(b.task.id));
  let group: typeof sorted = [];
  let ends: number[] = [];
  let groupEnd = -1;
  const flush = () => { for (const item of group) item.columns = ends.length; group = []; ends = []; };
  for (const item of sorted) {
    if (item.start >= groupEnd) flush();
    let column = ends.findIndex(end => end <= item.start);
    if (column === -1) column = ends.length;
    ends[column] = item.end;
    item.column = column;
    group.push(item);
    groupEnd = Math.max(group.length === 1 ? -1 : groupEnd, item.end);
  }
  flush();
  return sorted;
}

type Patch = Parameters<WeekCalendarProps["onReschedule"]>[1];
type Drag = { task: AgendaTask; mode: "move" | "resize"; x: number; y: number; offset: number; moved: boolean; patch: Patch };

export default function WeekCalendar({ weekStart, tasks, threads, today, onWeekChange, onSelectTask, onSelectThread, onReschedule, onCreateAt }: WeekCalendarProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const allDayRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const suppressClick = useRef(false);
  const [preview, setPreview] = useState<{ id: string; patch: Patch } | null>(null);
  const [scrollbarWidth, setScrollbarWidth] = useState(0);
  const [now, setNow] = useState<Date | null>(null);
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = (480 - START) * SCALE;
    dragRef.current = null;
    setPreview(null);
  }, [weekStart]);
  useEffect(() => {
    setNow(new Date());
    const viewport = scrollRef.current;
    const measure = () => { if (viewport) setScrollbarWidth(viewport.offsetWidth - viewport.clientWidth); };
    measure();
    const observer = new ResizeObserver(measure);
    if (viewport) observer.observe(viewport);
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    const cancel = (event: KeyboardEvent) => {
      if (event.key === "Escape") { dragRef.current = null; setPreview(null); }
    };
    window.addEventListener("keydown", cancel);
    return () => { clearInterval(timer); observer.disconnect(); window.removeEventListener("keydown", cancel); };
  }, []);

  function begin(event: ReactPointerEvent, task: AgendaTask, mode: Drag["mode"]) {
    if (event.button !== 0) return;
    event.stopPropagation();
    suppressClick.current = false;
    const start = task.scheduledStartAt ? minutes(task.scheduledStartAt) : 480;
    const top = gridRef.current?.getBoundingClientRect().top ?? 0;
    dragRef.current = { task, mode, x: event.clientX, y: event.clientY,
      offset: task.scheduledStartAt ? (event.clientY - top) / SCALE - start + START : 0,
      moved: false, patch: { scheduledDate: task.scheduledDate ?? task.scheduledStartAt?.slice(0, 10) ?? weekStart,
        scheduledStartAt: task.scheduledStartAt, durationMinutes: task.durationMinutes } };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function move(event: ReactPointerEvent) {
    const drag = dragRef.current;
    if (!drag || !gridRef.current || !allDayRef.current) return;
    if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 4) return;
    drag.moved = true;
    rootRef.current?.setPointerCapture(event.pointerId);
    const grid = gridRef.current.getBoundingClientRect();
    const allDay = allDayRef.current.getBoundingClientRect();
    const dayIndex = clamp(Math.floor((event.clientX - grid.left) / (grid.width / 7)), 0, 6);
    const scheduledDate = days[dayIndex];
    const isAllDay = drag.mode === "move" && event.clientY >= allDay.top && event.clientY <= allDay.bottom;
    if (isAllDay) {
      drag.patch = { scheduledDate, scheduledStartAt: null, durationMinutes: null };
    } else if (drag.mode === "resize") {
      const start = minutes(drag.task.scheduledStartAt!);
      const maxDuration = Math.max(5, Math.floor(Math.min(720, END - start) / 15) * 15);
      const duration = clamp(Math.round(((event.clientY - grid.top) / SCALE + START - start) / 15) * 15, Math.min(15, maxDuration), maxDuration);
      drag.patch = { scheduledDate: drag.task.scheduledStartAt!.slice(0, 10), scheduledStartAt: drag.task.scheduledStartAt, durationMinutes: duration };
    } else {
      const duration = clamp(drag.task.durationMinutes ?? 30, 5, 720);
      const start = clamp(Math.round(((event.clientY - grid.top) / SCALE + START - drag.offset) / 15) * 15, START, Math.floor((END - duration) / 15) * 15);
      drag.patch = { scheduledDate, scheduledStartAt: `${scheduledDate}T${clock(start)}`, durationMinutes: duration };
    }
    setPreview({ id: drag.task.id, patch: drag.patch });
    const viewport = scrollRef.current;
    if (viewport && !isAllDay) {
      const bounds = viewport.getBoundingClientRect();
      if (event.clientY > bounds.bottom - 40) viewport.scrollTop += 16;
      else if (event.clientY < bounds.top + 40) viewport.scrollTop -= 16;
    }
  }
  function finish(event: ReactPointerEvent, cancel = false) {
    const drag = dragRef.current;
    dragRef.current = null;
    setPreview(null);
    if (drag?.moved) {
      suppressClick.current = true;
      window.setTimeout(() => { suppressClick.current = false; }, 0);
      if (!cancel) onReschedule(drag.task.id, drag.patch);
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  function select(taskId: string) {
    if (suppressClick.current) { suppressClick.current = false; return; }
    onSelectTask(taskId);
  }
  function keyboard(event: React.KeyboardEvent, task: AgendaTask) {
    if (!event.altKey || !task.scheduledDate || !event.key.startsWith("Arrow")) return;
    event.preventDefault();
    const delta = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
    const scheduledDate = addDays(task.scheduledDate, delta);
    const start = task.scheduledStartAt ? minutes(task.scheduledStartAt) : null;
    const duration = task.durationMinutes ?? 30;
    const timeDelta = event.key === "ArrowUp" ? -15 : event.key === "ArrowDown" ? 15 : 0;
    onReschedule(task.id, { scheduledDate, scheduledStartAt: start === null ? null : `${scheduledDate}T${clock(clamp(start + (event.shiftKey ? 0 : timeDelta), START, END - duration))}`,
      durationMinutes: event.shiftKey && start !== null ? clamp(duration + timeDelta, 15, Math.min(720, END - start)) : task.durationMinutes });
  }
  const visibleTasks = tasks.filter(task => task.status !== "cancelled").map(task => preview?.id === task.id ? { ...task, ...preview.patch } : task);
  const nowMinutes = now ? now.getHours() * 60 + now.getMinutes() : -1;

  return <section ref={rootRef} className={styles.calendar} aria-label="周历" onPointerMove={move} onPointerUp={event => finish(event)} onPointerCancel={event => finish(event, true)}>
    <div className={styles.toolbar}>
      <strong>{weekStart.replaceAll("-", "/")} – {days[6].slice(5).replace("-", "/")}</strong>
      <div className={styles.navigation}>
        <button type="button" aria-label="上一周" onClick={() => onWeekChange(addDays(weekStart, -7))}><ChevronLeft size={16} /></button>
        <button type="button" onClick={() => onWeekChange(monday(today))}>本周</button>
        <button type="button" aria-label="下一周" onClick={() => onWeekChange(addDays(weekStart, 7))}><ChevronRight size={16} /></button>
      </div>
      <span className={styles.hint}>拖动排期 · 底边调整时长 · 15 分钟吸附</span>
    </div>
    <div className={styles.horizontal}>
      <div className={styles.sheet}>
        <div className={styles.header} style={{ paddingRight: scrollbarWidth }}>
          <span className={styles.gutter}>GMT{new Date().getTimezoneOffset() <= 0 ? "+" : "−"}{Math.abs(new Date().getTimezoneOffset() / 60)}</span>
          {days.map((day, i) => <div className={styles.dayHeader} key={day} data-today={day === today}>
            <span>{weekdays[i]}</span><strong>{Number(day.slice(8))}</strong>
            <div className={styles.markers}>
              {tasks.filter(task => task.status !== "cancelled" && task.deadlineDate === day).map(task => <button type="button" key={task.id} className={styles.deadline} title={`截止：${task.title}`} onClick={() => onSelectTask(task.id)}><Flag size={11} />{task.title}</button>)}
              {threads.filter(thread => thread.deadlineDate === day).map(thread => <button type="button" key={thread.threadId} className={styles.thread} disabled={!onSelectThread} title={`${thread.subjectName} · ${thread.title}`} onClick={() => onSelectThread?.(thread.threadId)}>{thread.title}</button>)}
            </div>
          </div>)}
        </div>
        <div className={styles.allDayRow} style={{ paddingRight: scrollbarWidth }}>
          <span className={styles.gutter}>全天</span>
          <div className={styles.allDayGrid} ref={allDayRef}>
            {days.map(day => <div key={day} className={styles.allDayCell} onClick={event => { if (event.target === event.currentTarget) onCreateAt?.({ scheduledDate: day, scheduledStartAt: null }); }}>
              {visibleTasks.filter(task => task.scheduledDate === day && !task.scheduledStartAt).map(task => <button type="button" key={task.id} data-task-id={task.id} data-done={task.status === "done"} data-preview={preview?.id === task.id} className={styles.allDayTask}
                onPointerDown={event => begin(event, tasks.find(original => original.id === task.id)!, "move")} onClick={() => select(task.id)} onKeyDown={event => keyboard(event, task)}>
                {task.source === "review" && <RotateCcw size={11} aria-label="闪回" />}<span>{task.title}</span>
              </button>)}
            </div>)}
          </div>
        </div>
        <div className={styles.timeScroll} ref={scrollRef}>
          <div className={styles.timeBody} style={{ height: HEIGHT }}>
            <div className={styles.timeLabels}>{Array.from({ length: 19 }, (_, i) => <span key={i} style={{ top: i * 60 * SCALE }}>{clock(START + i * 60)}</span>)}</div>
            <div className={styles.timeGrid} ref={gridRef}>
              {days.map(day => <div key={day} className={styles.timeColumn}>
                {Array.from({ length: 36 }, (_, slot) => <button type="button" key={slot} className={styles.slot} aria-label={`${day} ${clock(START + slot * 30)} 创建任务`}
                  onClick={() => { if (!suppressClick.current) onCreateAt?.({ scheduledDate: day, scheduledStartAt: `${day}T${clock(START + slot * 30)}` }); suppressClick.current = false; }} />)}
                {layout(visibleTasks.filter(task => task.scheduledStartAt?.slice(0, 10) === day)).filter(item => item.end > START && item.start < END).map(({ task, start, end, column, columns }) =>
                  <div key={task.id} className={styles.block} data-task-id={task.id} data-done={task.status === "done"} data-preview={preview?.id === task.id} style={{ top: (Math.max(start, START) - START) * SCALE, height: Math.max(18, (Math.min(end, END) - Math.max(start, START)) * SCALE - 2), left: `calc(${column / columns * 100}% + 3px)`, width: `calc(${100 / columns}% - 6px)` }}>
                    <button type="button" className={styles.blockMain} onPointerDown={event => begin(event, tasks.find(original => original.id === task.id)!, "move")} onClick={() => select(task.id)} onKeyDown={event => keyboard(event, task)} title={`${task.title} · ${clock(start)}–${clock(end)}。Alt + 方向键排期，Alt + Shift + 上下调整时长`}>
                      <span className={styles.blockTitle}>{task.source === "review" && <RotateCcw size={12} aria-label="闪回" />}{task.title}</span>
                      <span className={styles.blockTime}>{clock(start)}–{clock(end)}</span>
                    </button>
                    <button type="button" className={styles.resize} aria-label={`调整时长：${task.title}`} onPointerDown={event => begin(event, tasks.find(original => original.id === task.id)!, "resize")} onClick={event => { event.stopPropagation(); suppressClick.current = false; }} onKeyDown={event => keyboard(event, task)} />
                  </div>)}
                {now && dateString(now) === day && nowMinutes >= START && nowMinutes < END && <div className={styles.now} style={{ top: (nowMinutes - START) * SCALE }} aria-label={`当前时间 ${clock(nowMinutes)}`} />}
              </div>)}
            </div>
          </div>
        </div>
      </div>
    </div>
    <div className={styles.status} role="status">{preview ? `${preview.patch.scheduledDate} · ${preview.patch.scheduledStartAt ? `${preview.patch.scheduledStartAt.slice(11)} / ${preview.patch.durationMinutes} 分钟` : "全天"} · 松开保存，Esc 取消` : "点击空白创建任务；Alt + 方向键也可调整排期"}</div>
  </section>;
}

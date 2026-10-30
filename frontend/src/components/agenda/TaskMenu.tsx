"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  BetweenHorizontalEnd, BetweenHorizontalStart, Check, ChevronLeft, CircleSlash, Copy, Ellipsis, Flag,
  FolderInput, Pencil, Sofa, SquareArrowRight, Sun, Trash2,
} from "lucide-react";
import { useI18n } from "@/components/LanguageProvider";
import type { AgendaTask, TaskPriority } from "@/lib/agenda/types";
import { cx } from "@/lib/cx";
import type { SubjectInfo } from "./AgendaList";
import { addDays, nextMondayOf, weekendOf } from "./agendaModel";
import styles from "./TaskMenu.module.css";

interface TaskMenuProps {
  task: AgendaTask;
  today: string;
  subjects: SubjectInfo[];
  x: number;
  y: number;
  onClose: () => void;
  onEdit: () => void;
  onSchedule: (date: string | null) => void;
  onPriority: (priority: TaskPriority) => void;
  onMove: (subjectId: string | null) => void;
  onInsert: (where: "above" | "below") => void;
  onDuplicate: () => void;
  onDelete: () => void;
}

const PRIORITIES: { value: TaskPriority; label: string; tone: string }[] = [
  { value: 1, label: "P1 紧急", tone: styles.p1 },
  { value: 2, label: "P2 高", tone: styles.p2 },
  { value: 3, label: "P3 中", tone: styles.p3 },
  { value: 4, label: "P4 无", tone: styles.p4 },
];

export function TaskMenu(props: TaskMenuProps) {
  const { tx } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: props.x, top: props.y });
  const [confirming, setConfirming] = useState(false);
  const [moving, setMoving] = useState(false);
  const dates: { label: string; date: string | null; tone: string; icon: ReactNode }[] = [
    { label: "今天", date: props.today, tone: styles.green, icon: <span className={styles.dayIcon}>{Number(props.today.slice(8))}</span> },
    { label: "明天", date: addDays(props.today, 1), tone: styles.amber, icon: <Sun size={17} /> },
    { label: "本周末", date: weekendOf(props.today), tone: styles.blue, icon: <Sofa size={17} /> },
    { label: "下周一", date: nextMondayOf(props.today), tone: styles.purple, icon: <SquareArrowRight size={17} /> },
    { label: "无日期", date: null, tone: styles.muted, icon: <CircleSlash size={17} /> },
  ];

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const left = Math.max(8, Math.min(props.x, window.innerWidth - rect.width - 8));
    const top = props.y + rect.height > window.innerHeight - 8 ? Math.max(8, props.y - rect.height) : props.y;
    setPos({ left, top });
  }, [props.x, props.y, moving]);

  useEffect(() => {
    const onPointer = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) props.onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      if (moving) setMoving(false);
      else props.onClose();
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [props, moving]);

  const run = (action: () => void) => {
    action();
    props.onClose();
  };

  return createPortal(
    <div
      ref={ref}
      className={styles.menu}
      style={pos}
      role="menu"
      aria-label={tx("「{title}」的操作", { title: props.task.title })}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      {moving ? (
        <>
          <button type="button" className={styles.back} onClick={() => setMoving(false)}>
            <ChevronLeft size={15} aria-hidden />{tx("移动到……")}
          </button>
          <div className={styles.sep} />
          <Item
            icon={<span className={styles.dotSlot}><span className={cx(styles.dot, styles.dotNone)} /></span>}
            label={tx("未归入空间")}
            checked={!props.task.subjectId}
            onClick={() => run(() => props.onMove(null))}
          />
          {props.subjects.map((subject) => (
            <Item
              key={subject.id}
              icon={<span className={styles.dotSlot}><span className={styles.dot} style={{ background: subject.color }} /></span>}
              label={subject.name}
              checked={props.task.subjectId === subject.id}
              onClick={() => run(() => props.onMove(subject.id))}
            />
          ))}
        </>
      ) : (
        <>
          <Item icon={<BetweenHorizontalStart size={16} />} label={tx("在上面添加任务")} onClick={() => run(() => props.onInsert("above"))} />
          <Item icon={<BetweenHorizontalEnd size={16} />} label={tx("在下面添加任务")} onClick={() => run(() => props.onInsert("below"))} />
          <div className={styles.sep} />
          <Item icon={<Pencil size={16} />} label={tx("编辑")} onClick={() => run(props.onEdit)} />
          <div className={styles.sep} />

          <p className={styles.label}>{tx("日期")}</p>
          <div className={styles.iconRow} role="group" aria-label={tx("日期")}>
            {dates.map((item) => {
              const on = (props.task.scheduledDate ?? null) === item.date;
              return (
                <button
                  key={item.label}
                  type="button"
                  role="menuitemradio"
                  aria-checked={on}
                  aria-label={tx(item.label)}
                  title={tx(item.label)}
                  className={cx(styles.iconBtn, item.tone, on && styles.iconOn)}
                  onClick={() => run(() => props.onSchedule(item.date))}
                >
                  {item.icon}
                </button>
              );
            })}
            <button
              type="button"
              role="menuitem"
              aria-label={tx("选择其他日期")}
              title={tx("选择其他日期")}
              className={cx(styles.iconBtn, styles.muted)}
              onClick={() => run(props.onEdit)}
            >
              <Ellipsis size={17} />
            </button>
          </div>

          <p className={styles.label}>{tx("优先级")}</p>
          <div className={styles.iconRow} role="group" aria-label={tx("优先级")}>
            {PRIORITIES.map((item) => {
              const on = props.task.priority === item.value;
              return (
                <button
                  key={item.value}
                  type="button"
                  role="menuitemradio"
                  aria-checked={on}
                  aria-label={tx(item.label)}
                  title={tx(item.label)}
                  className={cx(styles.iconBtn, item.tone, on && styles.iconOn)}
                  onClick={() => run(() => props.onPriority(item.value))}
                >
                  <Flag size={17} fill={item.value === 4 ? "none" : "currentColor"} />
                </button>
              );
            })}
          </div>
          <div className={styles.sep} />

          <Item icon={<FolderInput size={16} />} label={tx("移动到……")} onClick={() => setMoving(true)} />
          <Item icon={<Copy size={16} />} label={tx("复制")} onClick={() => run(props.onDuplicate)} />
          <div className={styles.sep} />
          <Item
            icon={<Trash2 size={16} />}
            label={confirming ? tx("再点一次确认删除") : tx("删除")}
            danger
            onClick={() => {
              if (!confirming) { setConfirming(true); return; }
              run(props.onDelete);
            }}
          />
        </>
      )}
    </div>,
    document.body,
  );
}

function Item({ icon, label, checked, danger, onClick }: {
  icon: ReactNode;
  label: string;
  checked?: boolean;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role={checked === undefined ? "menuitem" : "menuitemradio"}
      aria-checked={checked}
      className={cx(styles.item, danger && styles.danger)}
      onClick={onClick}
    >
      <span className={styles.itemIcon} aria-hidden>{icon}</span>
      <span className={styles.itemLabel}>{label}</span>
      {checked && <Check size={14} className={styles.check} aria-hidden />}
    </button>
  );
}

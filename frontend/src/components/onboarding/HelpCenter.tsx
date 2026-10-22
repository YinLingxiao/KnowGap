"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { GUIDES_RESET_EVENT, checklistDismissKey, checklistDoneKey, resetCoachmarks } from "./coach";
import styles from "./HelpCenter.module.css";

export type HelpAction =
  | "explain" | "select" | "quiz" | "viva"
  | "review" | "graph" | "sheet" | "focus"
  | "plan" | "agenda" | "schedule"
  | "spotlight";

interface HelpCenterProps {
  desktop: boolean;
  userId: string;
  onClose: () => void;
  onTry: (action: HelpAction) => void;
}

const GROUPS: Array<{ title: string; items: Array<{ action: HelpAction; title: string; how: string; body: string }> }> = [
  {
    title: "学习",
    items: [
      { action: "explain", title: "讲一个概念", how: "在空间主对话里提问", body: "用一个例子把概念讲清楚。" },
      { action: "select", title: "划词追问", how: "选中回复里的一句话", body: "选中后可以追问、举例或存进笔记。" },
      { action: "quiz", title: "考一题", how: "发送「考考我」", body: "讲完就出一道小题检验。" },
      { action: "viva", title: "口试式追问", how: "输入 /viva", body: "让它顺着你的回答往下追问。" },
    ],
  },
  {
    title: "复习",
    items: [
      { action: "review", title: "闪回复习", how: "打开日程", body: "记过的误区会按时间回来复习。" },
      { action: "graph", title: "看薄弱点", how: "打开空间里的知识图谱", body: "误区和已掌握的概念会画在这里。" },
      { action: "sheet", title: "考前一页纸", how: "在空间顶栏打开", body: "把易错点和结论收成一页。" },
      { action: "focus", title: "开始专注", how: "点侧栏的专注", body: "计时结束后写下这一段的收获。" },
    ],
  },
  {
    title: "规划",
    items: [
      { action: "plan", title: "学习计划", how: "讲解时自动出现", body: "计划会跟着讲解往下推进。" },
      { action: "agenda", title: "记一条任务", how: "按 Q", body: "随手把要做的事记进日程。" },
      { action: "schedule", title: "让 AI 排期", how: "日程里点 AI 拆解排期", body: "把一件大事拆成几天能做完的小块。" },
    ],
  },
];

const KEYS = [
  ["Q", "记一条任务"],
  ["Alt+Space", "随时快问"],
  ["/", "技能与命令"],
  ["/viva", "口试式追问"],
  ["Esc", "关闭当前浮层"],
  ["Enter", "发送"],
];

export function HelpCenter({ desktop, userId, onClose, onTry }: HelpCenterProps) {
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const [position, setPosition] = useState({ left: 12, bottom: 56, maxHeight: 600 });

  useLayoutEffect(() => {
    const trigger = document.getElementById("help-trigger");
    const place = () => {
      const rect = trigger?.getBoundingClientRect();
      const bottom = rect ? window.innerHeight - rect.top + 8 : 56;
      setPosition({
        left: Math.max(12, Math.min(rect?.left ?? 12, window.innerWidth - 492)),
        bottom,
        maxHeight: Math.max(120, Math.min(680, window.innerHeight - bottom - 12)),
      });
    };
    place();
    panel.current?.focus();
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !panel.current?.contains(event.target) && !trigger?.contains(event.target)) {
        // Keep the dismissal click from taking focus away after cleanup restores it.
        event.preventDefault();
        close.current();
      }
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        close.current();
      }
    };
    document.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", keyboard, true);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("keydown", keyboard, true);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      trigger?.focus({ preventScroll: true });
    };
  }, []);

  return createPortal(
      <div ref={panel} id="help-panel" className={styles.panel} style={{ left: position.left, bottom: position.bottom, maxHeight: position.maxHeight }} role="dialog" aria-labelledby="help-title" tabIndex={-1}>
        <header>
          <h2 id="help-title">帮助</h2>
          <button type="button" onClick={onClose} aria-label="关闭帮助">关闭</button>
        </header>
        <div className={styles.body}>
          {GROUPS.map((group) => (
            <section key={group.title}>
              <h3>{group.title}</h3>
              <ul>
                {group.items.map((item) => (
                  <li key={item.action}>
                    <div>
                      <strong>{item.title}</strong>
                      <p>{item.body}</p>
                      <span>{item.how}</span>
                    </div>
                    <button type="button" onClick={() => onTry(item.action)}>试一试</button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {desktop && (
            <section>
              <h3>桌面端</h3>
              <ul>
                <li>
                  <div>
                    <strong>随时快问</strong>
                    <p>不离开当前页面，问一句就收起。</p>
                    <span>按 Alt+Space</span>
                  </div>
                  <button type="button" onClick={() => onTry("spotlight")}>试一试</button>
                </li>
              </ul>
            </section>
          )}
          <section>
            <h3>快捷键</h3>
            <table className={styles.keys}>
              <tbody>
                {KEYS.map(([key, label]) => (
                  <tr key={key}>
                    <th scope="row"><kbd>{key}</kbd></th>
                    <td>{label}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </div>
        <footer>
          <button
            type="button"
            onClick={() => {
              resetCoachmarks(userId);
              localStorage.removeItem(checklistDismissKey(userId));
              localStorage.removeItem(checklistDoneKey(userId));
              window.dispatchEvent(new Event(GUIDES_RESET_EVENT));
              onClose();
            }}
          >
            重新显示上手清单和提示
          </button>
        </footer>
      </div>,
    document.body,
  );
}

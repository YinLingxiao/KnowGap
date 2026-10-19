"use client";

import { useEffect, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import styles from "./ThemeToggle.module.css";

export type ThemeChoice = "system" | "light" | "dark";

const STORAGE_KEY = "knowgap.theme";
const CHANGE_EVENT = "knowgap:theme";
const NEXT: Record<ThemeChoice, ThemeChoice> = { system: "light", light: "dark", dark: "system" };
export const THEME_LABEL: Record<ThemeChoice, string> = { system: "跟随系统", light: "浅色", dark: "深色" };
export const THEME_ICON = { system: Monitor, light: Sun, dark: Moon } as const;

function readChoice(): ThemeChoice {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved === "light" || saved === "dark" ? saved : "system";
  } catch {
    return "system";
  }
}

function syncDesktopTheme(choice: ThemeChoice) {
  if (typeof window !== "undefined") {
    void window.knowgap?.setTheme?.(choice);
  }
}

function applyChoice(choice: ThemeChoice) {
  const root = document.documentElement;
  root.classList.add("theme-switching");
  if (choice === "system") delete root.dataset.theme;
  else root.dataset.theme = choice;
  syncDesktopTheme(choice);
  try {
    if (choice === "system") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, choice);
  } catch {
    // 浏览器存储不可用时只影响本次访问
  }
  window.setTimeout(() => root.classList.remove("theme-switching"), 260);
  window.dispatchEvent(new CustomEvent<ThemeChoice>(CHANGE_EVENT, { detail: choice }));
}

/** 当前主题选择；侧栏按钮与设置里的外观卡片共用，任一处修改另一处同步 */
export function useThemeChoice(): [ThemeChoice, (choice: ThemeChoice) => void] {
  const [choice, setChoice] = useState<ThemeChoice>("system");

  useEffect(() => {
    const initial = readChoice();
    setChoice(initial);
    syncDesktopTheme(initial);
    const onChange = (event: Event) => setChoice((event as CustomEvent<ThemeChoice>).detail);
    window.addEventListener(CHANGE_EVENT, onChange);
    return () => window.removeEventListener(CHANGE_EVENT, onChange);
  }, []);

  return [choice, applyChoice];
}

/** 主题切换：跟随系统 → 浅色 → 深色，选择保存在本机 */
export function ThemeToggle() {
  const [choice, setChoice] = useThemeChoice();

  const Icon = THEME_ICON[choice];
  const next = NEXT[choice];

  return (
    <button
      className={styles.toggle}
      onClick={() => setChoice(next)}
      aria-label={`主题：${THEME_LABEL[choice]}，点击切换为${THEME_LABEL[next]}`}
      title={`主题：${THEME_LABEL[choice]}（点击切换为${THEME_LABEL[next]}）`}
    >
      <Icon key={choice} size={15} className={styles.icon} aria-hidden />
    </button>
  );
}

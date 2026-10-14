"use client";

import { useEffect, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import styles from "./ThemeToggle.module.css";

type ThemeChoice = "system" | "light" | "dark";

const STORAGE_KEY = "knowgap.theme";
const NEXT: Record<ThemeChoice, ThemeChoice> = { system: "light", light: "dark", dark: "system" };
const LABEL: Record<ThemeChoice, string> = { system: "跟随系统", light: "浅色", dark: "深色" };
const ICON = { system: Monitor, light: Sun, dark: Moon } as const;

function readChoice(): ThemeChoice {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved === "light" || saved === "dark" ? saved : "system";
  } catch {
    return "system";
  }
}

function applyChoice(choice: ThemeChoice) {
  const root = document.documentElement;
  root.classList.add("theme-switching");
  if (choice === "system") delete root.dataset.theme;
  else root.dataset.theme = choice;
  try {
    if (choice === "system") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, choice);
  } catch {
    // 浏览器存储不可用时只影响本次访问
  }
  window.setTimeout(() => root.classList.remove("theme-switching"), 260);
}

/** 主题切换：跟随系统 → 浅色 → 深色，选择保存在本机 */
export function ThemeToggle() {
  const [choice, setChoice] = useState<ThemeChoice>("system");

  useEffect(() => setChoice(readChoice()), []);

  const Icon = ICON[choice];
  const next = NEXT[choice];

  return (
    <button
      className={styles.toggle}
      onClick={() => {
        applyChoice(next);
        setChoice(next);
      }}
      aria-label={`主题：${LABEL[choice]}，点击切换为${LABEL[next]}`}
      title={`主题：${LABEL[choice]}（点击切换为${LABEL[next]}）`}
    >
      <Icon key={choice} size={15} className={styles.icon} aria-hidden />
    </button>
  );
}

"use client";

import { useEffect, useState, type MouseEvent } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import styles from "./ThemeToggle.module.css";

export type ThemeChoice = "system" | "light" | "dark";

type ViewTransitionLike = {
  ready: Promise<void>;
  finished: Promise<void>;
};

type DocumentWithVT = Document & {
  startViewTransition?: (callback: () => void) => ViewTransitionLike;
};

const STORAGE_KEY = "knowgap.theme";
const CHANGE_EVENT = "knowgap:theme";
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

function isEffectiveDark(choice?: ThemeChoice): boolean {
  if (typeof window === "undefined") return true;
  const target = choice ?? (document.documentElement.dataset.theme as ThemeChoice | undefined) ?? "system";
  if (target === "dark") return true;
  if (target === "light") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function syncDesktopTheme(choice: ThemeChoice) {
  if (typeof window !== "undefined") {
    void window.knowgap?.setTheme?.(choice);
  }
}

function commitThemeDom(choice: ThemeChoice, syncDesktop = true) {
  const root = document.documentElement;
  if (choice === "system") delete root.dataset.theme;
  else root.dataset.theme = choice;
  if (syncDesktop) syncDesktopTheme(choice);
  try {
    if (choice === "system") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, choice);
  } catch {
    // 浏览器存储不可用时只影响本次访问
  }
  window.dispatchEvent(new CustomEvent<ThemeChoice>(CHANGE_EVENT, { detail: choice }));
}

function resolveOriginPoint(origin?: { x: number; y: number }): { x: number; y: number } {
  if (origin) return origin;
  if (typeof document !== "undefined") {
    // 页面上可能同时存在多个侧栏按钮（折叠的侧栏会被平移到视口外），只取真正可见的那个
    const buttons = document.querySelectorAll<HTMLElement>("[data-theme-toggle-btn]");
    for (const btn of buttons) {
      const rect = btn.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      if (rect.width > 0 && rect.height > 0 && x >= 0 && y >= 0 && x <= window.innerWidth && y <= window.innerHeight) {
        return { x, y };
      }
    }
  }
  return {
    x: 48,
    y: typeof window !== "undefined" ? window.innerHeight - 28 : 760,
  };
}

let transitionToken = 0;

function applyChoice(choice: ThemeChoice, origin?: { x: number; y: number }) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const wasDark = isEffectiveDark();
  const nextDark = isEffectiveDark(choice);
  const reducedMotion =
    root.dataset.motion === "reduced" || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const doc = document as DocumentWithVT;

  // 若视觉明暗未发生变化、或开启了减弱动态效果、或浏览器不支持 View Transitions，直接切换
  if (wasDark === nextDark || reducedMotion || typeof doc.startViewTransition !== "function") {
    root.classList.add("theme-switching");
    commitThemeDom(choice);
    window.setTimeout(() => root.classList.remove("theme-switching"), 260);
    return;
  }

  // 深色 -> 浅色 (expand)：新视图 (浅色) 从左下角按钮圆心 (x, y) 向外扩散 (0px -> maxRadius)
  // 浅色 -> 深色 (contract)：新视图 (深色) 采用 evenodd 环形裁剪，中间留出以 (x, y) 为圆心的透明圆洞，
  // 圆洞半径从 maxRadius 收缩到 0.01px —— 这样无论扩散还是收缩，永远只裁剪顶层的 ::view-transition-new(root)，
  // 底层的 ::view-transition-old(root) 永远保持 100% 无裁剪静止衬底，彻底根除 Chromium 裁剪旧快照导致的闪烁！
  const isContract = !wasDark && nextDark;
  const point = resolveOriginPoint(origin);
  const w = window.innerWidth;
  const h = window.innerHeight;
  const x = Math.round(Math.min(Math.max(point.x, 0), w));
  const y = Math.round(Math.min(Math.max(point.y, 0), h));
  const r = Math.ceil(Math.hypot(Math.max(x, w - x), Math.max(y, h - y))) + 4;

  // 外框矩形留余量，覆盖任何 DPI 舍入边界；终点圆洞取 0.5px 避免 Skia 在 0.01px 退化弧上产生末帧细分卡顿
  const pad = 16;
  const rectPath = `M -${pad} -${pad} H ${w + pad} V ${h + pad} H -${pad} Z`;
  const holeStart = `M ${x} ${y} m -${r} 0 a ${r} ${r} 0 1 0 ${r * 2} 0 a ${r} ${r} 0 1 0 -${r * 2} 0`;
  const holeEnd = `M ${x} ${y} m -0.5 0 a 0.5 0.5 0 1 0 1 0 a 0.5 0.5 0 1 0 -1 0`;

  const clipFrom = isContract
    ? `path(evenodd, "${rectPath} ${holeStart}")`
    : `circle(0px at ${x}px ${y}px)`;
  const clipTo = isContract
    ? `path(evenodd, "${rectPath} ${holeEnd}")`
    : `circle(${r}px at ${x}px ${y}px)`;

  root.style.setProperty("--vt-clip-from", clipFrom);
  root.dataset.vtDir = isContract ? "contract" : "expand";

  const token = ++transitionToken;
  const transition = doc.startViewTransition(() => {
    commitThemeDom(choice, false);
  });

  transition.ready
    .then(() => {
      if (token !== transitionToken) return;
      root.animate(
        {
          clipPath: [clipFrom, clipTo],
        },
        {
          duration: 400,
          // 扩散用轻快 ease-out；收缩用对称 ease-in-out，避免最后 50px 减速拖尾显得卡顿
          easing: isContract ? "cubic-bezier(0.4, 0, 0.2, 1)" : "cubic-bezier(0.25, 1, 0.5, 1)",
          fill: "both",
          pseudoElement: "::view-transition-new(root)",
        },
      );
    })
    .catch(() => {});

  transition.finished
    .catch(() => {})
    .finally(() => {
      syncDesktopTheme(choice);
      if (token !== transitionToken) return;
      delete root.dataset.vtDir;
      root.style.removeProperty("--vt-clip-from");
    });
}

/** 当前主题选择；侧栏按钮与设置里的外观卡片共用，任一处修改另一处同步 */
export function useThemeChoice(): [ThemeChoice, (choice: ThemeChoice, origin?: { x: number; y: number }) => void] {
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

/** 侧栏主题按钮：每次点击都在浅色 / 深色之间翻转（跟随系统时按当前实际明暗翻转），选择保存在本机 */
export function ThemeToggle() {
  const [choice, setChoice] = useThemeChoice();
  const [systemDark, setSystemDark] = useState(true);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    setSystemDark(media.matches);
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  const Icon = THEME_ICON[choice];
  const effectiveDark = choice === "dark" || (choice === "system" && systemDark);
  const next: ThemeChoice = effectiveDark ? "light" : "dark";

  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setChoice(next, {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    });
  };

  return (
    <button
      type="button"
      data-theme-toggle-btn="true"
      className={styles.toggle}
      onClick={handleClick}
      aria-label={`主题：${THEME_LABEL[choice]}，点击切换为${THEME_LABEL[next]}`}
      title={`主题：${THEME_LABEL[choice]}（点击切换为${THEME_LABEL[next]}）`}
    >
      <Icon key={choice} size={15} className={styles.icon} aria-hidden />
    </button>
  );
}

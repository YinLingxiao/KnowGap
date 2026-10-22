"use client";

import { useEffect, useState } from "react";

/**
 * 开发者模式：让 AI 读写本地工作区文件、执行命令的那组能力。
 * 面向学生默认关闭，只在「设置 → 开发者工具」里打开；关闭时输入框不再出现工作区与「帮我批准」。
 */
const KEY = "knowgap.devmode.v1";
export const DEV_MODE_EVENT = "knowgap:devmode";

export function readDevMode(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function writeDevMode(on: boolean) {
  try {
    if (on) localStorage.setItem(KEY, "1");
    else localStorage.removeItem(KEY);
  } catch {
    // 存储不可用时只影响本次会话
  }
  window.dispatchEvent(new CustomEvent<boolean>(DEV_MODE_EVENT, { detail: on }));
}

export function useDevMode(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    setOn(readDevMode());
    const sync = (event: Event) => setOn(Boolean((event as CustomEvent<boolean>).detail));
    window.addEventListener(DEV_MODE_EVENT, sync);
    return () => window.removeEventListener(DEV_MODE_EVENT, sync);
  }, []);
  return on;
}

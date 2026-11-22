"use client";

import { useEffect, useState } from "react";

type ShortcutBridge = Pick<NonNullable<NonNullable<Window["knowgap"]>["quick"]>, "shortcut">;

export function formatQuickShortcut(accelerator: string | null, platform: string): string | null {
  return accelerator?.replace("CommandOrControl", platform === "darwin" ? "Cmd" : "Ctrl") || null;
}

export async function readQuickShortcut(bridge: ShortcutBridge | undefined, platform: string): Promise<string | null> {
  try {
    return formatQuickShortcut(await bridge?.shortcut() ?? null, platform);
  } catch {
    return null;
  }
}

/** The shell registers the shortcut before loading either window. No guessed default. */
export function useQuickShortcut(): string | null {
  const [shortcut, setShortcut] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    const platform = window.knowgap?.windowChrome?.platform ?? (navigator.platform.startsWith("Mac") ? "darwin" : "win32");
    void readQuickShortcut(window.knowgap?.quick, platform).then((value) => {
      if (active) setShortcut(value);
    });
    return () => { active = false; };
  }, []);
  return shortcut;
}

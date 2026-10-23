"use client";

import { useEffect, useState } from "react";

export interface UpdateSettings {
  autoCheckUpdates: boolean;
  autoDownloadUpdates: boolean;
  autoInstallOnQuit: boolean;
  updateUrl: string;
}

export interface UpdateState {
  status: "idle" | "checking" | "available" | "downloading" | "downloaded" | "none" | "error";
  currentVersion: string;
  enabled: boolean;
  disabledReason: string;
  sourceFromEnv: boolean;
  version: string | null;
  progress: { percent: number; bytesPerSecond: number; transferred: number; total: number } | null;
  releaseNotes: string;
  error: string | null;
}

interface DesktopUpdateApi {
  getDesktopSettings: () => Promise<UpdateSettings>;
  setDesktopSettings: (patch: Partial<UpdateSettings>) => Promise<UpdateSettings>;
  updater: {
    getState: () => Promise<UpdateState>;
    check: (options?: { download?: boolean }) => Promise<UpdateState>;
    install: () => Promise<boolean>;
    onState: (listener: (state: UpdateState) => void) => () => void;
  };
}

// The legacy desktop bridge type lives in SettingsDialog. Keep this additive
// extension local so that file and other concurrent desktop work stay untouched.
export function desktopUpdateApi(): DesktopUpdateApi | null {
  if (typeof window === "undefined") return null;
  const api = window.knowgap as (typeof window.knowgap & Partial<DesktopUpdateApi>);
  return api?.updater && api.getDesktopSettings && api.setDesktopSettings ? api as DesktopUpdateApi : null;
}

export function useUpdaterState() {
  const [state, setState] = useState<UpdateState | null>(null);
  useEffect(() => {
    const api = desktopUpdateApi()?.updater;
    if (!api) return;
    let alive = true;
    let received = false;
    const unsubscribe = api.onState((next) => {
      received = true;
      if (alive) setState(next);
    });
    void api.getState().then((next) => {
      if (alive && !received) setState(next);
    }).catch(() => undefined);
    return () => { alive = false; unsubscribe(); };
  }, []);
  return state;
}

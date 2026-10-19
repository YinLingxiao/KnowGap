"use client";

import { useCallback, useEffect, useState } from "react";
import { ApiError } from "@/lib/api/errors";
import { DATA_SOURCE } from "@/lib/config";
import {
  DEMO_NAME_KEY, DEMO_USER, MODE_KEY, TOKEN_KEY, USER_KEY, AuthUser,
  fetchMe, loginByEmail, logoutRequest, readToken, registerByEmail, updateDisplayName,
} from "@/lib/api/auth";

export function useAuth() {
  const [status, setStatus] = useState<"loading" | "anonymous" | "ready">(DATA_SOURCE === "api" ? "loading" : "ready");
  const [user, setUser] = useState<AuthUser | null>(DATA_SOURCE === "api" ? null : DEMO_USER);
  const [error, setError] = useState("");

  const enterDemo = useCallback(() => {
    try {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.setItem(MODE_KEY, "demo");
    } catch { /* storage unavailable */ }
    const name = readDemoName();
    setUser({ ...DEMO_USER, displayName: name, avatarText: name.slice(0, 1) || "演" });
    setStatus("ready");
    setError("");
  }, []);

  const login = useCallback(async (email: string, credential: { password?: string; code?: string }) => {
    setError("");
    const res = await loginByEmail(email, credential);
    try {
      localStorage.setItem(TOKEN_KEY, res.token);
      localStorage.removeItem(MODE_KEY);
    } catch { /* ignore */ }
    setUser(res.user);
    setStatus("ready");
  }, []);

  const register = useCallback(async (email: string, password: string, displayName: string, code: string) => {
    setError("");
    const res = await registerByEmail(email, password, displayName, code);
    try {
      localStorage.setItem(TOKEN_KEY, res.token);
      localStorage.removeItem(MODE_KEY);
    } catch { /* ignore */ }
    setUser(res.user);
    setStatus("ready");
  }, []);

  const logout = useCallback(async () => {
    const token = readToken();
    try {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(MODE_KEY);
    } catch { /* storage unavailable */ }
    if (token) {
      try { await logoutRequest(); } catch { /* session already gone */ }
    }
    setUser(null);
    setStatus(DATA_SOURCE === "api" ? "anonymous" : "ready");
    if (DATA_SOURCE !== "api") setUser(DEMO_USER);
  }, []);

  const rename = useCallback(async (name: string) => {
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 30) throw new Error("昵称需要 1 到 30 个字。");
    if (DATA_SOURCE !== "api" || !readToken()) {
      try { localStorage.setItem(DEMO_NAME_KEY, trimmed); } catch { /* ignore */ }
      setUser((current) => current ? { ...current, displayName: trimmed, avatarText: trimmed.slice(0, 1) } : current);
      return;
    }
    setUser(await updateDisplayName(trimmed));
  }, []);

  useEffect(() => {
    if (DATA_SOURCE !== "api") return;
    const onExpired = () => {
      try { localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
      setUser(null);
      setStatus("anonymous");
      setError("登录已过期，请重新登录。");
    };
    window.addEventListener("knowgap:auth-expired", onExpired);
    let cancelled = false;
    void (async () => {
      if (readToken()) {
        try {
          const me = await fetchMe();
          if (cancelled) return;
          setUser(me);
          setStatus("ready");
          return;
        } catch (error) {
          if (!(error instanceof ApiError) || error.status !== 401) {
            if (!cancelled) {
              setError("无法确认登录状态，请确认后端已启动。");
              setStatus("anonymous");
            }
            return;
          }
          try { localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
        }
      }
      if (cancelled) return;
      if (localStorage.getItem(MODE_KEY) === "demo") {
        enterDemo();
        return;
      }
      setStatus("anonymous");
    })();
    return () => {
      cancelled = true;
      window.removeEventListener("knowgap:auth-expired", onExpired);
    };
  }, [enterDemo]);

  useEffect(() => {
    try {
      if (user) localStorage.setItem(USER_KEY, user.id);
      else localStorage.removeItem(USER_KEY);
    } catch { /* ignore */ }
  }, [user]);

  return { status, user, error, enterDemo, login, register, logout, rename };
}

function readDemoName(): string {
  try {
    return localStorage.getItem(DEMO_NAME_KEY)?.trim() || "演示学习者";
  } catch {
    return "演示学习者";
  }
}

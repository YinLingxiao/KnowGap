"use client";

import { useCallback, useEffect, useState } from "react";
import { DATA_SOURCE } from "@/lib/config";
import {
  DEMO_USER, USER_KEY, type AuthUser,
  deleteAvatar as deleteAvatarRequest, fetchMe, updateDisplayName, uploadAvatar as uploadAvatarRequest,
} from "@/lib/api/auth";

function rememberUserId(id: string) {
  try {
    localStorage.setItem(USER_KEY, id);
  } catch { /* storage unavailable */ }
}

export function useAuth() {
  const [status, setStatus] = useState<"loading" | "ready" | "error">(DATA_SOURCE === "api" ? "loading" : "ready");
  const [user, setUser] = useState<AuthUser | null>(DATA_SOURCE === "api" ? null : DEMO_USER);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (DATA_SOURCE !== "api") {
      rememberUserId(DEMO_USER.id);
      setUser(DEMO_USER);
      setStatus("ready");
      return;
    }
    setStatus("loading");
    setError("");
    try {
      const me = await fetchMe();
      rememberUserId(me.id);
      setUser(me);
      setStatus("ready");
    } catch {
      setError("无法连接后端服务，请确认后端已启动后重试。");
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const rename = useCallback(async (name: string) => {
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 30) throw new Error("称呼需要 1 到 30 个字。");
    if (DATA_SOURCE !== "api") {
      setUser((current) => current ? { ...current, displayName: trimmed, avatarText: trimmed.slice(0, 1) } : current);
      return;
    }
    const updated = await updateDisplayName(trimmed);
    rememberUserId(updated.id);
    setUser(updated);
  }, []);

  const uploadAvatar = useCallback(async (file: File) => {
    if (DATA_SOURCE !== "api") {
      const preview = URL.createObjectURL(file);
      setUser((current) => current ? { ...current, avatarUrl: preview } : current);
      return;
    }
    setUser(await uploadAvatarRequest(file));
  }, []);

  const removeAvatar = useCallback(async () => {
    if (DATA_SOURCE !== "api") {
      setUser((current) => current ? { ...current, avatarUrl: "" } : current);
      return;
    }
    setUser(await deleteAvatarRequest());
  }, []);

  return { status, user, error, retry: load, rename, uploadAvatar, removeAvatar };
}

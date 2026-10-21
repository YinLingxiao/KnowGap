"use client";

import { useEffect } from "react";
import { agendaApi } from "@/lib/agenda/api";
import { AGENDA_CHANGED_EVENT, FOCUS_START_EVENT } from "@/lib/agenda/types";
import type { AgendaTask, FocusStartDetail } from "@/lib/agenda/types";
import { reminderBody, reminderDelay, reminderKey, reminderTime } from "@/lib/agenda/reminders";

export function ReminderScheduler({ userId, subjects }: {
  userId: string;
  subjects: { id: string; name: string }[];
}) {
  useEffect(() => {
    if (!("Notification" in window)) return;
    const prefix = `knowgap:reminder:${userId}:`;
    const delivered = new Set<string>();
    const timers = new Set<ReturnType<typeof setTimeout>>();
    let disposed = false;
    let revision = 0;
    let needsPermission = false;
    let requesting = false;

    const wasDelivered = (key: string) => {
      try { if (localStorage.getItem(prefix + key)) delivered.add(key); } catch { /* in-memory fallback */ }
      return delivered.has(key);
    };
    const requestPermission = async () => {
      if (!needsPermission || requesting || Notification.permission !== "default") return;
      requesting = true;
      try { await Notification.requestPermission(); } catch { /* unsupported or denied: silent fallback */ }
      finally { requesting = false; }
    };
    const notify = async (task: AgendaTask, at: number, version: number) => {
      const key = reminderKey(task.id, at);
      if (disposed || version !== revision || wasDelivered(key)) return;
      try {
        // Revalidate before firing: completion, deletion and rescheduling cancel stale timers.
        const current = (await agendaApi.listTasks({ status: "open" })).find((item) => item.id === task.id);
        if (disposed || version !== revision || !current || reminderTime(current) !== at
          || reminderDelay(current, Date.now(), delivered) !== 0 || wasDelivered(key)
          || Notification.permission !== "granted") return;
        const notification = new Notification(current.title, {
          body: reminderBody(current, subjects.find((subject) => subject.id === current.subjectId)?.name),
          tag: prefix + key,
        });
        delivered.add(key);
        try { localStorage.setItem(prefix + key, "1"); } catch { /* session dedup still works */ }
        notification.onclick = () => {
          const desktop = (window as unknown as { knowgap?: { showMain?: () => void } }).knowgap;
          try { desktop?.showMain?.(); } finally {
            window.focus();
            window.dispatchEvent(new CustomEvent<FocusStartDetail>(FOCUS_START_EVENT, {
              detail: { taskId: current.id, title: current.title, subjectId: current.subjectId },
            }));
            notification.close();
          }
        };
      } catch { /* offline or unsupported notifications: next refresh retries within catch-up window */ }
    };
    const refresh = async () => {
      const version = ++revision;
      timers.forEach(clearTimeout);
      timers.clear();
      try {
        const tasks = await agendaApi.listTasks({ status: "open" });
        if (disposed || version !== revision) return;
        const now = Date.now();
        const pending = tasks.filter((task) => {
          const at = reminderTime(task);
          if (at !== null) wasDelivered(reminderKey(task.id, at));
          return reminderDelay(task, now, delivered) !== null;
        });
        needsPermission = pending.length > 0;
        await requestPermission();
        if (disposed || version !== revision || Notification.permission !== "granted") return;
        for (const task of pending) {
          const delay = reminderDelay(task, Date.now(), delivered);
          const at = reminderTime(task);
          if (delay === null || at === null) continue;
          timers.add(setTimeout(() => {
            // Web Locks prevent two open tabs from delivering the same reminder together.
            if (navigator.locks) void navigator.locks.request(prefix + reminderKey(task.id, at), () => notify(task, at, version));
            else void notify(task, at, version);
          }, delay));
        }
      } catch { /* no noisy errors for a background scheduler */ }
    };
    const visible = () => { if (document.visibilityState === "visible") void refresh(); };
    const gesture = () => {
      if (needsPermission && Notification.permission === "default" && !requesting) {
        void requestPermission().then(refresh);
      }
    };
    void refresh();
    const interval = setInterval(() => void refresh(), 60_000);
    window.addEventListener(AGENDA_CHANGED_EVENT, refresh);
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("pointerdown", gesture);
    window.addEventListener("keydown", gesture);
    return () => {
      disposed = true;
      clearInterval(interval);
      timers.forEach(clearTimeout);
      window.removeEventListener(AGENDA_CHANGED_EVENT, refresh);
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("pointerdown", gesture);
      window.removeEventListener("keydown", gesture);
    };
  }, [userId, subjects]);
  return null;
}

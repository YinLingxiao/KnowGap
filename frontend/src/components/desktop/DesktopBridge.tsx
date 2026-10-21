"use client";

import { useEffect } from "react";
import { agendaApi } from "@/lib/agenda/api";
import { AGENDA_CHANGED_EVENT, type AgendaFeed } from "@/lib/agenda/types";
import { getFocusSnapshot, remainingMs, subscribeFocus } from "@/lib/focus/store";

function focusLine() {
  const state = getFocusSnapshot();
  if (state.phase === "idle") return null;
  const total = Math.max(0, Math.ceil(remainingMs(state, Date.now()) / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  const clock = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  const title = state.title.trim() || "自由专注";
  return `专注中 ${clock} · ${title}`;
}

function countTodayOpen(feed: AgendaFeed) {
  const today = feed.today;
  if (!today) return 0;
  return feed.tasks.filter((task) => {
    if (task.status !== "open") return false;
    if (task.scheduledDate === today) return true;
    return Boolean(task.scheduledStartAt && task.scheduledStartAt.slice(0, 10) === today);
  }).length;
}

export function DesktopBridge() {
  useEffect(() => {
    const api = window.knowgap;
    if (!api?.setTrayStatus) return;

    let todayCount = 0;
    let timer = 0;
    let alive = true;

    const push = () => {
      void Promise.resolve(api.setTrayStatus?.({ focus: focusLine(), todayCount })).catch(() => undefined);
    };
    const arm = () => {
      window.clearInterval(timer);
      timer = 0;
      if (getFocusSnapshot().phase !== "idle") timer = window.setInterval(push, 1000);
    };
    const onFocus = () => {
      push();
      arm();
    };
    const load = () => {
      void agendaApi.feed().then((feed) => {
        if (!alive) return;
        todayCount = countTodayOpen(feed);
        push();
      }).catch(() => undefined);
    };

    const unsub = subscribeFocus(onFocus);
    onFocus();
    load();
    window.addEventListener(AGENDA_CHANGED_EVENT, load);
    const poll = window.setInterval(load, 30_000);
    return () => {
      alive = false;
      unsub();
      window.removeEventListener(AGENDA_CHANGED_EVENT, load);
      window.clearInterval(poll);
      window.clearInterval(timer);
    };
  }, []);

  return null;
}

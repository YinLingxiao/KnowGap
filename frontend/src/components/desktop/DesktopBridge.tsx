"use client";

import { useEffect } from "react";
import { agendaApi } from "@/lib/agenda/api";
import { AGENDA_CHANGED_EVENT, type AgendaFeed } from "@/lib/agenda/types";

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
    let alive = true;

    const push = () => {
      void Promise.resolve(api.setTrayStatus?.({ todayCount })).catch(() => undefined);
    };
    const load = () => {
      void agendaApi.feed().then((feed) => {
        if (!alive) return;
        todayCount = countTodayOpen(feed);
        push();
      }).catch(() => undefined);
    };

    push();
    load();
    window.addEventListener(AGENDA_CHANGED_EVENT, load);
    const poll = window.setInterval(load, 30_000);
    return () => {
      alive = false;
      window.removeEventListener(AGENDA_CHANGED_EVENT, load);
      window.clearInterval(poll);
    };
  }, []);

  return null;
}

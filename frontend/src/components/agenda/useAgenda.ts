"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toApiError, type ApiError } from "@/lib/api/errors";
import { agendaApi } from "@/lib/agenda/api";
import { formatYmd } from "@/lib/agenda/quickAdd";
import {
  AGENDA_CHANGED_EVENT, type AgendaTask, type AgendaThread, type TaskInput, type TaskPatch,
} from "@/lib/agenda/types";

export type AgendaStatus = "loading" | "ready" | "error";

export interface UseAgenda {
  status: AgendaStatus;
  error: ApiError | null;
  tasks: AgendaTask[];
  threads: AgendaThread[];
  today: string;
  reload: () => Promise<void>;
  create: (input: TaskInput) => Promise<AgendaTask | null>;
  update: (id: string, patch: TaskPatch) => Promise<AgendaTask | null>;
  remove: (id: string) => Promise<boolean>;
}

function notifyChanged() {
  window.dispatchEvent(new Event(AGENDA_CHANGED_EVENT));
}

/** 就地套用补丁，用于乐观更新；接口返回后会被服务端结果覆盖 */
function applyPatch(task: AgendaTask, patch: TaskPatch): AgendaTask {
  const next: AgendaTask = { ...task };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) (next as unknown as Record<string, unknown>)[key] = value;
  }
  if (patch.status === "done") next.completedAt = new Date().toISOString();
  if (patch.status === "open") next.completedAt = null;
  return next;
}

export function useAgenda(onFailure: (message: string) => void): UseAgenda {
  const [status, setStatus] = useState<AgendaStatus>("loading");
  const [error, setError] = useState<ApiError | null>(null);
  const [tasks, setTasks] = useState<AgendaTask[]>([]);
  const [threads, setThreads] = useState<AgendaThread[]>([]);
  const [today, setToday] = useState(() => formatYmd(new Date()));
  const sequence = useRef(0);
  const failure = useRef(onFailure);
  failure.current = onFailure;

  const reload = useCallback(async () => {
    const mine = ++sequence.current;
    try {
      // 带上今天的区间，已完成的任务才会出现在「今日已完成」里
      const local = formatYmd(new Date());
      const feed = await agendaApi.feed({ from: local, to: local });
      if (mine !== sequence.current) return;
      setTasks(feed.tasks);
      setThreads(feed.threads);
      setToday(feed.today || local);
      setError(null);
      setStatus("ready");
    } catch (cause) {
      if (mine !== sequence.current) return;
      setError(toApiError(cause));
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    void reload();
    const onChanged = () => void reload();
    window.addEventListener(AGENDA_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(AGENDA_CHANGED_EVENT, onChanged);
  }, [reload]);

  const create = useCallback(async (input: TaskInput) => {
    try {
      const task = await agendaApi.createTask(input);
      setTasks((items) => [...items, task]);
      notifyChanged();
      return task;
    } catch (cause) {
      failure.current(`创建失败：${toApiError(cause).message}`);
      return null;
    }
  }, []);

  const update = useCallback(async (id: string, patch: TaskPatch) => {
    let previous: AgendaTask[] = [];
    setTasks((items) => {
      previous = items;
      return items.map((item) => (item.id === id ? applyPatch(item, patch) : item));
    });
    try {
      const saved = await agendaApi.updateTask(id, patch);
      setTasks((items) => items.map((item) => (item.id === id ? saved : item)));
      notifyChanged();
      return saved;
    } catch (cause) {
      setTasks(previous);
      failure.current(`保存失败：${toApiError(cause).message}`);
      return null;
    }
  }, []);

  const remove = useCallback(async (id: string) => {
    try {
      await agendaApi.deleteTask(id);
      setTasks((items) => items.filter((item) => item.id !== id && item.parentId !== id));
      notifyChanged();
      return true;
    } catch (cause) {
      failure.current(`删除失败：${toApiError(cause).message}`);
      return false;
    }
  }, []);

  return { status, error, tasks, threads, today, reload, create, update, remove };
}

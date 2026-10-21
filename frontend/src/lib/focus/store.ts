import { agendaApi } from "@/lib/agenda/api";
import { AGENDA_CHANGED_EVENT } from "@/lib/agenda/types";
import { appendToSpacePages } from "@/lib/spacePages";
import { focusApi } from "./api";

const KEY = "knowgap.focus.v1";
const WRAP_MS = 30_000;

export type FocusPhase = "idle" | "running" | "paused" | "wrapup";

export interface FocusSnapshot {
  phase: FocusPhase;
  sessionId: string | null;
  taskId: string | null;
  subjectId: string | null;
  title: string;
  plannedSeconds: number;
  startedAt: number;
  accumulatedPauseMs: number;
  pausedAt: number | null;
  wrapupUntil: number | null;
  notified: boolean;
  presetSeconds: number;
  draftNote: string;
  completeTask: boolean;
}

const IDLE: FocusSnapshot = {
  phase: "idle",
  sessionId: null,
  taskId: null,
  subjectId: null,
  title: "",
  plannedSeconds: 25 * 60,
  startedAt: 0,
  accumulatedPauseMs: 0,
  pausedAt: null,
  wrapupUntil: null,
  notified: false,
  presetSeconds: 25 * 60,
  draftNote: "",
  completeTask: false,
};

let snapshot: FocusSnapshot = IDLE;
let hydrated = false;
let listening = false;
let pending = false;
let closing = false;
let endTimer = 0;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((listener) => listener());
}

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(snapshot));
  } catch { /* private mode */ }
}

function deadline(state: FocusSnapshot) {
  return state.startedAt + state.plannedSeconds * 1000 + state.accumulatedPauseMs;
}

export function remainingMs(state: FocusSnapshot, now: number) {
  if (state.phase === "idle") return state.presetSeconds * 1000;
  const end = state.phase === "paused" && state.pausedAt
    ? state.pausedAt
    : state.phase === "wrapup"
      ? deadline(state)
      : now;
  return Math.max(0, state.plannedSeconds * 1000 - Math.max(0, end - state.startedAt - state.accumulatedPauseMs));
}

function focusedSeconds(state: FocusSnapshot, now = Date.now()) {
  const end = state.phase === "paused" && state.pausedAt ? state.pausedAt : now;
  const ms = Math.max(0, end - state.startedAt - state.accumulatedPauseMs);
  return Math.min(state.plannedSeconds, Math.round(ms / 1000));
}

function notifyDone(title: string) {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  try {
    const note = new Notification("专注结束", { body: `${title} · 用一句话记下收获` });
    note.onclick = () => {
      window.focus();
      note.close();
    };
  } catch { /* notification unavailable */ }
}

function clearEndTimer() {
  window.clearTimeout(endTimer);
  endTimer = 0;
}

function enterWrapup() {
  if (snapshot.phase !== "running" && snapshot.phase !== "paused") return;
  const already = snapshot.notified;
  snapshot = {
    ...snapshot,
    phase: "wrapup",
    pausedAt: null,
    wrapupUntil: Date.now() + WRAP_MS,
    notified: true,
  };
  persist();
  emit();
  clearEndTimer();
  if (!already) notifyDone(snapshot.title);
}

function arm() {
  clearEndTimer();
  if (typeof window === "undefined" || snapshot.phase !== "running") return;
  const delay = deadline(snapshot) - Date.now();
  endTimer = window.setTimeout(() => {
    if (snapshot.phase === "running" && Date.now() >= deadline(snapshot) - 20) enterWrapup();
  }, Math.max(0, delay));
}

function onVisible() {
  if (document.visibilityState !== "visible") return;
  if (snapshot.phase === "running" && Date.now() >= deadline(snapshot)) enterWrapup();
}

function clockLabel(date = new Date()) {
  const h = String(date.getHours()).padStart(2, "0");
  const m = String(date.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

function read(): FocusSnapshot | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as Partial<FocusSnapshot>;
    const preset = data.presetSeconds === 15 * 60 || data.presetSeconds === 45 * 60 || data.presetSeconds === 10 || data.presetSeconds === 25 * 60
      ? data.presetSeconds
      : 25 * 60;
    const phase = data.phase === "running" || data.phase === "paused" || data.phase === "wrapup" ? data.phase : "idle";
    if (phase !== "idle" && typeof data.sessionId !== "string") return { ...IDLE, presetSeconds: preset };
    return {
      phase,
      sessionId: typeof data.sessionId === "string" ? data.sessionId : null,
      taskId: typeof data.taskId === "string" ? data.taskId : null,
      subjectId: typeof data.subjectId === "string" ? data.subjectId : null,
      title: typeof data.title === "string" && data.title ? data.title : "自由专注",
      plannedSeconds: typeof data.plannedSeconds === "number" && data.plannedSeconds > 0 ? data.plannedSeconds : preset,
      startedAt: typeof data.startedAt === "number" ? data.startedAt : Date.now(),
      accumulatedPauseMs: typeof data.accumulatedPauseMs === "number" ? data.accumulatedPauseMs : 0,
      pausedAt: typeof data.pausedAt === "number" ? data.pausedAt : null,
      wrapupUntil: typeof data.wrapupUntil === "number" ? data.wrapupUntil : null,
      notified: Boolean(data.notified),
      presetSeconds: preset,
      draftNote: typeof data.draftNote === "string" ? data.draftNote : "",
      completeTask: Boolean(data.completeTask),
    };
  } catch {
    return null;
  }
}

function reconcile() {
  if (snapshot.phase !== "running" && snapshot.phase !== "paused") return;
  const now = Date.now();
  const end = snapshot.phase === "paused" && snapshot.pausedAt ? snapshot.pausedAt : now;
  if (end - snapshot.startedAt - snapshot.accumulatedPauseMs >= snapshot.plannedSeconds * 1000) enterWrapup();
}

async function endCurrent(status: "completed" | "abandoned", note: string, sideEffects: boolean) {
  if (closing) return;
  const current = snapshot;
  if (!current.sessionId || current.phase === "idle") {
    snapshot = { ...IDLE, presetSeconds: current.presetSeconds };
    persist();
    emit();
    return;
  }
  closing = true;
  const seconds = focusedSeconds(current);
  try {
    await focusApi.end(current.sessionId, { status, note, actualSeconds: seconds });
  } catch (error) {
    closing = false;
    if (current.phase === "wrapup") {
      snapshot = { ...current, wrapupUntil: null };
      persist();
      emit();
    }
    throw error;
  }
  if (sideEffects) {
    if (current.completeTask && current.taskId) {
      try {
        await agendaApi.updateTask(current.taskId, { status: "done" });
        window.dispatchEvent(new Event(AGENDA_CHANGED_EVENT));
      } catch { /* 日程后端可能不在本分支 */ }
    }
    const harvest = note.replace(/\s+/g, " ").trim();
    if (current.subjectId && harvest) {
      appendToSpacePages(current.subjectId, `🍅 ${clockLabel()} ${current.title}：${harvest}`);
    }
  }
  clearEndTimer();
  snapshot = { ...IDLE, presetSeconds: current.presetSeconds };
  closing = false;
  persist();
  emit();
}

export function subscribeFocus(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getFocusSnapshot() {
  return snapshot;
}

export function getFocusServerSnapshot() {
  return IDLE;
}

export function hydrateFocus() {
  if (typeof window === "undefined") return;
  if (!hydrated) {
    hydrated = true;
    const loaded = read();
    if (loaded) snapshot = loaded;
    reconcile();
  }
  arm();
  if (!listening) {
    listening = true;
    document.addEventListener("visibilitychange", onVisible);
  }
}

export function selectPreset(seconds: number) {
  if (snapshot.phase !== "idle") return;
  snapshot = { ...snapshot, presetSeconds: seconds, plannedSeconds: seconds };
  persist();
  emit();
}

export async function startFocus(input: { title: string; subjectId: string | null; taskId: string | null; plannedSeconds?: number }) {
  if (pending || closing) return;
  pending = true;
  if (typeof Notification !== "undefined" && Notification.permission === "default") {
    void Notification.requestPermission().catch(() => undefined);
  }
  try {
    if (snapshot.phase !== "idle" && snapshot.sessionId) {
      await endCurrent("abandoned", "切换专注", false);
    }
    const plannedSeconds = input.plannedSeconds ?? snapshot.presetSeconds;
    const title = input.title.trim() || "自由专注";
    const session = await focusApi.start({
      title,
      plannedMinutes: plannedSeconds >= 60 ? Math.round(plannedSeconds / 60) : 0,
      taskId: input.taskId,
      subjectId: input.subjectId,
    });
    snapshot = {
      ...IDLE,
      phase: "running",
      sessionId: session.id,
      taskId: input.taskId,
      subjectId: input.subjectId,
      title,
      plannedSeconds,
      startedAt: Date.now(),
      presetSeconds: plannedSeconds === 10 || plannedSeconds === 15 * 60 || plannedSeconds === 45 * 60 || plannedSeconds === 25 * 60
        ? plannedSeconds
        : snapshot.presetSeconds,
    };
    persist();
    emit();
    arm();
  } finally {
    pending = false;
  }
}

export function pauseFocus() {
  if (snapshot.phase !== "running") return;
  snapshot = { ...snapshot, phase: "paused", pausedAt: Date.now() };
  persist();
  emit();
  clearEndTimer();
}

export function resumeFocus() {
  if (snapshot.phase !== "paused" || snapshot.pausedAt == null) return;
  snapshot = {
    ...snapshot,
    phase: "running",
    accumulatedPauseMs: snapshot.accumulatedPauseMs + (Date.now() - snapshot.pausedAt),
    pausedAt: null,
  };
  persist();
  emit();
  arm();
}

export function setWrapupDraft(patch: { draftNote?: string; completeTask?: boolean }) {
  const draftNote = patch.draftNote ?? snapshot.draftNote;
  const completeTask = patch.completeTask ?? snapshot.completeTask;
  if (draftNote === snapshot.draftNote && completeTask === snapshot.completeTask) return;
  snapshot = {
    ...snapshot,
    draftNote,
    completeTask,
    wrapupUntil: snapshot.phase === "wrapup" ? Date.now() + WRAP_MS : snapshot.wrapupUntil,
  };
  persist();
  emit();
}

export async function completeFocus() {
  await endCurrent("completed", snapshot.draftNote.trim(), true);
}

export async function abandonFocus(note?: string) {
  const text = (note ?? snapshot.draftNote).trim() || (snapshot.phase === "wrapup" ? "超时未结项" : "已放弃");
  await endCurrent("abandoned", text, false);
}

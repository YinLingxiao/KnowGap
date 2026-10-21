export interface FocusSession {
  id: string;
  studentId: string;
  taskId: string | null;
  subjectId: string | null;
  title: string;
  plannedMinutes: number;
  startedAt: string;
  endedAt: string | null;
  actualSeconds: number | null;
  status: "completed" | "abandoned" | null;
  note: string | null;
}

export interface HeatmapDay {
  date: string;
  focusMinutes: number;
  misconceptionsResolved: number;
  threadsResolved: number;
}

export interface FocusHeatmap {
  weeks: number;
  start: string;
  end: string;
  days: HeatmapDay[];
}

export const FOCUS_PRESETS = [
  { seconds: 15 * 60, label: "15" },
  { seconds: 25 * 60, label: "25" },
  { seconds: 45 * 60, label: "45" },
  { seconds: 10, label: "⚡ 10 秒" },
] as const;

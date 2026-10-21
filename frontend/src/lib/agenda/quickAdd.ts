/**
 * 快录解析器：把一行 zh-CN 输入拆成「标题 + 结构化字段 + 可取消的片段」。
 * 纯函数，不依赖运行环境；日期按 `now` 的本地时区计算，周以周一为一周的第一天。
 */
import type { TaskInput, TaskPriority } from "./types";

export type QuickAddChipKind = "date" | "time" | "duration" | "priority" | "deadline" | "subject" | "label";

export interface QuickAddSubject {
  id: string;
  name: string;
  color?: string;
}

export interface QuickAddToken {
  /** `${kind}:${raw}`，取消某个片段时用它做标识（文本前面被编辑后仍然有效） */
  key: string;
  kind: QuickAddChipKind;
  /** 输入框里的原文片段 */
  raw: string;
  start: number;
  end: number;
  /** Chip 上显示的文案 */
  label: string;
  /** subject 类 Chip 对应的空间 id */
  subjectId?: string;
  /** 提醒复用 time 类样式，避免破坏现有 QuickAdd 的 kind 映射。 */
  field?: "reminderMinutes";
}

export interface QuickAddFields {
  title: string;
  priority: TaskPriority;
  labels: string[];
  subjectId: string | null;
  scheduledDate: string | null;
  scheduledStartAt: string | null;
  durationMinutes: number | null;
  deadlineDate: string | null;
  reminderMinutes?: number | null;
}

export interface QuickAddResult {
  title: string;
  tokens: QuickAddToken[];
  fields: QuickAddFields;
}

const WEEK_CHARS = "一二三四五六日天";
const WEEK_LABELS = ["日", "一", "二", "三", "四", "五", "六"];
const RELATIVE_DAYS: Record<string, number> = {
  今天: 0, 今日: 0, 明天: 1, 明日: 1, 后天: 2, 大后天: 3,
};
const MAX_LABELS = 10;
const MAX_LABEL_LENGTH = 20;

const DATE_SRC = [
  "\\d{4}-\\d{1,2}-\\d{1,2}",
  "\\d{1,2}月\\d{1,2}[日号]",
  "(?:下周|下星期|下礼拜|本周|这周|周|星期|礼拜)[一二三四五六日天]",
  "大后天|后天|明天|今天|明日|今日",
  "本周末|这周末|周末",
  "\\d{1,2}号",
].join("|");

const PERIOD_SRC = "凌晨|清晨|早上|早晨|上午|中午|下午|傍晚|晚上|夜里|早|晚";
const CLOCK_SRC = "\\d{1,2}[:：]\\d{2}|\\d{1,2}点(?:\\s*(?:半|整)|\\s*\\d{1,2}分(?!钟))?";
const TIME_SRC = `(?:(${PERIOD_SRC})\\s*)?(?:(\\d{1,2})[:：](\\d{2})|(\\d{1,2})点(?:\\s*(半|整)|\\s*(\\d{1,2})分(?!钟))?)`;
const TIME_SUFFIX_SRC = `(?:\\s*(?:${PERIOD_SRC})?\\s*(?:${CLOCK_SRC}))?`;
const DURATION_SRC =
  "(\\d+)\\s*个半小时|半个?小时|(\\d+(?:\\.\\d+)?)\\s*个?小时(?:\\s*(\\d{1,3})\\s*分钟)?|(\\d{1,3})\\s*(?:分钟|mins?)(?![A-Za-z])";

const pad = (value: number) => String(value).padStart(2, "0");

export function formatYmd(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function validYmd(year: number, month: number, day: number): boolean {
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

/** 周一为 0，周日为 6 */
function mondayIndex(date: Date): number {
  return (date.getDay() + 6) % 7;
}

function resolveDate(raw: string, today: Date): Date | null {
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(raw);
  if (match) {
    const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
    return validYmd(year, month, day) ? new Date(year, month - 1, day) : null;
  }

  match = /^(\d{1,2})月(\d{1,2})[日号]$/.exec(raw);
  if (match) {
    const [month, day] = [Number(match[1]), Number(match[2])];
    const year = today.getFullYear();
    if (!validYmd(year, month, day)) return null;
    const candidate = new Date(year, month - 1, day);
    if (candidate >= today) return candidate;
    return validYmd(year + 1, month, day) ? new Date(year + 1, month - 1, day) : null;
  }

  match = /^(下周|下星期|下礼拜|本周|这周|周|星期|礼拜)([一二三四五六日天])$/.exec(raw);
  if (match) {
    const index = WEEK_CHARS.indexOf(match[2]);
    const target = index === 7 ? 6 : index;
    const todayIndex = mondayIndex(today);
    if (match[1].startsWith("下")) return addDays(today, 7 - todayIndex + target);
    if (match[1] === "本周" || match[1] === "这周") return addDays(today, target - todayIndex);
    return addDays(today, (target - todayIndex + 7) % 7);
  }

  if (raw in RELATIVE_DAYS) return addDays(today, RELATIVE_DAYS[raw]);
  if (/^(本周末|这周末|周末)$/.test(raw)) return addDays(today, Math.max(0, 5 - mondayIndex(today)));

  match = /^(\d{1,2})号$/.exec(raw);
  if (match) {
    const day = Number(match[1]);
    for (let offset = 0; offset <= 12; offset += 1) {
      const base = new Date(today.getFullYear(), today.getMonth() + offset, 1);
      if (!validYmd(base.getFullYear(), base.getMonth() + 1, day)) continue;
      const candidate = new Date(base.getFullYear(), base.getMonth(), day);
      if (candidate >= today) return candidate;
    }
  }
  return null;
}

function resolveTime(raw: string): { hour: number; minute: number } | null {
  const match = new RegExp(`^${TIME_SRC}$`).exec(raw);
  if (!match) return null;
  const period = match[1] ?? "";
  let hour: number;
  let minute: number;
  if (match[2] !== undefined) {
    hour = Number(match[2]);
    minute = Number(match[3]);
  } else {
    hour = Number(match[4]);
    minute = match[5] === "半" ? 30 : match[6] !== undefined ? Number(match[6]) : 0;
  }
  if (minute > 59) return null;

  if (period === "凌晨") {
    if (hour === 12) hour = 0;
  } else if (period === "中午") {
    if (hour >= 1 && hour <= 4) hour += 12;
  } else if (period === "下午" || period === "傍晚" || period === "晚上" || period === "夜里" || period === "晚") {
    if (hour === 12 && period !== "下午") return null;
    if (hour < 12) hour += 12;
  }
  return hour <= 23 ? { hour, minute } : null;
}

function resolveDuration(raw: string): number | null {
  let match = /^(\d+)\s*个半小时$/.exec(raw);
  let minutes: number;
  if (match) {
    minutes = Number(match[1]) * 60 + 30;
  } else if (/^半个?小时$/.test(raw)) {
    minutes = 30;
  } else if ((match = /^(\d+(?:\.\d+)?)\s*个?小时(?:\s*(\d{1,3})\s*分钟)?$/.exec(raw))) {
    minutes = Math.round(Number(match[1]) * 60) + (match[2] ? Number(match[2]) : 0);
  } else if ((match = /^(\d{1,3})\s*(?:分钟|mins?)$/.exec(raw))) {
    minutes = Number(match[1]);
  } else {
    return null;
  }
  return Number.isInteger(minutes) && minutes >= 5 && minutes <= 720 ? minutes : null;
}

function dateLabel(date: Date, today: Date): string {
  const diff = Math.round((date.getTime() - today.getTime()) / 86_400_000);
  if (diff === 0) return "今天";
  if (diff === 1) return "明天";
  return `${date.getMonth() + 1}月${date.getDate()}日 周${WEEK_LABELS[date.getDay()]}`;
}

function durationLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} 分钟`;
  const rest = minutes % 60;
  return rest ? `${Math.floor(minutes / 60)} 小时 ${rest} 分钟` : `${minutes / 60} 小时`;
}

interface Match {
  raw: string;
  start: number;
  end: number;
}

function matchesOf(sources: string[], flags: string, text: string): Match[] {
  const found: Match[] = [];
  for (const source of sources) {
    const pattern = new RegExp(source, flags.includes("g") ? flags : `${flags}g`);
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text))) {
      if (!match[0]) {
        pattern.lastIndex += 1;
        continue;
      }
      found.push({ raw: match[0], start: match.index, end: match.index + match[0].length });
    }
  }
  return found.sort((a, b) => a.start - b.start || b.end - a.end);
}

const isDigit = (char: string) => /[0-9]/.test(char);
const isAscii = (char: string) => /[A-Za-z0-9]/.test(char);

/**
 * 解析快录文本。
 * @param ignored 被用户取消的片段（`QuickAddToken.key`），它们会原样留在标题里。
 */
export function parseQuickAdd(
  text: string,
  now: Date,
  subjects: QuickAddSubject[] = [],
  ignored: Iterable<string> = [],
): QuickAddResult {
  const skip = new Set(ignored);
  const today = startOfDay(now);
  const tokens: QuickAddToken[] = [];
  const taken = new Set<QuickAddChipKind>();
  // 被取消的复合片段（如「截止周五」）仍占着位置，避免其中的日期被当成别的字段再次解析
  const reserved: Match[] = [];
  const overlaps = (match: Match) =>
    tokens.some((token) => match.start < token.end && token.start < match.end)
    || reserved.some((item) => match.start < item.end && item.start < match.end);
  const before = (match: Match) => (match.start > 0 ? text[match.start - 1] : "");
  const after = (match: Match) => (match.end < text.length ? text[match.end] : "");

  const accept = (
    kind: QuickAddChipKind, match: Match, label: string, extra: Partial<QuickAddToken> = {},
  ): boolean => {
    tokens.push({ key: `${kind}:${match.raw}`, kind, raw: match.raw, start: match.start, end: match.end, label, ...extra });
    return true;
  };
  const usable = (kind: QuickAddChipKind, match: Match, single = true) =>
    !(single && taken.has(kind)) && !skip.has(`${kind}:${match.raw}`) && !overlaps(match);

  let deadlineDate: string | null = null;
  let scheduledDate: Date | null = null;
  let clock: { hour: number; minute: number } | null = null;
  let durationMinutes: number | null = null;
  let priority: TaskPriority = 4;
  let subjectId: string | null = null;
  const labels: string[] = [];
  let reminderMinutes: number | undefined;

  // 先占住完整提醒短语，取消或不支持的提醒也不能误识别成任务时长。
  for (const match of matchesOf(["提醒我?\\s*(?:提前\\s*\\d+\\s*(?:分钟|小时|天)|准时)"], "", text)) {
    const key = `time:${match.raw}`;
    const value = /准时/.test(match.raw) ? 0 : (() => {
      const part = /(\d+)\s*(分钟|小时|天)/.exec(match.raw)!;
      return Number(part[1]) * (part[2] === "天" ? 1440 : part[2] === "小时" ? 60 : 1);
    })();
    if (skip.has(key) || reminderMinutes !== undefined || ![0, 5, 10, 15, 30, 60, 120, 1440].includes(value)) {
      reserved.push(match);
      continue;
    }
    reminderMinutes = value;
    accept("time", match, value === 0 ? "准时提醒" : `提前 ${value} 分钟提醒`, { field: "reminderMinutes" });
  }

  // 1. 截止日：「截止X」「ddl X」「X前」，其中可带一个时间，截止日只取日期
  const deadlineSources = [
    `(?:截止日期|截止|ddl|deadline)\\s*(?:是|为|于|到|:|：)?\\s*(?:${DATE_SRC})${TIME_SUFFIX_SRC}`,
    `(?:${DATE_SRC})${TIME_SUFFIX_SRC}\\s*前`,
  ];
  for (const match of matchesOf(deadlineSources, "i", text)) {
    if (overlaps(match)) continue;
    if (skip.has(`deadline:${match.raw}`)) {
      reserved.push(match);
      continue;
    }
    if (taken.has("deadline")) continue;
    const dateMatch = new RegExp(DATE_SRC).exec(match.raw);
    const date = dateMatch ? resolveDate(dateMatch[0], today) : null;
    if (!date) continue;
    deadlineDate = formatYmd(date);
    taken.add("deadline");
    accept("deadline", match, `截止 ${dateLabel(date, today)}`);
  }

  // 2. #标签 / #空间名
  for (const match of matchesOf(["#[^\\s#，。,；;！!？?、]+"], "", text)) {
    const name = match.raw.slice(1);
    if (isAscii(before(match)) || name.length > MAX_LABEL_LENGTH || !usable("label", match, false)) continue;
    const subject: QuickAddSubject | undefined = subjectId === null
      ? subjects.find((item) => item.name.toLowerCase() === name.toLowerCase())
      : undefined;
    if (subject) {
      subjectId = subject.id;
      accept("subject", match, `#${subject.name}`, { subjectId: subject.id, key: `label:${match.raw}` });
    } else if (labels.length < MAX_LABELS && !labels.includes(name)) {
      labels.push(name);
      accept("label", match, `#${name}`);
    }
  }

  // 3. 优先级 p1~p4
  for (const match of matchesOf(["[pP][1-4]"], "", text)) {
    if (isAscii(before(match)) || isAscii(after(match)) || !usable("priority", match)) continue;
    priority = Number(match.raw[1]) as TaskPriority;
    taken.add("priority");
    accept("priority", match, `P${priority}`);
  }

  // 4. 时间点
  for (const match of matchesOf([TIME_SRC], "", text)) {
    if (!usable("time", match) || isDigit(before(match)) || /[:：.]/.test(before(match))) continue;
    const time = resolveTime(match.raw);
    if (!time) continue;
    clock = time;
    taken.add("time");
    accept("time", match, `${pad(time.hour)}:${pad(time.minute)}`);
  }

  // 5. 时长
  for (const match of matchesOf([DURATION_SRC], "", text)) {
    if (!usable("duration", match) || isDigit(before(match))) continue;
    const minutes = resolveDuration(match.raw);
    if (minutes === null) continue;
    durationMinutes = minutes;
    taken.add("duration");
    accept("duration", match, durationLabel(minutes));
  }

  // 6. 计划日期
  for (const match of matchesOf([DATE_SRC], "", text)) {
    if (!usable("date", match)) continue;
    const prev = before(match);
    if (isDigit(prev)) continue;
    if (/^(?:下周|下星期|下礼拜|本周|这周|周|星期|礼拜)/.test(match.raw) && /[上每]/.test(prev)) continue;
    if (/^\d{1,2}号$/.test(match.raw) && /[楼线门口院]/.test(after(match))) continue;
    const date = resolveDate(match.raw, today);
    if (!date) continue;
    scheduledDate = date;
    taken.add("date");
    accept("date", match, dateLabel(date, today));
  }

  tokens.sort((a, b) => a.start - b.start);

  let cursor = 0;
  let rest = "";
  for (const token of tokens) {
    rest += text.slice(cursor, token.start);
    cursor = token.end;
  }
  rest += text.slice(cursor);
  const title = rest.replace(/\s+/g, " ").replace(/^[\s，,、；;:：]+|[\s，,、；;:：]+$/g, "");

  const scheduledYmd = scheduledDate ? formatYmd(scheduledDate) : clock ? formatYmd(today) : null;
  return {
    title,
    tokens,
    fields: {
      title,
      priority,
      labels,
      subjectId,
      scheduledDate: scheduledYmd,
      scheduledStartAt: scheduledYmd && clock ? `${scheduledYmd}T${pad(clock.hour)}:${pad(clock.minute)}` : null,
      durationMinutes,
      deadlineDate,
      ...(reminderMinutes !== undefined ? { reminderMinutes } : {}),
    },
  };
}

/** 转成 createTask 的入参：没有值的字段不发送 */
export function quickAddToInput(fields: QuickAddFields): TaskInput {
  const input: TaskInput = { title: fields.title.slice(0, 200), priority: fields.priority };
  if (fields.labels.length) input.labels = fields.labels;
  if (fields.subjectId) input.subjectId = fields.subjectId;
  if (fields.scheduledDate) input.scheduledDate = fields.scheduledDate;
  if (fields.scheduledStartAt) input.scheduledStartAt = fields.scheduledStartAt;
  if (fields.durationMinutes !== null) input.durationMinutes = fields.durationMinutes;
  if (fields.deadlineDate) input.deadlineDate = fields.deadlineDate;
  if (fields.reminderMinutes != null) input.reminderMinutes = fields.reminderMinutes;
  return input;
}

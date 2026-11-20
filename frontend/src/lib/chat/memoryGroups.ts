// 记忆页的分组：把 USER / MEMORY 笔记和知识点记忆整理成「标题 · 一行概要 · 详情」的列表行。
// 只做数据整理，文案翻译留给组件。

export type UserGroupId = "profile" | "preferences" | "goals";
export type MemoryGroupId = UserGroupId | "environment" | `topic:${string}`;
export type MemoryState = "review" | "improving" | "mastered";

export interface MemoryRow {
  id: MemoryGroupId;
  /** 详情条目：笔记去掉 [Layer] 前缀后的原文；知识点为 topic + summary + 状态 */
  details: string[];
  updatedAt: string | null;
}

export interface TopicRow extends MemoryRow {
  subjectId: string | null;
  points: Array<{ id: string; topic: string; summary: string; state: MemoryState }>;
}

interface TopicMemory {
  id: string;
  kind: string;
  topic: string;
  summary: string;
  status: string;
  subjectId: string | null;
  updatedAt: string;
}

const LAYER_PREFIX_RE = /^\[(Identity|Preference|Context|Activity|Experience)\]\s*/i;
const NAME_RE = /^称呼[：:]/;

export function splitEntries(content: string): string[] {
  return content.split(/\s*§\s*/).map((item) => item.trim()).filter(Boolean);
}

export function stripLayer(entry: string): string {
  return entry.replace(LAYER_PREFIX_RE, "").trim();
}

export function userGroupOf(entry: string): UserGroupId {
  const explicit = LAYER_PREFIX_RE.exec(entry)?.[1]?.toLowerCase();
  if (explicit === "identity") return "profile";
  if (explicit === "context" || explicit === "activity") return "goals";
  if (explicit === "preference" || explicit === "experience") return "preferences";
  const body = stripLayer(entry);
  if (/^(称呼|先验技能|常学领域|身份|专业|年级|技能栈)/.test(body)) return "profile";
  if (/^(阶段目标|背景约束|近期动态|阶段复盘|目标|截止|约束|考试|最近|本周|正在学习|正在准备)/.test(body)) return "goals";
  return "preferences";
}

export function memoryState(memory: Pick<TopicMemory, "kind" | "status">): MemoryState {
  if (memory.kind === "mastery" || memory.status === "resolved") return "mastered";
  if (memory.status === "improving") return "improving";
  return "review";
}

export function latestIso(items: Array<string | null | undefined>): string | null {
  let best: string | null = null;
  let bestTime = 0;
  for (const iso of items) {
    const time = iso ? Date.parse(iso) : Number.NaN;
    if (!Number.isNaN(time) && time > bestTime) {
      bestTime = time;
      best = iso ?? null;
    }
  }
  return best;
}

/** 关于你的三行：基础档案总在，其余没有内容就不出现 */
export function userRows(userNotes: string[], updatedAt: string | null): MemoryRow[] {
  const ids: UserGroupId[] = ["profile", "preferences", "goals"];
  return ids
    .map((id) => ({ id, details: userNotes.filter((entry) => userGroupOf(entry) === id).map(stripLayer), updatedAt }))
    .filter((row) => row.id === "profile" || row.details.length > 0);
}

export function environmentRow(memoryNotes: string[], updatedAt: string | null): MemoryRow | null {
  return memoryNotes.length ? { id: "environment", details: memoryNotes.map(stripLayer), updatedAt } : null;
}

/** 学习主题：按空间分组（顺序跟空间列表一致），没有空间的知识点归到通用，排在最后 */
export function topicRows(memories: TopicMemory[], subjectIds: string[]): TopicRow[] {
  const grouped = new Map<string | null, TopicMemory[]>();
  for (const memory of memories) {
    if (memory.kind === "preference") continue;
    const list = grouped.get(memory.subjectId) ?? [];
    list.push(memory);
    grouped.set(memory.subjectId, list);
  }
  const order: Array<string | null> = [...subjectIds.filter((id) => grouped.has(id)), ...(grouped.has(null) ? [null] : [])];
  return order.map((subjectId) => {
    const items = [...(grouped.get(subjectId) ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const points = items.map((item) => ({ id: item.id, topic: item.topic, summary: item.summary, state: memoryState(item) }));
    return {
      id: `topic:${subjectId ?? "general"}` as const,
      subjectId,
      points,
      details: points.map((point) => point.topic),
      updatedAt: latestIso(items.map((item) => item.updatedAt)),
    };
  });
}

/** 删掉一组后剩下的 USER 笔记；称呼保留，它跟个人资料里的名字是同一个 */
export function userNotesWithout(group: UserGroupId, userNotes: string[]): string[] {
  return userNotes.filter((entry) => userGroupOf(entry) !== group || (group === "profile" && NAME_RE.test(stripLayer(entry))));
}

/**
 * 学习空间里的记忆边界。
 *
 * 后端已经按 learner_memories.subject_id 隔离：空间对话只召回本空间 + 通用记忆，通用对话不召回任何
 * 空间记忆。前端这里补最后一道：进入某个空间后，记忆抽屉不再提供「全部」视图，避免把其他空间的
 * 记忆混在当前空间里展示。
 */

export type MemoryScopeFilter = "all" | "general" | "subject" | "focused";

/**
 * 空间内给「本空间」「通用」；如果聚焦的记忆属于其他空间，再临时给「聚焦记忆」，
 * 避免记忆改过归属后从原对话点进来却看不到。全局记忆页才给「全部」。
 */
export function memoryScopeFilters(hasContext: boolean, hasForeignFocus = false): MemoryScopeFilter[] {
  if (!hasContext) return ["all", "general"];
  return hasForeignFocus ? ["focused", "subject", "general"] : ["subject", "general"];
}

/** 默认落在本空间；聚焦通用记忆时落在「通用」，聚焦其他空间记忆时临时落在「聚焦记忆」。 */
export function defaultMemoryScopeFilter(
  hasContext: boolean, focusedSubjectId?: string | null, contextSubjectId?: string | null,
): MemoryScopeFilter {
  if (!hasContext) return "all";
  if (focusedSubjectId === null) return "general";
  if (focusedSubjectId && contextSubjectId && focusedSubjectId !== contextSubjectId) return "focused";
  return "subject";
}

/** 当前筛选下这条记忆是否可见。 */
export function memoryMatchesScope(
  memory: { id?: string; subjectId: string | null },
  filter: MemoryScopeFilter,
  contextSubjectId: string | null,
  focusedIds: readonly string[] = [],
): boolean {
  if (filter === "all") return true;
  if (filter === "general") return memory.subjectId === null;
  if (filter === "focused") return Boolean(memory.id && focusedIds.includes(memory.id));
  return Boolean(contextSubjectId) && memory.subjectId === contextSubjectId;
}

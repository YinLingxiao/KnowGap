/**
 * 学习空间里的记忆边界。
 *
 * 后端已经按 learner_memories.subject_id 隔离：空间对话只召回本空间 + 通用记忆，通用对话不召回任何
 * 空间记忆。前端这里补最后一道：进入某个空间后，记忆抽屉不再提供「全部」视图，避免把其他空间的
 * 记忆混在当前空间里展示。
 */

export type MemoryScopeFilter = "all" | "general" | "subject";

/** 空间内只给「本空间」「通用」；全局记忆页才给「全部」。 */
export function memoryScopeFilters(hasContext: boolean): MemoryScopeFilter[] {
  return hasContext ? ["subject", "general"] : ["all", "general"];
}

/** 默认落在本空间；如果聚焦的是一条通用记忆，则落在「通用」。 */
export function defaultMemoryScopeFilter(hasContext: boolean, focusedSubjectId?: string | null): MemoryScopeFilter {
  if (!hasContext) return "all";
  return focusedSubjectId === null ? "general" : "subject";
}

/** 当前筛选下这条记忆是否可见。 */
export function memoryMatchesScope(
  memory: { subjectId: string | null },
  filter: MemoryScopeFilter,
  contextSubjectId: string | null,
): boolean {
  if (filter === "all") return true;
  if (filter === "general") return memory.subjectId === null;
  return Boolean(contextSubjectId) && memory.subjectId === contextSubjectId;
}

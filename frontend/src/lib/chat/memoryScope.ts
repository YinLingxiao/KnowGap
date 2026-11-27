/**
 * 学习空间里的记忆边界。
 *
 * 后端已经按 learner_memories.subject_id 隔离：空间对话只召回本空间 + 通用记忆，通用对话不召回任何
 * 空间记忆。前端这里补最后一道：进入某个空间后，记忆抽屉不再提供「全部」视图，避免把其他空间的
 * 记忆混在当前空间里展示。
 */

export type MemoryScopeFilter = "all" | "general" | "subject" | "focused";
export type FocusedMemoryScope = "none" | "subject" | "general" | "mixed";

/**
 * 汇总当前聚焦的所有记忆落在哪些范围里（与 memories 数组顺序无关）：
 * - none：没有匹配到聚焦记忆
 * - subject：全部属于当前空间
 * - general：全部属于通用记忆
 * - mixed：包含其他空间记忆，或跨了多个范围（如本空间 + 通用）
 */
export function classifyFocusedMemories(
  contextSubjectId: string | null,
  memories: ReadonlyArray<{ id?: string; subjectId: string | null }>,
  focusIds: readonly string[],
): FocusedMemoryScope {
  if (!contextSubjectId || !focusIds.length) return "none";
  let hasSubject = false;
  let hasGeneral = false;
  for (const memory of memories) {
    if (!memory.id || !focusIds.includes(memory.id)) continue;
    if (memory.subjectId === null) {
      hasGeneral = true;
    } else if (memory.subjectId === contextSubjectId) {
      hasSubject = true;
    } else {
      return "mixed";
    }
    if (hasSubject && hasGeneral) return "mixed";
  }
  if (hasSubject) return "subject";
  if (hasGeneral) return "general";
  return "none";
}

/**
 * 空间内给「本空间」「通用」；如果聚焦的记忆跨了范围或包含其他空间记忆，再临时给「聚焦记忆」，
 * 保证全部聚焦记忆都能一次看到，且不会混入未聚焦的其他空间记忆。全局记忆页才给「全部」。
 */
export function memoryScopeFilters(inSpace: boolean, focusedScope: FocusedMemoryScope = "none"): MemoryScopeFilter[] {
  if (!inSpace) return ["all", "general"];
  return focusedScope === "mixed" ? ["focused", "subject", "general"] : ["subject", "general"];
}

/** 默认落在本空间；全部聚焦通用记忆时落在「通用」，跨范围或含其他空间记忆时临时落在「聚焦记忆」。 */
export function defaultMemoryScopeFilter(
  inSpace: boolean,
  focusedScope: FocusedMemoryScope = "none",
): MemoryScopeFilter {
  if (!inSpace) return "all";
  if (focusedScope === "general") return "general";
  if (focusedScope === "mixed") return "focused";
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

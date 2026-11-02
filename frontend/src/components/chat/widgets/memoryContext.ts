/** 卡片读取学习记忆用的 context；MessageList 在 WidgetScopeContext 内侧提供。 */

import { createContext, useContext } from "react";
import type { LearnerMemory } from "@/lib/chat/types";

export const MemoriesByIdContext = createContext<Record<string, LearnerMemory>>({});

export function useMemoriesById(): Record<string, LearnerMemory> {
  return useContext(MemoriesByIdContext);
}

/** 卡片侧改动了学习记录（如微测作答写入记忆）后派发，供外层重新拉取记忆列表 */
export const MEMORY_CHANGED_EVENT = "knowgap:memory-changed";

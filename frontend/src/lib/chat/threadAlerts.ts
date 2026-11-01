import type { ConversationSummary } from "./types";

/**
 * 支线入口是否需要红点：只看未解决、且在等你或执行失败的支线。
 * 已解决的支线会保留最后一轮的 waiting/failed 状态，不能算进来，否则红点永远消不掉。
 */
export function hasThreadsNeedingAttention(
  threads: Pick<ConversationSummary, "threadStatus" | "executionStatus">[],
): boolean {
  return threads.some((item) => item.threadStatus !== "resolved"
    && (item.executionStatus === "waiting" || item.executionStatus === "failed"));
}

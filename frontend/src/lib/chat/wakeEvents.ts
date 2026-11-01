import type { ChatMessage } from "./types";

export function latestPlanChangeId(
  messages: readonly Pick<ChatMessage, "id" | "planChanges">[],
): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const changes = messages[index].planChanges;
    if (Array.isArray(changes) && changes.length > 0) return messages[index].id;
  }
  return null;
}

export function isHiddenSystemMessage(
  message: Pick<ChatMessage, "role" | "systemEvent" | "status" | "content" | "replyTo">,
  eventIds: ReadonlySet<string>,
): boolean {
  if (message.role === "user" && message.systemEvent) return true;
  const replyTo = message.replyTo;
  if (message.status !== "streaming" || message.content !== "" || !replyTo) return false;
  return eventIds.has(replyTo);
}

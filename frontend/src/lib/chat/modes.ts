import type { MessageKey } from "@/lib/i18n/messages";

export type ChatMode = "explain" | "solve" | "practice" | "plan" | "research" | "organize" | "review";

export const CHAT_MODE_OPTIONS = [
  { id: "explain", labelKey: "chat.mode.explain" },
  { id: "solve", labelKey: "chat.mode.solve" },
  { id: "practice", labelKey: "chat.mode.practice" },
  { id: "plan", labelKey: "chat.mode.plan" },
  { id: "research", labelKey: "chat.mode.research" },
  { id: "organize", labelKey: "chat.mode.organize" },
  { id: "review", labelKey: "chat.mode.review" },
] as const satisfies ReadonlyArray<{ id: ChatMode; labelKey: MessageKey }>;
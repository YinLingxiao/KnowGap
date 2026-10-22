export const COACH_IDS = ["thread", "sheet", "fog", "slash", "spotlight", "select", "plan", "agenda"] as const;
export type CoachId = (typeof COACH_IDS)[number];

export const COACH_COPY: Record<CoachId, string> = {
  thread: "复杂卡点在右侧支线展开，结论回到主线",
  sheet: "薄弱点够了，试试考前一页纸",
  fog: "看看你的知识迷雾图",
  slash: "输入 / 选技能，比如 /viva 模拟复试",
  spotlight: "Alt+Space 随时快问",
  select: "选中一句话，可以追问、举例或存进笔记",
  plan: "这是这段学习的计划，会随讲解推进",
  agenda: "按 Q 随手记，或让 AI 排",
};

export const LEGACY_COACH_IDS = ["spotlight", "select", "plan", "agenda"] as const;

export function coachSeenKey(userId: string, id: CoachId) {
  return `knowgap.coach.seen.${userId}.${id}`;
}

export function coachSessionKey(userId: string) {
  return `knowgap.coach.session.${userId}`;
}

export function resetCoachmarks(userId: string) {
  for (const id of COACH_IDS) localStorage.removeItem(coachSeenKey(userId, id));
  sessionStorage.removeItem(coachSessionKey(userId));
}

export function checklistDismissKey(userId: string) {
  return `knowgap.checklist.dismiss.${userId}`;
}

export function checklistDoneKey(userId: string) {
  return `knowgap.checklist.done.${userId}`;
}

export function cheatsheetSeenKey(userId: string) {
  return `knowgap.checklist.sheet.${userId}`;
}

export const GUIDES_RESET_EVENT = "knowgap:guides-reset";
export const CHEATSHEET_OPENED_EVENT = "knowgap:cheatsheet-opened";
export const OPEN_SPACE_PANEL_EVENT = "knowgap:open-space-panel";

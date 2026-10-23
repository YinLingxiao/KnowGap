export type TextSize = "small" | "medium" | "large";
export type ChatWidth = "narrow" | "medium" | "wide" | "full";
export type MotionChoice = "system" | "reduced";

export interface Appearance {
  textSize: TextSize;
  width: ChatWidth;
  motion: MotionChoice;
}

const DEFAULTS: Appearance = { textSize: "medium", width: "medium", motion: "system" };

function key(userId: string) {
  return `${userId}:knowgap.appearance.v1`;
}

export function readAppearance(userId: string): Appearance {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key(userId)) ?? "null");
    if (!parsed || typeof parsed !== "object") return DEFAULTS;
    const value = parsed as Partial<Appearance>;
    return {
      textSize: value.textSize === "small" || value.textSize === "large" ? value.textSize : "medium",
      width: value.width === "narrow" || value.width === "wide" || value.width === "full" ? value.width : "medium",
      motion: value.motion === "reduced" ? "reduced" : "system",
    };
  } catch {
    return DEFAULTS;
  }
}

export function writeAppearance(userId: string, value: Appearance) {
  applyAppearance(value);
  try {
    localStorage.setItem(key(userId), JSON.stringify(value));
  } catch { /* this visit only */ }
}

export function applyAppearance(value: Appearance) {
  const root = document.documentElement;
  root.dataset.textSize = value.textSize;
  root.dataset.chatWidth = value.width;
  if (value.motion === "reduced") root.dataset.motion = "reduced";
  else delete root.dataset.motion;
}

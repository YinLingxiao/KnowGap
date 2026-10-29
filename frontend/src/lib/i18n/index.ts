import { en, zh, type Language, type MessageKey } from "./messages";

export { en, zh };
export type { Language, MessageKey };

export const LANGUAGE_STORAGE_KEY = "knowgap.language";

export type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;

export function isLanguage(value: unknown): value is Language {
  return value === "zh" || value === "en";
}

/** Read the saved choice; server-side (and private mode) falls back to Chinese. */
export function readStoredLanguage(): Language {
  if (typeof window === "undefined") return "zh";
  try {
    const saved = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
    return isLanguage(saved) ? saved : "zh";
  } catch {
    return "zh";
  }
}

export function localeOf(lang: Language): string {
  return lang === "en" ? "en-US" : "zh-CN";
}

export function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match,
  );
}

export function translate(lang: Language, key: MessageKey, vars?: Record<string, string | number>): string {
  return interpolate((lang === "en" ? en : zh)[key] ?? zh[key], vars);
}

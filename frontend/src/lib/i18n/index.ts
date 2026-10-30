import { en, zh, type Language, type MessageKey } from "./messages";
import { enPhrases } from "./phrases";

export { en, zh, enPhrases };
export type { Language, MessageKey };

export const LANGUAGE_STORAGE_KEY = "knowgap.language";

export type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;
export type TranslatePhrase = (text: string, vars?: Record<string, string | number>) => string;

/**
 * Shared labels can also be translated from their Chinese source text. Only
 * values with a single English translation are safe to use this way: a source
 * string such as `记忆` can mean "Memory" or "Memories" depending on the key, so
 * ambiguous values must have an explicit entry in `phrases.ts` instead.
 */
const catalogTranslations = new Map<string, Set<string>>();
for (const key of Object.keys(zh) as MessageKey[]) {
  const source = zh[key];
  const translations = catalogTranslations.get(source) ?? new Set<string>();
  translations.add(en[key]);
  catalogTranslations.set(source, translations);
}
const phraseFromCatalog = new Map<string, string>();
for (const [source, translations] of catalogTranslations) {
  if (translations.size === 1) phraseFromCatalog.set(source, [...translations][0]);
}

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

/** Translate a Chinese source sentence without creating a typed key first. */
export function translatePhrase(lang: Language, text: string, vars?: Record<string, string | number>): string {
  if (lang === "zh") return interpolate(text, vars);
  return interpolate(enPhrases[text] ?? phraseFromCatalog.get(text) ?? text, vars);
}

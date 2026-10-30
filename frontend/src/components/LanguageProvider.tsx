"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  LANGUAGE_STORAGE_KEY,
  isLanguage,
  readStoredLanguage,
  translate,
  translatePhrase,
  type Language,
  type Translate,
  type TranslatePhrase,
} from "@/lib/i18n";

interface I18nContextValue {
  lang: Language;
  setLang: (lang: Language) => void;
  t: Translate;
  tx: TranslatePhrase;
}

const I18nContext = createContext<I18nContextValue | null>(null);

function applyDocumentLanguage(lang: Language) {
  const root = document.documentElement;
  root.lang = lang === "en" ? "en" : "zh-CN";
  root.dataset.lang = lang;
  document.title = translate(lang, "app.title");
  document.querySelector('meta[name="description"]')?.setAttribute("content", translate(lang, "app.description"));
}

/**
 * Language preference shared by the whole app. The choice is local to this
 * browser, mirroring the theme preference; a small inline script in the root
 * layout applies it before first paint so the correct font is used immediately.
 */
export function LanguageProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Language>("zh");

  useEffect(() => {
    setLangState(readStoredLanguage());
  }, []);

  useEffect(() => {
    applyDocumentLanguage(lang);
  }, [lang]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === LANGUAGE_STORAGE_KEY) setLangState(isLanguage(event.newValue) ? event.newValue : "zh");
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setLang = useCallback((next: Language) => {
    setLangState(next);
    try {
      localStorage.setItem(LANGUAGE_STORAGE_KEY, next);
    } catch {
      // Private mode: the choice still applies to this visit.
    }
  }, []);

  const t = useCallback<Translate>((key, vars) => translate(lang, key, vars), [lang]);
  const tx = useCallback<TranslatePhrase>((text, vars) => translatePhrase(lang, text, vars), [lang]);

  const value = useMemo(() => ({ lang, setLang, t, tx }), [lang, setLang, t, tx]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n must be used inside <LanguageProvider>");
  return value;
}

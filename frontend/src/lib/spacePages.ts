import { API_BASE_URL } from "@/lib/config";

export const SPACE_PAGES_EVENT = "knowgap:space-pages";

export function spacePagesKey(subjectId: string) {
  return `knowgap.space.pages.v1:${API_BASE_URL}:${subjectId}`;
}

export function appendToSpacePages(subjectId: string, markdown: string) {
  const block = markdown.trim();
  if (!subjectId || !block) return;
  const key = spacePagesKey(subjectId);
  try {
    const prev = localStorage.getItem(key) ?? "";
    const next = prev.trim() ? `${prev.replace(/\s+$/, "")}\n\n${block}\n` : `${block}\n`;
    localStorage.setItem(key, next);
  } catch {
    return;
  }
  window.dispatchEvent(new CustomEvent(SPACE_PAGES_EVENT, { detail: { subjectId } }));
}

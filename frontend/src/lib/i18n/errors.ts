import type { Language, Translate } from "@/lib/i18n";
import type { ApiError } from "@/lib/api/errors";

/**
 * Human-readable message for errors raised by the frontend itself. Chinese keeps
 * the backend detail where available; English uses translated copy for kinds
 * whose detail would otherwise fall back to Chinese.
 */
export function errorText(error: ApiError, t: Translate, lang: Language): string {
  switch (error.kind) {
    case "network":
      return t("error.network");
    case "timeout":
      return t("error.timeout");
    case "not_found":
      return t("error.notFound");
    case "conflict":
      return t("error.conflict");
    case "validation":
      return lang === "en" ? t("error.validation") : error.message || t("error.validation");
    case "model_unavailable":
      return lang === "en" ? t("error.modelUnavailable") : error.message || t("error.modelUnavailable");
    case "server":
      return error.status
        ? t("error.serverStatus", { status: error.status })
        : lang === "en" ? t("error.server") : error.message || t("error.server");
    default:
      return lang === "en" ? t("error.unknown") : error.message || t("error.unknown");
  }
}

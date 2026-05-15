/**
 * Single point that derives the operator's locale from an HTTP request,
 * so AI helper calls can opt into a localised prompt for the
 * operator-facing free-form fields they emit (rationale, approval
 * messages, explanations).
 *
 * Closed enum to match the web's catalog (`apps/web/src/i18n/resources.ts`
 * exports `SUPPORTED_LANGUAGES = ['en', 'es']`). Adding a new locale =
 * extend `SUPPORTED_LOCALES` here AND mirror it in the web module.
 *
 * Used by:
 *   - `apps/api/src/routes/ai-routes.ts` for `/ai/patch-workflow`,
 *     `/ai/suggest-improvement`, `/ai/explain-workflow`, `/ai/explain-run`,
 *     `/ai/review-workflow`. Each handler reads the locale once and passes
 *     it into the corresponding `packages/ai` helper.
 *
 * The web client sets `Accept-Language: <getResolvedLocale()>` on every
 * request; service-token / curl callers without the header default to
 * English (the same fallback the web's `FALLBACK_LOCALE` uses), so the
 * eval suite keeps its existing English-prompt baseline.
 */

import type { IncomingMessage } from "http";

/** Closed locale enum the API recognises. Mirror of the web's `SupportedLanguage`. */
export type ApiLocale = "en" | "es";
const SUPPORTED_LOCALES: readonly ApiLocale[] = ["en", "es"];
/** Default when the header is missing or names an unsupported language. */
const FALLBACK_LOCALE: ApiLocale = "en";

/**
 * Pick the first base tag (`'es-MX'` → `'es'`) from `Accept-Language`
 * that the API supports. Quality factors (`q=`) are ignored — the
 * header order is enough for `en|es`.
 */
export function localeFromRequest(req: IncomingMessage | { headers?: Record<string, string | string[] | undefined> }): ApiLocale {
  const raw = req.headers?.["accept-language"];
  const value = Array.isArray(raw) ? raw.join(",") : raw;
  if (!value || typeof value !== "string") return FALLBACK_LOCALE;
  for (const part of value.split(",")) {
    const tag = part.trim().split(";")[0].trim().toLowerCase();
    if (!tag) continue;
    const base = tag.split("-")[0];
    if ((SUPPORTED_LOCALES as readonly string[]).includes(base)) {
      return base as ApiLocale;
    }
  }
  return FALLBACK_LOCALE;
}

/**
 * Pure helpers for resolving the `'system'` AppLanguage to a concrete
 * RuntimeLocale by inspecting `navigator.languages`. No side effects, no
 * No React or runtime dependencies, so locale resolution stays easy to test.
 *
 * Mirror of `lingua/src/shared/i18n/resources.ts` (resolveSystemLanguage).
 */

import { FALLBACK_LOCALE, SUPPORTED_LANGUAGES, isSupportedLanguage, type RuntimeLocale } from './resources'

/**
 * Walk a navigator-language list ("en-US", "es-MX", ...) and return the first
 * base tag (text before `-`) that matches a supported locale. Falls back to
 * `FALLBACK_LOCALE` when nothing matches or the list is empty.
 */
export function resolveSystemLocale(navLanguages: readonly string[] | undefined | null): RuntimeLocale {
  if (!navLanguages || navLanguages.length === 0) return FALLBACK_LOCALE
  for (const language of navLanguages) {
    if (typeof language !== 'string' || language.length === 0) continue
    const base = language.toLowerCase().split('-')[0]
    if (isSupportedLanguage(base)) return base
  }
  return FALLBACK_LOCALE
}

/** Browser-side accessor with a safe fallback when `navigator` is missing. */
export function getBrowserSystemLanguages(): readonly string[] {
  if (typeof navigator === 'undefined') return []
  if (Array.isArray(navigator.languages) && navigator.languages.length > 0) return navigator.languages
  if (typeof navigator.language === 'string' && navigator.language.length > 0) return [navigator.language]
  return []
}

/** Re-export for ergonomic call-site usage. */
export { SUPPORTED_LANGUAGES }

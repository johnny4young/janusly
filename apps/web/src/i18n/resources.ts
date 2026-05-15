/**
 * Static i18n metadata: closed list of supported locales, the localStorage key,
 * the canonical `common` namespace name, and helpers that validate / coerce
 * a raw string against the supported set.
 *
 * Mirror of `lingua/src/shared/i18n/resources.ts`. Adding a new locale is
 * one more entry in `SUPPORTED_LANGUAGES` plus a sibling JSON catalog under
 * `apps/web/src/i18n/locales/<lng>/common.json`.
 */

import enCommon from './locales/en/common.json'
import esCommon from './locales/es/common.json'

/** Closed enum of locales the web ships with. */
export const SUPPORTED_LANGUAGES = ['en', 'es'] as const
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number]

/** App-level setting (what the user picked, including auto-detect sentinel). */
export type AppLanguage = 'system' | SupportedLanguage

/** Resolved runtime locale (what i18next actually loads — never `'system'`). */
export type RuntimeLocale = SupportedLanguage

/** Default when nothing else matches. */
export const FALLBACK_LOCALE: RuntimeLocale = 'en'

/** Single-namespace setup mirrors lingua. */
export const COMMON_NAMESPACE = 'common'

/** localStorage key for the user's chosen locale. Convention: `janusly:*` prefix. */
export const LOCALE_STORAGE_KEY = 'janusly:locale'

/** Resource map fed into `i18next.init({ resources })`. */
export const COMMON_RESOURCES = {
  en: { [COMMON_NAMESPACE]: enCommon },
  es: { [COMMON_NAMESPACE]: esCommon },
} as const

/** Type-guard — does the raw string name a supported locale? */
export function isSupportedLanguage(language: string): language is SupportedLanguage {
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(language)
}

/** Type-guard — does the raw string name a valid app-level setting? */
export function isAppLanguage(language: string): language is AppLanguage {
  return language === 'system' || isSupportedLanguage(language)
}

/** Coerce any string to a runtime locale, falling back to `FALLBACK_LOCALE`. */
export function coerceSupportedLanguage(language: string): RuntimeLocale {
  return isSupportedLanguage(language) ? language : FALLBACK_LOCALE
}

/**
 * Synchronous i18next bootstrap. Called once at startup from `apps/web/src/main.tsx`
 * before `createRoot`. Mirror of `lingua/src/renderer/i18n/index.ts:initI18n`.
 *
 * Re-entry safe: subsequent calls just dispatch `changeLanguage` so the
 * ZUSTAND store / React tree can hot-swap locale without re-init.
 */

import i18next from 'i18next'
import { initReactI18next } from 'react-i18next'
import { COMMON_NAMESPACE, COMMON_RESOURCES, FALLBACK_LOCALE, type RuntimeLocale } from './resources'

let initialized = false

/** Update `<html lang>` so screen readers / browser features pick the right locale. */
function updateDocumentLanguage(language: RuntimeLocale): void {
  if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.lang = language
  }
}

/**
 * Initialize i18next with the bundled locale resources. Idempotent — repeat
 * calls just `changeLanguage(...)` on the existing instance.
 */
export function initI18n(language: RuntimeLocale): typeof i18next {
  if (initialized) {
    void i18next.changeLanguage(language)
    updateDocumentLanguage(language)
    return i18next
  }
  initialized = true
  void i18next.use(initReactI18next).init({
    lng: language,
    fallbackLng: FALLBACK_LOCALE,
    defaultNS: COMMON_NAMESPACE,
    ns: [COMMON_NAMESPACE],
    initAsync: false,
    resources: COMMON_RESOURCES,
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
    returnNull: false,
    returnEmptyString: false,
  })
  updateDocumentLanguage(language)
  return i18next
}

/** Imperative helper to swap language at runtime (called by LocaleSwitcher). */
export function changeRuntimeLocale(language: RuntimeLocale): void {
  void i18next.changeLanguage(language)
  updateDocumentLanguage(language)
}

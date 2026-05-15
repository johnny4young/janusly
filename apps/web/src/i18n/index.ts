/**
 * Public surface of the i18n module. Components import from here — never
 * directly from `i18next` / `react-i18next` (enforced by the AGENTS.md
 * Web-deps invariant and by the janus-ship/janus-review skill rule).
 *
 * Two flavours of consumer:
 *   - React components: `const { t } = useT()` — subscribes to language changes.
 *   - Non-React helpers (constants.ts, server-event mappers, formatters):
 *     `import { t } from '../i18n/runtime'` — same instance, same active
 *     language, but no subscription (the calling component must subscribe).
 */

import { Trans, useTranslation } from 'react-i18next'
import type i18next from 'i18next'
import { changeRuntimeLocale, initI18n } from './init'
import { resolveSystemLocale, getBrowserSystemLanguages } from './resolve'
import { getStoredLanguage, setStoredLanguage } from './storage'
import { COMMON_NAMESPACE, FALLBACK_LOCALE, isSupportedLanguage, SUPPORTED_LANGUAGES, type AppLanguage, type RuntimeLocale } from './resources'

export { initI18n }
export { changeRuntimeLocale }
export { resolveSystemLocale, getBrowserSystemLanguages }
export { getStoredLanguage, setStoredLanguage }
export { COMMON_NAMESPACE, FALLBACK_LOCALE, isSupportedLanguage, SUPPORTED_LANGUAGES }
export type { AppLanguage, RuntimeLocale }
export {
  tValidationIssue,
  tReadinessIssue,
  tAiReviewIssue,
  tRunEvent,
  tFailureCluster,
  tHealthRationale,
  tRecoveryMetricRationale,
  tTemplateName,
  tTemplateDescription,
  tTemplateCategory,
  tToolDescription,
  tApiError,
  tServerFallback,
} from './server-events'
export { getResolvedLocale } from './runtime'
export { Trans }

/**
 * Resolve an `AppLanguage` (which may be `'system'`) to a concrete `RuntimeLocale`.
 * Used at boot and when the user changes the dropdown.
 */
export function resolveAppLanguage(language: AppLanguage): RuntimeLocale {
  if (language === 'system') return resolveSystemLocale(getBrowserSystemLanguages())
  return language
}

/**
 * Imperative locale change. Persists to localStorage, resolves `'system'`,
 * dispatches `i18next.changeLanguage`, and updates `<html lang>`.
 */
export function changeAppLanguage(language: AppLanguage): void {
  setStoredLanguage(language)
  const resolved = resolveAppLanguage(language)
  changeRuntimeLocale(resolved)
}

/** Read the currently-active runtime locale. */
export function useT(): { t: ReturnType<typeof useTranslation>['t']; i18n: i18next.i18n } {
  const { t, i18n } = useTranslation(COMMON_NAMESPACE)
  return { t, i18n }
}

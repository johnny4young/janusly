/**
 * Defensive localStorage shim for the user's locale preference. Mirrors the
 * try/catch shape used in `web/src/auth.ts` so the same edge cases
 * (private-mode browsers, quota-exceeded) degrade gracefully to the sentinel
 * `'system'` value.
 */

import { isAppLanguage, LOCALE_STORAGE_KEY, type AppLanguage } from './resources'

/** Read the saved locale, returning `'system'` when storage is empty / unavailable / corrupted. */
export function getStoredLanguage(): AppLanguage {
  if (typeof window === 'undefined' || !window.localStorage) return 'system'
  try {
    const value = window.localStorage.getItem(LOCALE_STORAGE_KEY)
    if (!value) return 'system'
    return isAppLanguage(value) ? value : 'system'
  } catch {
    return 'system'
  }
}

/** Persist the chosen locale; failure is non-fatal (storage may be unavailable). */
export function setStoredLanguage(language: AppLanguage): void {
  if (typeof window === 'undefined' || !window.localStorage) return
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, language)
  } catch {
    /* swallow — private mode / quota. */
  }
}

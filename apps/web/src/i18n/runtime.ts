/**
 * Non-React access to the same i18next instance the React tree uses. Suitable
 * for `constants.ts` formatters, server-event mappers, and any code path that
 * computes a translated string outside a component.
 *
 * Mirror of `lingua/src/shared/i18n/runtime.ts`. Calls share the same active
 * language with `useTranslation()` consumers — when the user changes locale,
 * the next call returns the new translation automatically. Components that
 * render strings produced by these helpers MUST subscribe via `useT()` so
 * they re-render on language change.
 */

import i18next from 'i18next'
import { FALLBACK_LOCALE, type RuntimeLocale, type Translate } from './resources'

/** The non-React translation chokepoint with a bounded application signature. */
export const t: Translate = (key, options) => String(
  options === undefined
    ? i18next.t(key as never)
    : i18next.t(key as never, options as never),
)

/** Read the currently active runtime locale (never `'system'`). */
export function getResolvedLocale(): RuntimeLocale {
  const language = i18next.language
  if (language === 'en' || language === 'es') return language
  return FALLBACK_LOCALE
}

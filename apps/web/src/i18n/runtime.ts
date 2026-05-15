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
import { FALLBACK_LOCALE, type RuntimeLocale } from './resources'

/** The non-React `t` (typed by i18next via `types.d.ts` module augmentation). */
export const t = (...args: Parameters<typeof i18next.t>): ReturnType<typeof i18next.t> =>
  i18next.t(...args)

/** Read the currently active runtime locale (never `'system'`). */
export function getResolvedLocale(): RuntimeLocale {
  const language = i18next.language
  if (language === 'en' || language === 'es') return language
  return FALLBACK_LOCALE
}

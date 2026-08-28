/**
 * Design-sync bundle bootstrap.
 *
 * Janusly's i18n runtime is a module singleton that the app fills in from
 * `main.tsx` via `bootstrapI18n()` before React mounts. The design-system
 * bundle has no such entry point, so without this module every `useT()`
 * consumer (257 call sites) resolves through `resolveTemplate`'s
 * missing-catalog branch and renders the raw key — `rightPanel.chrome.kicker`
 * instead of "Workspace".
 *
 * Registering the English catalog at bundle-init time is enough: the runtime's
 * `activeLocale` already defaults to `FALLBACK_LOCALE` ('en'), so no
 * `setRuntimeLocale` call is needed (and it would throw if made before
 * registration).
 *
 * Wired via `extraEntries` in `.design-sync/config.json`.
 */

import en from '../src/i18n/locales/en/common.json'
import { registerRuntimeCatalog } from '../src/i18n/runtime'
import type { CatalogFragment } from '../src/i18n/resources'

registerRuntimeCatalog('en', en as CatalogFragment)

/**
 * Neutralize backend calls for the preview environment.
 *
 * Many panels fetch on mount through `src/api.ts`'s central `api()` helper.
 * A design-system card has no Janusly backend behind it, so every one of those
 * requests fails and the card renders its *error* state — 15 components were
 * showing a red "Request failed with 404" banner as their portrait. That is
 * actively misleading: the design agent browsing these cards would read error
 * styling as the component's default look and reproduce it.
 *
 * Resolving with an empty 200 instead lets each panel fall through to the
 * empty state it was actually designed to show. This affects the design-sync
 * bundle only — `src/api.ts` is untouched, and nothing here ships in the
 * Janusly application.
 */
const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

/**
 * A handful of endpoints drive *validity*, not just content: answering them
 * with `{}` makes a correct input render as an error. `schedule-preview` is
 * the one that matters — `ScheduleCronPreview` marks any response without
 * `valid: true` and exactly three `nextFires` as an invalid expression, so a
 * perfectly good `0 2 * * *` would show "Use a valid 5-field cron expression".
 */
function stubFor(url: string): unknown {
  if (url.includes('/workflows/schedule-preview')) {
    // Answer honestly enough that BOTH the valid and invalid cards are true:
    // a real 5-field expression gets three next-fire times, anything else is
    // reported invalid. Always returning `valid: true` would make a card
    // labelled "invalid expression" render a happy schedule preview.
    const cron = new URL(url, 'http://localhost').searchParams.get('cron') ?? ''
    const isFiveField = cron.trim().split(/\s+/).filter(Boolean).length === 5
    return isFiveField
      ? {
          valid: true,
          nextFires: [
            '2026-08-29T02:00:00.000Z',
            '2026-08-30T02:00:00.000Z',
            '2026-08-31T02:00:00.000Z',
          ],
        }
      : { valid: false, nextFires: [] }
  }
  return {}
}

if (typeof globalThis.fetch === 'function') {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    return json(stubFor(url))
  }) as typeof globalThis.fetch
}

/** Exported so the module is never dropped as a side-effect-free import. */
export const __janusly_i18n_ready = true

/**
 * React entry point — renders `<App />` into the `#root` element. The
 * Tailwind 4 stylesheet at `./index.css` is imported here so Vite + the
 * `@tailwindcss/vite` plugin pick up the `@theme {}` tokens (AGENTS.md
 * Tailwind invariant: CSS-first; no `tailwind.config.ts`).
 */

import React from 'react'
import { createRoot } from 'react-dom/client'
import { bootstrapI18n, FALLBACK_LOCALE, getStoredLanguage, resolveAppLanguage } from './i18n'
import { bootTheme } from './theme'
import { ConfirmProvider } from './components/ConfirmDialog'
import './index.css'

// Resolve the user's preferred locale BEFORE React mounts so the very first
// render (boot screen, login form) is already in the right language. The
// `'system'` sentinel resolves once against `navigator.languages`; explicit
// choices win indefinitely.
const stored = getStoredLanguage()
const initialLocale = resolveAppLanguage(stored)

// Theme does not depend on the locale chunk. Apply it immediately so a slow
// catalog request cannot reintroduce a light→dark first-paint flicker.
bootTheme()

// Start the selected-locale and app-workspace downloads together. Awaiting the
// catalog before importing App would serialize two independent boot resources
// and add a network round-trip without changing mount semantics.
const appModulePromise = import('./App')
// Mark the early-started promise as handled: if i18n bootstrap throws on the
// fallback path below, mountApp exits before awaiting App, and an ALSO-failed
// App fetch would otherwise surface as an unhandled rejection on top of the
// real error. Awaiting the original promise later still receives rejections.
appModulePromise.catch(() => {})
const i18nReadyPromise = bootstrapI18n(initialLocale)

async function mountApp(): Promise<void> {
  try {
    await i18nReadyPromise
  } catch (error) {
    if (initialLocale === FALLBACK_LOCALE) throw error
    // A transient non-English chunk failure should not leave a blank screen.
    // Keep the stored preference untouched so the next reload retries it.
    console.warn(`[i18n] Failed to load ${initialLocale}; using ${FALLBACK_LOCALE}`)
    await bootstrapI18n(FALLBACK_LOCALE)
  }

  const { default: App } = await appModulePromise
  // `<App>` is dynamically imported so the entry chunk stays lean. The React
  // Flow provider is deliberately NOT mounted here — it lives inside the lazy
  // `CanvasWorkspace` (`apps/web/src/components/CanvasWorkspace.tsx`), mounted
  // only when the operator first leaves home for a canvas-bearing tab. That
  // keeps `@xyflow/react` (the bundle's heaviest dependency) off the boot
  // path, so the Recovery Center landing downloads zero React Flow. The
  // canvas wrapper stays mounted across every non-home tab, so the viewport
  // (zoom / pan) still survives `inspector → operations → inspector`.
  createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <ConfirmProvider>
        <App />
      </ConfirmProvider>
    </React.StrictMode>
  )
}

void mountApp().catch((error: unknown) => {
  console.error('[web] Failed to bootstrap Janusly', error)
})

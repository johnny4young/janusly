/**
 * React entry point — renders `<App />` into the `#root` element. The
 * Tailwind 4 stylesheet at `./index.css` is imported here so Vite + the
 * `@tailwindcss/vite` plugin pick up the `@theme {}` tokens (AGENTS.md
 * Tailwind invariant: CSS-first; no `tailwind.config.ts`).
 */

import React from 'react'
import { createRoot } from 'react-dom/client'
import { ReactFlowProvider } from '@xyflow/react'
import { getStoredLanguage, initI18n, resolveAppLanguage } from './i18n'
import { bootTheme } from './theme'
import './index.css'

// Resolve the user's preferred locale BEFORE React mounts so the very first
// render (boot screen, login form) is already in the right language. The
// `'system'` sentinel resolves once against `navigator.languages`; explicit
// choices win indefinitely.
const stored = getStoredLanguage()
initI18n(resolveAppLanguage(stored))

// Apply the stored theme + density preference BEFORE createRoot so the
// dark token block resolves during first paint — avoids a light→dark flicker
// when the user reloads with a non-default theme.
bootTheme()

void import('./App').then(({ default: App }) => {
  // The `<ReactFlowProvider>` lives at the app root so the canvas's viewport
  // (zoom / pan) survives `inspector → operations → inspector` navigation.
  // Inside the provider, the `App.tsx` dispatcher keeps the canvas DOM
  // mounted on every non-home tab — visible on canvas tabs, hidden via
  // `display: none` on non-canvas tabs. Tearing the canvas wrapper down on
  // each navigation would destroy the provider's per-canvas state and reset
  // zoom + pan to defaults.
  createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <ReactFlowProvider>
        <App />
      </ReactFlowProvider>
    </React.StrictMode>
  )
})

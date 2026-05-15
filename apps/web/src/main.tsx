/**
 * React entry point — renders `<App />` into the `#root` element. The
 * Tailwind 4 stylesheet at `./index.css` is imported here so Vite + the
 * `@tailwindcss/vite` plugin pick up the `@theme {}` tokens (AGENTS.md
 * Tailwind invariant: CSS-first; no `tailwind.config.ts`).
 */

import React from 'react'
import { createRoot } from 'react-dom/client'
import { getStoredLanguage, initI18n, resolveAppLanguage } from './i18n'
import './index.css'

// Resolve the user's preferred locale BEFORE React mounts so the very first
// render (boot screen, login form) is already in the right language. The
// `'system'` sentinel resolves once against `navigator.languages`; explicit
// choices win indefinitely.
const stored = getStoredLanguage()
initI18n(resolveAppLanguage(stored))

void import('./App').then(({ default: App }) => {
  createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
})

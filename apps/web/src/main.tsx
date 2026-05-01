/**
 * React entry point — renders `<App />` into the `#root` element. The
 * Tailwind 4 stylesheet at `./index.css` is imported here so Vite + the
 * `@tailwindcss/vite` plugin pick up the `@theme {}` tokens (AGENTS.md
 * Tailwind invariant: CSS-first; no `tailwind.config.ts`).
 */

import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)

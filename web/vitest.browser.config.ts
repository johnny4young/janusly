import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { playwright } from '@vitest/browser-playwright'
import { compactI18nCatalogs } from './scripts/compact-i18n-plugin.mjs'

export default defineConfig({
  resolve: {
    alias: { '@': resolve(import.meta.dirname, 'src') },
  },
  // Browser discovery must not restart after encountering a runtime schema
  // for the first time. A reload can strand files at "0 test" and invalidate
  // the entire run, so pre-bundle the production browser contract entrypoint.
  optimizeDeps: {
    include: ['zod/mini'],
  },
  // Mirror the dev/build plugin set so any test that imports `index.css` (or a
  // styled component that depends on the workflow palette tokens) sees the
  // same Tailwind 4 CSS-first output. Production manualChunks are intentionally
  // skipped — those are build-only.
  plugins: [
    compactI18nCatalogs({
      canonicalPath: resolve(import.meta.dirname, 'src/i18n/locales/en/common.json'),
    }),
    react(),
    tailwindcss(),
  ],
  test: {
    name: 'browser',
    include: ['src/**/*.browser.test.{ts,tsx}'],
    setupFiles: ['./src/test/browser-setup.ts'],
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      instances: [{ browser: 'chromium' }],
    },
    css: true,
  },
})

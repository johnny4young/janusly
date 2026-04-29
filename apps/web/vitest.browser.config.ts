import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { playwright } from '@vitest/browser-playwright'

export default defineConfig({
  // Mirror the dev/build plugin set so any test that imports `index.css` (or a
  // styled component that depends on the workflow palette tokens) sees the
  // same Tailwind 4 CSS-first output. Production manualChunks are intentionally
  // skipped — those are build-only.
  plugins: [react(), tailwindcss()],
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

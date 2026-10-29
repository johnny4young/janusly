import { resolve } from 'node:path'
import type { BrowserContext, Page } from 'playwright'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { playwright, type PlaywrightBrowserProvider } from '@vitest/browser-playwright'
import { compactI18nCatalogs } from './scripts/compact-i18n-plugin.mjs'

const INTERCEPTION_PROBE = '/__janusly_interception_probe__'

// The provider turns Chromium request interception off and on between test
// files, and Chromium acknowledges it before frames use it, so a mocked import
// can load the real module. Keep it on and confirm it (fixed in Vitest 5.0.4).
function playwrightWithStableMocks() {
  const option = playwright()
  return {
    ...option,
    providerFactory: (project: Parameters<typeof option.providerFactory>[0]) => {
      const provider = option.providerFactory(project) as PlaywrightBrowserProvider
      const armed = new WeakMap<BrowserContext, Promise<void>>()
      const register = provider.mocker.register
      provider.mocker.register = async (sessionId, module) => {
        const page = provider.getPage(sessionId)
        const context = page.context()
        const ready = armed.get(context) ?? armInterception(page).catch((error: unknown) => {
          armed.delete(context)
          throw error
        })
        armed.set(context, ready)
        await ready
        return register(sessionId, module)
      }
      return provider
    },
  }
}

// Probe with a module import: it takes the same loader path as a mocked module,
// and tests cannot stub it the way they stub fetch.
let probeAttempt = 0

async function armInterception(page: Page) {
  const isProbe = (url: URL) => url.pathname === INTERCEPTION_PROBE
  await page.context().route(isProbe, (route) => route.fulfill({
    contentType: 'text/javascript',
    headers: { 'x-interception-probe': '1' },
    body: 'export default true',
  }))
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    // Documents cache failed module imports, so every attempt needs a fresh URL.
    const url = `${INTERCEPTION_PROBE}?attempt=${probeAttempt++}`
    const frames = await Promise.all(page.frames().map((frame) => Promise.race([
      frame.evaluate((probe) => import(probe).then(() => true, () => false), url),
      new Promise<boolean>((resolve) => setTimeout(resolve, 1_000, false)),
    ]).catch(() => frame.isDetached())))
    if (frames.every(Boolean)) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  await page.context().unroute(isProbe)
  throw new Error('Chromium request interception did not become active; module mocks would not apply.')
}

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
      provider: playwrightWithStableMocks(),
      headless: true,
      instances: [{ browser: 'chromium' }],
    },
    css: true,
  },
})

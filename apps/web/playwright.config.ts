import { defineConfig, devices } from '@playwright/test'

// The root E2E harness owns this private variable. Unlike the documented
// PLAYWRIGHT_BASE_URL, it is not present in the root .env and therefore cannot
// be replaced when database-backed specs load @janusly/db in a worker.
const baseURL = process.env.JANUSLY_E2E_RUNTIME_BASE_URL
  ?? process.env.PLAYWRIGHT_BASE_URL
  ?? 'http://127.0.0.1:5173'
const webPort = new URL(baseURL).port || '5173'

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  // Every file shares one API, worker, Postgres, and Redis stack. Bounding the
  // local fan-out prevents host CPU count from turning service latency into
  // unrelated UI timeouts; Playwright already defaults CI to one worker.
  workers: process.env.CI ? 1 : 4,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL,
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
    // Feature-focused specs enter specialized task spaces directly. Keep their
    // setup concise while the dedicated navigation spec clears this seed and
    // proves the real first-run navigation state.
    storageState: {
      cookies: [],
      origins: [{
        origin: baseURL,
        localStorage: [{
          name: 'janusly:sidebar:state',
          value: JSON.stringify({
            openCategories: ['ai', 'flow'],
            collapsed: false,
          }),
        }],
      }],
    },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: process.env.PLAYWRIGHT_SKIP_WEB_SERVER === '1'
    ? undefined
    : {
      command: `pnpm dev --host 127.0.0.1 --port ${webPort} --strictPort`,
      url: baseURL,
      // Reusing any process that happens to answer on the port can send the
      // suite into an unrelated local application. The root harness allocates
      // a free port, so always let Playwright own the web process.
      reuseExistingServer: false,
      timeout: 120_000,
    },
})

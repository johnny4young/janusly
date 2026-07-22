import { defineConfig, devices } from '@playwright/test'

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:5173'
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

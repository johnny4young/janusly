import { defineConfig, devices } from '@playwright/test'

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:4173'
const previewUrl = new URL(baseURL)
const previewPort = Number(previewUrl.port || 80)

if (
  previewUrl.protocol !== 'http:'
  || previewUrl.pathname !== '/'
  || previewUrl.search
  || previewUrl.hash
  || !Number.isInteger(previewPort)
  || previewPort < 1
  || previewPort > 65_535
) {
  throw new Error(`PLAYWRIGHT_BASE_URL must be an HTTP origin with a valid port, received ${baseURL}`)
}

export default defineConfig({
  testDir: './performance',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  reporter: 'list',
  use: {
    ...devices['Desktop Chrome'],
    baseURL,
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
  },
  webServer: {
    command: `pnpm preview --host ${previewUrl.hostname} --port ${previewPort}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
})

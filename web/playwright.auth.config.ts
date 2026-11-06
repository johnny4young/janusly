import { defineConfig, devices } from '@playwright/test'

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:4174'
const { hostname, port } = new URL(baseURL)
const outDir = 'node_modules/.cache/auth-e2e-dist'

// The e2e bundle has no Supabase configuration, so this lane builds its own.
// A production build also keeps Vite's dependency reloads from replaying boot.
export default defineConfig({
  testDir: './auth-e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: 'list',
  use: {
    ...devices['Desktop Chrome'],
    baseURL,
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: `pnpm --ignore-workspace exec vite build --logLevel warn --outDir ${outDir} && pnpm --ignore-workspace exec vite preview --outDir ${outDir} --host ${hostname} --port ${port} --strictPort`,
    env: {
      NODE_ENV: 'production',
      VITE_SUPABASE_URL: 'http://127.0.0.1:54399',
      VITE_SUPABASE_ANON_KEY: 'test-anon-key',
    },
    url: baseURL,
    reuseExistingServer: false,
    timeout: 240_000,
  },
})

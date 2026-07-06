import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Several route/auth suites intentionally mutate module-level env and
    // vi.mock state around dynamic imports; serial files keep the gate stable.
    fileParallelism: false,
    // Integration tests (`*.integration.test.ts`) hit a REAL Postgres and run
    // only via `pnpm test:integration` (Compose lifecycle). Keep them out of
    // the mocked-DB unit suite that `pnpm test` runs.
    exclude: [...configDefaults.exclude, 'src/**/*.integration.test.ts'],
  },
})

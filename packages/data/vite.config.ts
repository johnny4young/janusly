import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Integration tests (`*.integration.test.ts`) hit a REAL Postgres and run
    // only via `pnpm test:integration` (Compose lifecycle). Keep them out of
    // the mocked-DB unit suite that `pnpm test` runs.
    exclude: [...configDefaults.exclude, 'src/**/*.integration.test.ts'],
  },
})

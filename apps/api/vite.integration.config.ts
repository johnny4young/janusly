import { defineConfig } from 'vitest/config'

/**
 * Integration-lane config — runs ONLY `apps/api`'s `*.integration.test.ts`
 * against a REAL Postgres (via scripts/run-integration.mjs). Covers SQL that
 * lives in `apps/api` rather than `@janusly/data` (e.g. the recovery-queue
 * `listRecoveryQueue` filters + keyset) which the mocked-DB unit suite can't
 * prove. Serial + single-fork; each test uses a unique org id.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.integration.test.ts'],
    fileParallelism: false,
    pool: 'forks',
    singleFork: true,
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
})

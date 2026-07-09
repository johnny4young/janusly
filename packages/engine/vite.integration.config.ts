import { defineConfig } from 'vitest/config'

/**
 * Integration-lane config — runs ONLY `packages/engine`'s
 * `*.integration.test.ts` against a REAL Postgres (via
 * scripts/run-integration.mjs). Covers engine SQL/transaction correctness the
 * mocked-DB unit suite can't prove — e.g. `claimReplayTransition`'s atomic
 * CAS + rollback-on-throw (Q-02). Serial + single-fork; each test uses a
 * unique run/org id.
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

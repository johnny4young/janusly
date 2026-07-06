import { defineConfig } from 'vitest/config'

/**
 * Integration-lane config — runs ONLY `*.integration.test.ts` against a REAL
 * Postgres (DATABASE_URL from the Compose lifecycle in scripts/run-integration.mjs).
 * These exercise actual SQL correctness (keyset boundaries, filters, tenant
 * scope, CAS conflicts, index presence) that the mocked-DB unit tests can't.
 *
 * Serial + single-fork so tests sharing the DB don't race; each test uses a
 * unique org id so rows never collide across tests or with the e2e `default` org.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.integration.test.ts'],
    fileParallelism: false,
    pool: 'forks',
    singleFork: true,
    // A real DB round-trip is slower than a mocked call.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
})

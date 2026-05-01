/**
 * Migration presence-check used by every long-running process at startup.
 *
 * Drizzle creates a `drizzle.__drizzle_migrations` ledger table the first
 * time `pnpm migrate` runs successfully. The API and worker query for that
 * table's existence and refuse to boot if it's missing — this is the
 * fail-fast that replaced the old runtime `CREATE TABLE IF NOT EXISTS`
 * bootstrap in `schema-management.ts`.
 *
 * Used by:
 * - `apps/api/src/index.ts` — `await assertMigrationsApplied()` before
 *   `server.listen()`.
 * - `packages/engine/src/worker.ts` — same call at module top level.
 *
 * Invariants:
 * - Memoised promise so repeated callers share one round-trip; on rejection
 *   the cache is cleared so a transient error doesn't poison subsequent
 *   calls.
 * - Failure throws a message that names the exact remediation (`pnpm
 *   migrate`). Don't soften it — operators should see the cause clearly.
 */

import { client } from "./index";

let migrationsAsserted: Promise<void> | null = null;

/**
 * Minimal contract a migration probe client must satisfy. The typed Drizzle
 * client and the raw postgres-js client both fit; tests can pass a fake.
 */
type MigrationProbeClient = {
  unsafe(query: string): PromiseLike<unknown>;
};

/**
 * Verify that Drizzle migrations have been applied at least once against the
 * configured `DATABASE_URL`. Memoised across callers; throws a clear error
 * naming the remediation when the ledger table is missing.
 *
 * Called from API + worker boot paths. Never call this lazily inside a
 * request — boot-time fail-fast is the contract.
 */
export function assertMigrationsApplied() {
  migrationsAsserted ??= assertMigrationsAppliedForClient(client).catch((err) => {
    migrationsAsserted = null;
    throw err;
  });
  return migrationsAsserted;
}

/**
 * Underlying probe used by `assertMigrationsApplied`. Exported so tests can
 * pass a fake `unsafe(query)` client without opening a real Postgres
 * connection as an import side effect.
 */
export async function assertMigrationsAppliedForClient(migrationClient: MigrationProbeClient) {
  const rows = (await migrationClient.unsafe(
    "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'drizzle' AND table_name = '__drizzle_migrations') AS exists",
  )) as { exists: boolean }[];

  if (!rows[0]?.exists) {
    throw new Error(
      "Database is not migrated. Run `pnpm migrate` against DATABASE_URL before starting the API/worker.",
    );
  }
}

/**
 * `@janusly/db` barrel — the singleton Drizzle client + a re-export of the
 * side-effect-free schema barrel and the env-loader.
 *
 * Importing this module triggers `loadRootEnv()` and instantiates a single
 * `postgres-js` connection pool against `process.env.DATABASE_URL`. Every
 * query in the project — repos, runtime stores, billing, audit — runs through
 * this `db` instance.
 *
 * Used by:
 * - `packages/data/src/*` — drizzle repos for routing stats, improvements,
 *   workflow rollback.
 * - `packages/engine/src/persistence-ports/*`, `start-run.ts`, `resume-run.ts`,
 *   `billing.ts`, `secrets.ts`, `memory.ts`, `node-registry.ts` — direct
 *   `db.select/insert/update` calls.
 * - `apps/api/src/index.ts` — every route that touches Postgres.
 * - `packages/db/src/migrations.ts` — uses `client` for the
 *   `assertMigrationsApplied` presence check.
 *
 * Invariants:
 * - One process-wide pool. Don't create additional Drizzle clients in
 *   feature code — pool fanout breaks Postgres `max_connections` budgeting
 *   and would dodge the migration assertion at boot.
 * - `onnotice: () => undefined` silences benign Postgres NOTICE messages
 *   (e.g. `relation "..." already exists`) so test output stays readable.
 *   Don't replace with a logger that re-prints them.
 * - The throw on missing `DATABASE_URL` is a fail-fast: API + worker should
 *   refuse to boot without the URL rather than silently writing to a
 *   default localhost.
 */

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { loadRootEnv } from "./env";

loadRootEnv();

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("Missing DATABASE_URL. Add it to .env or .env.example.");
}

/**
 * Raw `postgres-js` client. Exported for places that need to issue ad-hoc SQL
 * (e.g. `assertMigrationsApplied` calls `client.unsafe`). Most code should
 * prefer `db` (the typed Drizzle wrapper) instead.
 */
export const client = postgres(connectionString, {
  onnotice: () => undefined,
});

/** Typed Drizzle client. The default surface for query building everywhere.
 * The drizzle@1.0 wire change: pass the postgres-js client via the `client`
 * field on the options object rather than as a positional argument. */
export const db = drizzle({ client });

export * from "./schema";
export * from "./env";

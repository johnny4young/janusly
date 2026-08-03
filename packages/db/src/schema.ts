/**
 * Janusly database schema — the canonical public barrel for every Postgres
 * table the system owns.
 *
 * Bounded-context declarations live under `schema/*.ts`. This side-effect-free
 * barrel is the single source consumed by Drizzle Kit, schema contract tests,
 * and the `@janusly/db` package export. Keep table objects defined in exactly
 * one domain module so every consumer and migration sees the same identity.
 *
 * Migrations under `packages/db/migrations/` are generated from this barrel via
 * `pnpm --filter @janusly/db db:generate`; do not hand-roll schema changes or
 * reintroduce a runtime `CREATE TABLE IF NOT EXISTS` bootstrap.
 *
 * Invariants:
 * - Every timestamp is `TIMESTAMPTZ` (`withTimezone: true`).
 * - Index names remain byte-compatible with the migration snapshots.
 * - `org_id` is `NOT NULL` on every business table.
 * - Parent deletion remains orphan-tolerant unless a child has no independent
 *   operational meaning; do not add foreign keys speculatively.
 */

export * from "./schema/ai";
export * from "./schema/executions";
export * from "./schema/identity";
export * from "./schema/integrations";
export * from "./schema/recovery";
export * from "./schema/tenancy";
export * from "./schema/workflows";

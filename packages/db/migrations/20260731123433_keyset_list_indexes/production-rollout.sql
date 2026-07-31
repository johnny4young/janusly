-- Production rollout runbook for the keyset-list hot-path indexes.
-- NOT run by drizzle-kit. Apply BEFORE the deploy's `pnpm migrate` via:
--
--   psql -v ON_ERROR_STOP=1 -f production-rollout.sql
--
-- `CREATE INDEX CONCURRENTLY` cannot run inside a transaction (Postgres
-- error 25001) and drizzle-kit wraps migration.sql in one, hence this
-- sibling file (see AGENTS.md "Hot-path indexes use a two-file pattern").
-- After these complete, migration.sql's IF NOT EXISTS / IF EXISTS guards
-- short-circuit.
--
-- The plain `DESC` (NULLS FIRST) direction is load-bearing: `created_at` /
-- `deleted_at` are nullable and the list queries order by `... DESC`, which
-- is DESC NULLS FIRST — a DESC NULLS LAST index cannot satisfy that sort and
-- the planner falls back to a per-page top-N re-sort of the org's rows.
--
-- Order matters: create the id-tiebreaker replacements FIRST, then drop the
-- old strict-prefix indexes, so the runs/workflows lists never lose index
-- coverage. The concurrent drops avoid the ACCESS EXCLUSIVE stall a plain
-- DROP INDEX would cause on the hot `runs` table.

CREATE INDEX CONCURRENTLY IF NOT EXISTS "runs_org_created_id_idx"
  ON "runs" ("org_id", "created_at" DESC, "id" DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS "workflows_org_created_id_idx"
  ON "workflows" ("org_id", "created_at" DESC, "id" DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS "workflows_org_deleted_idx"
  ON "workflows" ("org_id", "deleted_at" DESC, "id" DESC)
  WHERE "deleted_at" IS NOT NULL;

DROP INDEX CONCURRENTLY IF EXISTS "runs_org_created_idx";

DROP INDEX CONCURRENTLY IF EXISTS "workflows_org_created_idx";

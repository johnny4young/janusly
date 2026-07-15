-- Production rollout runbook for the bounded-wait reconciler lease and index.
-- NOT run by drizzle-kit. Apply BEFORE the deploy's `pnpm migrate` via:
--
--   psql -v ON_ERROR_STOP=1 -f production-rollout.sql
--
-- Adding the nullable lease column has no table rewrite. The index is built
-- concurrently because it covers the growing run_nodes table. The regular
-- migration uses IF NOT EXISTS, so both statements become cheap no-ops after
-- this pre-deploy rollout completes.

ALTER TABLE "run_nodes"
  ADD COLUMN IF NOT EXISTS "waiting_repair_after" timestamp with time zone;

CREATE INDEX CONCURRENTLY IF NOT EXISTS "run_nodes_waiting_target_idx"
  ON "run_nodes" (
    "waiting_repair_after" NULLS FIRST,
    (COALESCE("state_json" #>> '{waiting,deadlineAt}', "state_json" #>> '{waiting,wakeAt}')),
    "run_id",
    "node_id"
  )
  WHERE "status" = 'waiting';

-- Production rollout for the trigger_events buffered-window index.
-- drizzle-kit wraps migration.sql in a transaction, and Postgres rejects
-- CREATE INDEX CONCURRENTLY inside one (error 25001) — so ops apply THIS
-- file first on production (psql -v ON_ERROR_STOP=1 -f production-rollout.sql),
-- and the deploy's `pnpm migrate` then short-circuits on IF NOT EXISTS.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "trigger_events_org_workflow_status_idx"
  ON "trigger_events" ("org_id", "workflow_id", "status", "created_at");

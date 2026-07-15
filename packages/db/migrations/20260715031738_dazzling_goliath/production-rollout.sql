-- Production rollout runbook for bounded per-run usage diagnostics.
-- NOT run by drizzle-kit. Apply BEFORE the deploy's `pnpm migrate` via:
--
--   psql -v ON_ERROR_STOP=1 -f production-rollout.sql
--
-- The index is built concurrently because usage_events is append-heavy and
-- grows for every AI, memory, and integration call. The regular generated
-- migration uses IF NOT EXISTS, so it becomes a cheap no-op after this
-- pre-deploy rollout completes.

CREATE INDEX CONCURRENTLY IF NOT EXISTS "usage_events_org_run_created_idx"
  ON "usage_events" (
    "org_id",
    "run_id",
    "created_at" DESC NULLS LAST,
    "id" DESC NULLS LAST
  )
  WHERE "run_id" IS NOT NULL;

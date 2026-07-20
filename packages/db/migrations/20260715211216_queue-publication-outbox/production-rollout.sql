-- Production rollout runbook for durable queue and subworkflow publication repair.
-- NOT run by drizzle-kit. Apply BEFORE the deploy's `pnpm migrate` via:
--
--   1. Pause run-start/replay ingress.
--   2. Stop and drain EVERY pre-outbox API and worker process.
--   3. psql -v ON_ERROR_STOP=1 -v janusly_workers_drained=1 \
--        -f production-rollout.sql
--   4. Run `pnpm migrate`, deploy the new API + worker fleet in full, then
--      restore ingress.
--
-- A mixed-version rollout is unsafe: an old producer does not persist queue
-- generations, executable parent-link kinds, or terminal child handoffs, and
-- an old consumer can discard work while a parent run is failed. The explicit
-- psql acknowledgement below prevents this runbook from being applied before
-- the old fleet is drained.
--
-- The four column additions use metadata-only nullable/constant-default forms
-- on supported Postgres releases. Both partial indexes are built concurrently
-- because runs and run_nodes are append-heavy. The regular migration uses IF
-- NOT EXISTS, so it becomes a cheap no-op after this pre-deploy rollout.
-- `pnpm migrate` also repairs the narrow historical case where validation
-- parents spawned descendants before sandbox propagation existed: a recursive
-- parent-index walk marks those descendants as executable subworkflow links
-- and inherits validation mode before the new fleet can replay them.

\if :{?janusly_workers_drained}
\else
  \echo 'ERROR: drain every pre-outbox API/worker and pass -v janusly_workers_drained=1'
  \quit 3
\endif

\if :janusly_workers_drained
\else
  \echo 'ERROR: janusly_workers_drained must be truthy after the old fleet is fully stopped'
  \quit 3
\endif

ALTER TABLE "run_nodes"
  ADD COLUMN IF NOT EXISTS "queue_publication_repair_after" timestamp with time zone;

ALTER TABLE "run_nodes"
  ADD COLUMN IF NOT EXISTS "queue_publication_generation" integer DEFAULT 0 NOT NULL;

ALTER TABLE "runs"
  ADD COLUMN IF NOT EXISTS "parent_link_kind" text;

ALTER TABLE "runs"
  ADD COLUMN IF NOT EXISTS "parent_notification_after" timestamp with time zone;

CREATE INDEX CONCURRENTLY IF NOT EXISTS "run_nodes_queue_publication_repair_idx"
  ON "run_nodes" ("queue_publication_repair_after", "run_id", "node_id")
  WHERE "queue_publication_repair_after" IS NOT NULL
    AND "status" IN ('pending', 'queued');

CREATE INDEX CONCURRENTLY IF NOT EXISTS "runs_parent_notification_idx"
  ON "runs" ("parent_notification_after", "id")
  WHERE "parent_notification_after" IS NOT NULL;

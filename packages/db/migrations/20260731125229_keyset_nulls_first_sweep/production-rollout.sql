-- Production rollout runbook for the keyset NULLS FIRST index sweep.
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
-- Why: these list/keyset indexes were declared DESC NULLS LAST while their
-- queries order by plain `... DESC` (= DESC NULLS FIRST) on NULLABLE
-- columns, so the planner could never use them for the sort and re-sorted
-- each page. The replacements use plain DESC (NULLS FIRST) and, where the
-- query keysets on `(created_at, id)`, carry the id tiebreaker.
--
-- The `text_pattern_ops` opclass on audit_logs "action" is required for the
-- audit viewer's `action LIKE 'prefix%'` filter (drizzle's builder cannot
-- emit an opclass, so it is appended by hand — same as the original index).
--
-- Order matters: create every replacement FIRST, then drop the old indexes,
-- so no list loses its filter coverage. The concurrent drops avoid the
-- ACCESS EXCLUSIVE stall a plain DROP INDEX would cause on the hot
-- dead_letters / audit_logs / trigger_events tables.

CREATE INDEX CONCURRENTLY IF NOT EXISTS "audit_logs_org_created_id_idx"
  ON "audit_logs" ("org_id", "created_at" DESC, "id" DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS "audit_logs_org_action_created_id_idx"
  ON "audit_logs" ("org_id", "action" text_pattern_ops, "created_at" DESC, "id" DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS "dead_letters_org_status_created_idx"
  ON "dead_letters" ("org_id", "status", "created_at" DESC, "id" DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS "dead_letters_org_created_id_idx"
  ON "dead_letters" ("org_id", "created_at" DESC, "id" DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS "external_run_steps_org_observed_created_idx"
  ON "external_run_steps" ("org_id", "last_observed_at" DESC, "created_at" DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS "external_runs_org_observed_created_idx"
  ON "external_runs" ("org_id", "last_observed_at" DESC, "created_at" DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS "external_workflows_org_observed_workflow_idx"
  ON "external_workflows" ("org_id", "last_observed_at" DESC, "external_workflow_id");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "prompts_org_created_id_idx"
  ON "prompts" ("org_id", "created_at" DESC, "id" DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS "recovery_feedback_org_workflow_created_idx"
  ON "recovery_feedback" ("org_id", "workflow_id", "created_at" DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS "replay_campaigns_org_created_id_idx"
  ON "replay_campaigns" ("org_id", "created_at" DESC, "id" DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS "trigger_events_org_created_id_idx"
  ON "trigger_events" ("org_id", "created_at" DESC, "id" DESC);

DROP INDEX CONCURRENTLY IF EXISTS "audit_logs_org_created_idx";

DROP INDEX CONCURRENTLY IF EXISTS "audit_logs_org_action_created_idx";

DROP INDEX CONCURRENTLY IF EXISTS "dead_letters_org_status_idx";

DROP INDEX CONCURRENTLY IF EXISTS "dead_letters_org_created_idx";

DROP INDEX CONCURRENTLY IF EXISTS "external_run_steps_org_observed_idx";

DROP INDEX CONCURRENTLY IF EXISTS "external_runs_org_observed_idx";

DROP INDEX CONCURRENTLY IF EXISTS "external_workflows_org_observed_idx";

DROP INDEX CONCURRENTLY IF EXISTS "prompts_org_created_idx";

DROP INDEX CONCURRENTLY IF EXISTS "recovery_feedback_org_workflow_idx";

DROP INDEX CONCURRENTLY IF EXISTS "replay_campaigns_org_created_idx";

DROP INDEX CONCURRENTLY IF EXISTS "trigger_events_org_created_idx";

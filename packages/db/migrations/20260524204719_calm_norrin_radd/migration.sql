-- Three hot-path indexes for billing/dashboard, rate-limit dedup, and
-- auto-healing watcher queries.
--
-- IMPORTANT: drizzle-kit migrate runs every migration inside a
-- transaction. CREATE INDEX CONCURRENTLY cannot run inside a
-- transaction block (Postgres error 25001). So these indexes use
-- plain CREATE INDEX with IF NOT EXISTS — fine for empty/small dev
-- and CI databases (the build is near-instant when there are no
-- rows), but a production deploy with live traffic must NOT rely on
-- this migration to create the indexes from scratch (it would hold a
-- ShareLock on each table for the entire build).
--
-- The production playbook is: an operator runs the sibling
-- `production-rollout.sql` (CONCURRENTLY variants of these three
-- statements) FIRST, against a connection outside any transaction.
-- When drizzle-kit migrate then runs as part of the deploy, the
-- IF NOT EXISTS guards short-circuit and the migration is recorded
-- in __drizzle_migrations without re-creating anything. See
-- AGENTS.md "Migrations" bullet for the convention.
CREATE INDEX IF NOT EXISTS "audit_logs_metadata_gin_idx" ON "audit_logs" USING gin ("metadata" jsonb_path_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "auto_healing_runs_org_validated_idx" ON "auto_healing_runs" ("org_id") WHERE "status" = 'validated';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_events_org_metric_created_idx" ON "usage_events" ("org_id","metric","created_at" DESC NULLS LAST);

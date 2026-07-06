-- Production rollout runbook for the hot-path index in this migration.
-- NOT run by drizzle-kit. Apply BEFORE the deploy's `pnpm migrate` via:
--
--   psql -v ON_ERROR_STOP=1 -f production-rollout.sql
--
-- `CREATE INDEX CONCURRENTLY` cannot run inside a transaction (Postgres
-- error 25001) and drizzle-kit wraps migration.sql in one, hence this
-- sibling file (see AGENTS.md "Hot-path indexes use a two-file pattern").
-- After this completes, migration.sql's `IF NOT EXISTS` guard short-circuits.
--
-- The `text_pattern_ops` opclass on "action" is required for the audit
-- viewer's `action LIKE 'prefix%'` filter to use the index under the default
-- collation — drizzle's index builder cannot emit an opclass, so it is added
-- by hand here and in migration.sql.

CREATE INDEX CONCURRENTLY IF NOT EXISTS "audit_logs_org_action_created_idx"
  ON "audit_logs" ("org_id", "action" text_pattern_ops, "created_at" DESC NULLS LAST);

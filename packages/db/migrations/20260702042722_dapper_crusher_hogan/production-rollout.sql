-- Production rollout runbook for the hot-path indexes in this migration.
-- NOT run by drizzle-kit. Apply BEFORE the deploy's `pnpm migrate` via:
--
--   psql -v ON_ERROR_STOP=1 -f production-rollout.sql
--
-- `CREATE INDEX CONCURRENTLY` cannot run inside a transaction (Postgres
-- error 25001) and drizzle-kit wraps migration.sql in one, hence this
-- sibling file (see AGENTS.md "Hot-path indexes use a two-file pattern").
-- After these complete, migration.sql's `IF NOT EXISTS` guards short-circuit.

CREATE INDEX CONCURRENTLY IF NOT EXISTS "dead_letters_org_created_idx"
  ON "dead_letters" ("org_id", "created_at" DESC NULLS LAST, "id" DESC NULLS LAST);

CREATE INDEX CONCURRENTLY IF NOT EXISTS "run_nodes_running_started_idx"
  ON "run_nodes" ("started_at") WHERE "status" = 'running';

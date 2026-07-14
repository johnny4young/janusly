-- Production pre-deploy rollout for recovery replay hot-path indexes.
--
-- drizzle-kit executes migration.sql inside a transaction, so production
-- operators should build these indexes concurrently before `pnpm migrate`:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -f production-rollout.sql
--
-- The transactional migration uses the same names with IF NOT EXISTS
-- semantics supplied by Postgres when the indexes already exist.

CREATE INDEX CONCURRENTLY IF NOT EXISTS "dead_letters_org_replay_claimed_idx"
  ON "dead_letters" ("org_id", "replay_claimed_at" DESC NULLS LAST);

CREATE INDEX CONCURRENTLY IF NOT EXISTS "dead_letters_org_run_node_created_idx"
  ON "dead_letters" ("org_id", "run_id", "node_id", "created_at");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "recovery_item_children_org_dlq_idx"
  ON "recovery_item_children" ("org_id", "dead_letter_id");

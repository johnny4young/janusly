-- Production-only preflight. Run these statements outside a transaction
-- before the matching Drizzle migration to avoid blocking writes while the
-- two recovery-item indexes are built. The transactional migration uses
-- IF NOT EXISTS and will then add first_action_at without rebuilding them.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "recovery_items_org_created_idx"
  ON "recovery_items" ("org_id", "created_at");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "recovery_items_org_signature_first_idx"
  ON "recovery_items" ("org_id", "error_signature", "first_occurred_at");

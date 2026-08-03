-- Mirror of drizzle 20260731123433_keyset_list_indexes: list keysets get
-- composite (org, created_at DESC, id DESC) indexes aligned with their
-- ORDER BY; the narrower org+created indexes they replace are dropped.
-- +goose Up
CREATE INDEX IF NOT EXISTS "runs_org_created_id_idx" ON "runs" ("org_id","created_at" DESC,"id" DESC);
CREATE INDEX IF NOT EXISTS "workflows_org_created_id_idx" ON "workflows" ("org_id","created_at" DESC,"id" DESC);
CREATE INDEX IF NOT EXISTS "workflows_org_deleted_idx" ON "workflows" ("org_id","deleted_at" DESC,"id" DESC) WHERE "deleted_at" IS NOT NULL;
DROP INDEX IF EXISTS "runs_org_created_idx";
DROP INDEX IF EXISTS "workflows_org_created_idx";

-- +goose Down
DROP INDEX IF EXISTS "runs_org_created_id_idx";
DROP INDEX IF EXISTS "workflows_org_created_id_idx";
DROP INDEX IF EXISTS "workflows_org_deleted_idx";

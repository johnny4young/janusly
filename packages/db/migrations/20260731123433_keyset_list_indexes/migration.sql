CREATE INDEX IF NOT EXISTS "runs_org_created_id_idx" ON "runs" ("org_id","created_at" DESC,"id" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflows_org_created_id_idx" ON "workflows" ("org_id","created_at" DESC,"id" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflows_org_deleted_idx" ON "workflows" ("org_id","deleted_at" DESC,"id" DESC) WHERE "deleted_at" IS NOT NULL;--> statement-breakpoint
DROP INDEX IF EXISTS "runs_org_created_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "workflows_org_created_idx";

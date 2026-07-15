CREATE INDEX IF NOT EXISTS "usage_events_org_run_created_idx" ON "usage_events" ("org_id","run_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "run_id" IS NOT NULL;

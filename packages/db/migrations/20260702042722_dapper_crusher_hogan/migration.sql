CREATE INDEX IF NOT EXISTS "dead_letters_org_created_idx" ON "dead_letters" ("org_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "run_nodes_running_started_idx" ON "run_nodes" ("started_at") WHERE "status" = 'running';

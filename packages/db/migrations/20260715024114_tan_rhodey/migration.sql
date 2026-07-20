ALTER TABLE "run_nodes" ADD COLUMN IF NOT EXISTS "waiting_repair_after" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "run_nodes_waiting_target_idx" ON "run_nodes" ("waiting_repair_after" NULLS FIRST,(COALESCE("state_json" #>> '{waiting,deadlineAt}', "state_json" #>> '{waiting,wakeAt}')),"run_id","node_id") WHERE "status" = 'waiting';

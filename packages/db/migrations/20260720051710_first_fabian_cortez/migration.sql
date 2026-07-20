ALTER TABLE "trigger_events" ADD COLUMN "backfill_claim_token" text;--> statement-breakpoint
ALTER TABLE "trigger_events" ADD COLUMN "backfill_claimed_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "trigger_events_backfill_claim_idx" ON "trigger_events" ("org_id","workflow_id","backfill_claimed_at") WHERE "status" = 'backfilling';
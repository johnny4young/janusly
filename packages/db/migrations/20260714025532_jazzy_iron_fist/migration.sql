ALTER TABLE "recovery_items" ADD COLUMN "first_action_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "recovery_items_org_created_idx" ON "recovery_items" ("org_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "recovery_items_org_signature_first_idx" ON "recovery_items" ("org_id","error_signature","first_occurred_at");

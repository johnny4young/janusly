ALTER TABLE "dead_letters" ADD COLUMN "replay_claim_token" text;--> statement-breakpoint
ALTER TABLE "dead_letters" ADD COLUMN "replay_claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "run_nodes" ADD COLUMN "recovery_claim_token" text;--> statement-breakpoint
ALTER TABLE "run_nodes" ADD COLUMN "recovery_playbook_id" text;--> statement-breakpoint
ALTER TABLE "run_nodes" ADD COLUMN "recovery_validation_run_id" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dead_letters_org_replay_claimed_idx" ON "dead_letters" ("org_id","replay_claimed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dead_letters_org_run_node_created_idx" ON "dead_letters" ("org_id","run_id","node_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "recovery_item_children_org_dlq_idx" ON "recovery_item_children" ("org_id","dead_letter_id");

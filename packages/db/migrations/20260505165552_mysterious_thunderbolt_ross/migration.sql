ALTER TABLE "runs" ADD COLUMN "replay_mode" text;--> statement-breakpoint
CREATE INDEX "runs_org_replay_mode_idx" ON "runs" ("org_id","replay_mode");
ALTER TABLE "auto_healing_runs" ADD COLUMN "publication_receipt" text;--> statement-breakpoint
ALTER TABLE "auto_healing_runs" ADD COLUMN "publication_repair_after" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "auto_healing_runs" ADD COLUMN "publication_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "auto_healing_runs_publication_repair_idx" ON "auto_healing_runs" ("publication_repair_after","id") WHERE "publication_repair_after" IS NOT NULL AND "status" IN ('publishing', 'publish_failed');
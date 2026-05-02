ALTER TABLE "runs" ADD COLUMN "parent_run_id" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "parent_node_id" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "trace_id" text;--> statement-breakpoint
CREATE INDEX "runs_parent_idx" ON "runs" ("parent_run_id");
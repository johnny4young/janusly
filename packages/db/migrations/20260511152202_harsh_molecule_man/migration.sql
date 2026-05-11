CREATE TABLE "schedule_entries" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"workflow_id" text NOT NULL,
	"workflow_version_id" text NOT NULL,
	"node_id" text NOT NULL,
	"cron_expression" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_run_id" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX "schedule_entries_org_version_node_idx" ON "schedule_entries" ("org_id","workflow_version_id","node_id");--> statement-breakpoint
CREATE INDEX "schedule_entries_org_enabled_idx" ON "schedule_entries" ("org_id","enabled");--> statement-breakpoint
CREATE INDEX "schedule_entries_org_workflow_idx" ON "schedule_entries" ("org_id","workflow_id");
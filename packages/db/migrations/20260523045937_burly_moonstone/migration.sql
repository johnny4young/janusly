CREATE TABLE "workflow_metadata" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"workflow_id" text NOT NULL,
	"owners" jsonb DEFAULT '[]' NOT NULL,
	"runbook_markdown" text,
	"description" text,
	"tags" jsonb DEFAULT '[]' NOT NULL,
	"slack_channel" text,
	"linear_project" text,
	"severity_default" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_metadata_org_workflow_idx" ON "workflow_metadata" ("org_id","workflow_id");--> statement-breakpoint
CREATE INDEX "workflow_metadata_org_updated_idx" ON "workflow_metadata" ("org_id","updated_at" DESC NULLS LAST);

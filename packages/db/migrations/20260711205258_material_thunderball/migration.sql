CREATE TABLE "recovery_playbooks" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"workflow_id" text,
	"signature" text NOT NULL,
	"version" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"title" text NOT NULL,
	"instructions_markdown" text NOT NULL,
	"evidence_requirements_json" jsonb NOT NULL,
	"source_workflow_version_id" text NOT NULL,
	"approach_label" text DEFAULT 'other' NOT NULL,
	"successful_uses" integer DEFAULT 0 NOT NULL,
	"regressions" integer DEFAULT 0 NOT NULL,
	"last_validated_at" timestamp with time zone,
	"last_validation_run_id" text,
	"last_applied_validation_run_id" text,
	"activated_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "recovery_playbook_validation_recorded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "recovery_playbook_applied_recorded_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "recovery_playbooks_org_signature_version_idx" ON "recovery_playbooks" ("org_id","signature","version");--> statement-breakpoint
CREATE UNIQUE INDEX "recovery_playbooks_org_source_version_idx" ON "recovery_playbooks" ("org_id","source_workflow_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "recovery_playbooks_one_active_match_idx" ON "recovery_playbooks" ("org_id","workflow_id","signature") WHERE "status" = 'active';--> statement-breakpoint
CREATE INDEX "recovery_playbooks_org_signature_status_idx" ON "recovery_playbooks" ("org_id","signature","status");--> statement-breakpoint
CREATE INDEX "recovery_playbooks_org_workflow_idx" ON "recovery_playbooks" ("org_id","workflow_id");
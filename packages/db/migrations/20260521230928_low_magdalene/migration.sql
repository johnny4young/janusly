CREATE TABLE "auto_healing_runs" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"dead_letter_id" text NOT NULL,
	"signature" text NOT NULL,
	"status" text NOT NULL,
	"proposed_patch_json" jsonb,
	"approach_label" text,
	"confidence" integer,
	"validation_run_id" text,
	"validation_signature" text,
	"decision_actor" text,
	"decline_reason" text,
	"loop_attempt_count" integer NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "auto_healing_runs_org_status_created_idx" ON "auto_healing_runs" ("org_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "auto_healing_runs_org_signature_created_idx" ON "auto_healing_runs" ("org_id","signature","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "auto_healing_runs_org_dlq_idx" ON "auto_healing_runs" ("org_id","dead_letter_id");
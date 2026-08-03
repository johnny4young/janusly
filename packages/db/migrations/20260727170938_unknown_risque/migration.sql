CREATE TABLE "recovery_case_transitions" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"case_id" text NOT NULL,
	"from_state" text NOT NULL,
	"to_state" text NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_id" text,
	"evidence_json" jsonb NOT NULL,
	"reason" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recovery_cases" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"run_id" text NOT NULL,
	"workflow_id" text,
	"workflow_version_id" text NOT NULL,
	"source" text NOT NULL,
	"detector_id" text NOT NULL,
	"source_node_id" text NOT NULL,
	"detector_kind" text NOT NULL,
	"action" text NOT NULL,
	"message" text NOT NULL,
	"details_json" jsonb,
	"state" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "outcome_status" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "semantic_violation_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "recovery_case_transitions_case_to_idx" ON "recovery_case_transitions" ("case_id","to_state");--> statement-breakpoint
CREATE INDEX "recovery_case_transitions_case_created_idx" ON "recovery_case_transitions" ("case_id","occurred_at");--> statement-breakpoint
CREATE INDEX "recovery_case_transitions_org_created_idx" ON "recovery_case_transitions" ("org_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "recovery_cases_org_run_detector_idx" ON "recovery_cases" ("org_id","run_id","detector_id");--> statement-breakpoint
CREATE INDEX "recovery_cases_org_state_created_idx" ON "recovery_cases" ("org_id","state","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "recovery_cases_run_source_idx" ON "recovery_cases" ("run_id","source_node_id");
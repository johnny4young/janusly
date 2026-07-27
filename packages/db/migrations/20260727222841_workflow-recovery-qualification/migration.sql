CREATE TABLE "workflow_recovery_qualifications" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"workflow_id" text NOT NULL,
	"baseline_version_id" text NOT NULL,
	"candidate_version_id" text NOT NULL,
	"dataset_version" text NOT NULL,
	"dataset_digest" text NOT NULL,
	"mode" text NOT NULL,
	"status" text NOT NULL,
	"summary_json" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_recovery_qualifications_exact_idx" ON "workflow_recovery_qualifications" ("org_id","workflow_id","baseline_version_id","candidate_version_id","dataset_version","dataset_digest");--> statement-breakpoint
CREATE INDEX "workflow_recovery_qualifications_pair_idx" ON "workflow_recovery_qualifications" ("org_id","workflow_id","baseline_version_id","candidate_version_id","created_at" DESC NULLS LAST);
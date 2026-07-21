CREATE TABLE "workflow_rollout_outcomes" (
	"run_id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"rollout_id" text NOT NULL,
	"workflow_id" text NOT NULL,
	"variant" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_rollouts" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"workflow_id" text NOT NULL,
	"baseline_version_id" text NOT NULL,
	"canary_version_id" text NOT NULL,
	"traffic_percent" integer NOT NULL,
	"minimum_sample_size" integer NOT NULL,
	"minimum_success_rate_percent" integer NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"baseline_succeeded" integer DEFAULT 0 NOT NULL,
	"baseline_failed" integer DEFAULT 0 NOT NULL,
	"canary_succeeded" integer DEFAULT 0 NOT NULL,
	"canary_failed" integer DEFAULT 0 NOT NULL,
	"rolled_back_reason" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"last_outcome_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "workflow_rollout_id" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "workflow_rollout_variant" text;--> statement-breakpoint
ALTER TABLE "trigger_events" ADD COLUMN "workflow_rollout_id" text;--> statement-breakpoint
ALTER TABLE "trigger_events" ADD COLUMN "workflow_rollout_variant" text;--> statement-breakpoint
CREATE INDEX "runs_rollout_idx" ON "runs" ("workflow_rollout_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "workflow_rollout_outcomes_rollout_created_idx" ON "workflow_rollout_outcomes" ("rollout_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_rollouts_one_active_idx" ON "workflow_rollouts" ("org_id","workflow_id") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX "workflow_rollouts_org_workflow_created_idx" ON "workflow_rollouts" ("org_id","workflow_id","created_at" DESC NULLS LAST);
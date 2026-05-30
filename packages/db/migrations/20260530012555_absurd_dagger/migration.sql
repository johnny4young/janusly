CREATE TABLE "confidence_calibrations" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"approach_label" text NOT NULL,
	"accept_rate" real NOT NULL,
	"sample_size" integer NOT NULL,
	"curve_slope" real NOT NULL,
	"curve_intercept" real NOT NULL,
	"last_computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eval_datasets" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"workflow_id" text,
	"example_count" integer DEFAULT 0 NOT NULL,
	"retention_days" integer,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eval_examples" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"dataset_id" text NOT NULL,
	"source_feedback_id" text NOT NULL,
	"workflow_id" text,
	"dead_letter_id" text,
	"failure_signature" text DEFAULT '' NOT NULL,
	"input_context" text DEFAULT '' NOT NULL,
	"expected_approach_label" text NOT NULL,
	"accepted" boolean DEFAULT true NOT NULL,
	"suggestion_mode" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "experiments" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"control_ref" text NOT NULL,
	"candidate_ref" text NOT NULL,
	"eval_dataset_id" text NOT NULL,
	"scorer_kind" text DEFAULT 'string_equality' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"summary_json" jsonb,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "snippets" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"category" text NOT NULL,
	"tags" jsonb DEFAULT '[]' NOT NULL,
	"builtin" boolean DEFAULT false NOT NULL,
	"nodes_json" jsonb DEFAULT '[]' NOT NULL,
	"edges_json" jsonb DEFAULT '[]' NOT NULL,
	"entry_node_id" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trigger_events" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"trigger_type" text NOT NULL,
	"workflow_id" text,
	"workflow_version_id" text NOT NULL,
	"node_id" text NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"run_id" text,
	"dedupe_key" text,
	"payload_json" jsonb NOT NULL,
	"skipped_reason" text,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "upstream_health_sources" (
	"id" text PRIMARY KEY,
	"org_id" text DEFAULT 'default' NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"url" text NOT NULL,
	"expected_components" jsonb DEFAULT '[]' NOT NULL,
	"check_interval_seconds" integer DEFAULT 60 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_status" text,
	"last_degraded" boolean DEFAULT false NOT NULL,
	"last_checked_at" timestamp with time zone,
	"last_error_reason" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "hold_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memory_entries" ADD COLUMN "hold_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "recovery_feedback" ADD COLUMN "raw_confidence" integer;--> statement-breakpoint
ALTER TABLE "recovery_feedback" ADD COLUMN "eval_consent" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "recovery_feedback" ADD COLUMN "hold_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "run_events" ADD COLUMN "hold_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN "hold_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workflow_versions" ADD COLUMN "upstream_health_sources" jsonb;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "paused_reason" text;--> statement-breakpoint
CREATE UNIQUE INDEX "confidence_calibrations_org_approach_idx" ON "confidence_calibrations" ("org_id","approach_label");--> statement-breakpoint
CREATE UNIQUE INDEX "eval_datasets_org_name_idx" ON "eval_datasets" ("org_id","name");--> statement-breakpoint
CREATE INDEX "eval_datasets_org_created_idx" ON "eval_datasets" ("org_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "eval_examples_org_dataset_idx" ON "eval_examples" ("org_id","dataset_id");--> statement-breakpoint
CREATE INDEX "experiments_org_created_idx" ON "experiments" ("org_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "experiments_org_dataset_idx" ON "experiments" ("org_id","eval_dataset_id");--> statement-breakpoint
CREATE UNIQUE INDEX "snippets_org_name_idx" ON "snippets" ("org_id","name");--> statement-breakpoint
CREATE INDEX "snippets_org_updated_idx" ON "snippets" ("org_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "trigger_events_org_dedupe_idx" ON "trigger_events" ("org_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "trigger_events_org_created_idx" ON "trigger_events" ("org_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "trigger_events_org_node_idx" ON "trigger_events" ("org_id","workflow_version_id","node_id");--> statement-breakpoint
CREATE UNIQUE INDEX "upstream_health_sources_org_name_idx" ON "upstream_health_sources" ("org_id","name");--> statement-breakpoint
CREATE INDEX "upstream_health_sources_enabled_idx" ON "upstream_health_sources" ("enabled");
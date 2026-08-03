CREATE TABLE "external_recovery_cases" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"subject_key" text NOT NULL,
	"subject_kind" text NOT NULL,
	"external_workflow_id" text NOT NULL,
	"external_run_id" text NOT NULL,
	"external_step_id" text,
	"state" text NOT NULL,
	"failure_snapshot_json" jsonb,
	"evidence_json" jsonb DEFAULT '[]' NOT NULL,
	"first_detected_at" timestamp with time zone NOT NULL,
	"last_observed_at" timestamp with time zone NOT NULL,
	"observed_recovered_at" timestamp with time zone,
	"last_sequence" bigint NOT NULL,
	"last_event_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "external_run_steps" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"external_workflow_id" text NOT NULL,
	"external_run_id" text NOT NULL,
	"external_step_id" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'unknown' NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"snapshot_json" jsonb,
	"evidence_json" jsonb DEFAULT '[]' NOT NULL,
	"last_sequence" bigint DEFAULT -1 NOT NULL,
	"last_event_id" text,
	"last_observed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "external_runs" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"external_workflow_id" text NOT NULL,
	"external_run_id" text NOT NULL,
	"status" text DEFAULT 'unknown' NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"snapshot_json" jsonb,
	"evidence_json" jsonb DEFAULT '[]' NOT NULL,
	"last_sequence" bigint DEFAULT -1 NOT NULL,
	"last_event_id" text,
	"last_observed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "external_runtime_connections" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"runtime_key" text NOT NULL,
	"signing_credential_name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "external_runtime_events" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"event_id" text NOT NULL,
	"source" text NOT NULL,
	"event_type" text NOT NULL,
	"subject" text,
	"event_time" timestamp with time zone NOT NULL,
	"sequence" bigint NOT NULL,
	"payload_json" jsonb NOT NULL,
	"projection_state" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "external_workflows" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"external_workflow_id" text NOT NULL,
	"name" text NOT NULL,
	"version" text,
	"snapshot_json" jsonb,
	"evidence_json" jsonb DEFAULT '[]' NOT NULL,
	"last_sequence" bigint DEFAULT -1 NOT NULL,
	"last_event_id" text,
	"last_observed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "external_recovery_cases_connection_subject_idx" ON "external_recovery_cases" ("connection_id","subject_key");--> statement-breakpoint
CREATE INDEX "external_recovery_cases_org_state_observed_idx" ON "external_recovery_cases" ("org_id","state","last_observed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "external_run_steps_connection_run_step_idx" ON "external_run_steps" ("connection_id","external_run_id","external_step_id");--> statement-breakpoint
CREATE INDEX "external_run_steps_org_observed_idx" ON "external_run_steps" ("org_id","last_observed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "external_runs_connection_external_idx" ON "external_runs" ("connection_id","external_run_id");--> statement-breakpoint
CREATE INDEX "external_runs_org_observed_idx" ON "external_runs" ("org_id","last_observed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "external_runs_connection_workflow_idx" ON "external_runs" ("connection_id","external_workflow_id","last_observed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "external_runtime_connections_org_name_idx" ON "external_runtime_connections" ("org_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "external_runtime_connections_org_runtime_idx" ON "external_runtime_connections" ("org_id","runtime_key");--> statement-breakpoint
CREATE INDEX "external_runtime_connections_org_enabled_idx" ON "external_runtime_connections" ("org_id","enabled");--> statement-breakpoint
CREATE UNIQUE INDEX "external_runtime_events_connection_source_event_idx" ON "external_runtime_events" ("connection_id","source","event_id");--> statement-breakpoint
CREATE INDEX "external_runtime_events_org_received_idx" ON "external_runtime_events" ("org_id","received_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "external_workflows_connection_external_idx" ON "external_workflows" ("connection_id","external_workflow_id");--> statement-breakpoint
CREATE INDEX "external_workflows_org_observed_idx" ON "external_workflows" ("org_id","last_observed_at" DESC NULLS LAST);
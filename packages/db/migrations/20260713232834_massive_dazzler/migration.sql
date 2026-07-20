CREATE TABLE "recovery_impact_events" (
	"dead_letter_id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"run_id" text NOT NULL,
	"node_id" text NOT NULL,
	"user_id" text,
	"recovered_at" timestamp with time zone NOT NULL,
	"downtime_ended_ms" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recovery_impact_rollups" (
	"org_id" text PRIMARY KEY,
	"total_recovered" integer DEFAULT 0 NOT NULL,
	"downtime_ended_ms" bigint DEFAULT 0 NOT NULL,
	"first_recovered_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "run_nodes" ADD COLUMN "recovery_dead_letter_id" text;--> statement-breakpoint
ALTER TABLE "run_nodes" ADD COLUMN "recovery_requested_by" text;--> statement-breakpoint
CREATE INDEX "recovery_impact_events_org_recovered_idx" ON "recovery_impact_events" ("org_id","recovered_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "recovery_impact_events_org_user_recovered_idx" ON "recovery_impact_events" ("org_id","user_id","recovered_at" DESC NULLS LAST);--> statement-breakpoint

CREATE TABLE "alert_dispatches" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"policy_id" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"dispatched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"outcome" text NOT NULL,
	"channel_results" jsonb NOT NULL,
	"trigger_payload" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alert_policies" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"trigger" text NOT NULL,
	"parameters" jsonb DEFAULT '{}' NOT NULL,
	"channels" jsonb NOT NULL,
	"cooldown_seconds" integer DEFAULT 900 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "alert_dispatches_org_policy_dedupe_idx" ON "alert_dispatches" ("org_id","policy_id","dedupe_key","dispatched_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "alert_dispatches_org_dispatched_idx" ON "alert_dispatches" ("org_id","dispatched_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "alert_policies_org_name_idx" ON "alert_policies" ("org_id","name");--> statement-breakpoint
CREATE INDEX "alert_policies_org_trigger_enabled_idx" ON "alert_policies" ("org_id","trigger","enabled");

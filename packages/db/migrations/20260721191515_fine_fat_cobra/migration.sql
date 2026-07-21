CREATE TABLE "replay_campaign_items" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"campaign_id" text NOT NULL,
	"dead_letter_id" text NOT NULL,
	"position" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"claim_token" text,
	"claimed_at" timestamp with time zone,
	"error" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "replay_campaigns" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"cluster_signature" text NOT NULL,
	"filter_json" jsonb DEFAULT '{}' NOT NULL,
	"pacing_ms" integer DEFAULT 1000 NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"total_count" integer NOT NULL,
	"replayed_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"cancelled_count" integer DEFAULT 0 NOT NULL,
	"created_by" text NOT NULL,
	"cancelled_by" text,
	"next_dispatch_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "replay_campaign_items_campaign_dlq_idx" ON "replay_campaign_items" ("campaign_id","dead_letter_id");--> statement-breakpoint
CREATE UNIQUE INDEX "replay_campaign_items_campaign_position_idx" ON "replay_campaign_items" ("campaign_id","position");--> statement-breakpoint
CREATE INDEX "replay_campaign_items_org_campaign_status_idx" ON "replay_campaign_items" ("org_id","campaign_id","status","position");--> statement-breakpoint
CREATE INDEX "replay_campaigns_org_created_idx" ON "replay_campaigns" ("org_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "replay_campaigns_due_idx" ON "replay_campaigns" ("next_dispatch_at","id") WHERE "status" = 'running';
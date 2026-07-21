CREATE TABLE "slack_interaction_connections" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"team_id" text NOT NULL,
	"signing_credential_name" text NOT NULL,
	"user_mappings" jsonb DEFAULT '[]' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slack_interaction_receipts" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "slack_interaction_connections_org_name_idx" ON "slack_interaction_connections" ("org_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "slack_interaction_connections_org_team_idx" ON "slack_interaction_connections" ("org_id","team_id");--> statement-breakpoint
CREATE INDEX "slack_interaction_connections_org_enabled_idx" ON "slack_interaction_connections" ("org_id","enabled");--> statement-breakpoint
CREATE INDEX "slack_interaction_receipts_connection_created_idx" ON "slack_interaction_receipts" ("connection_id","created_at");
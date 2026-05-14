CREATE TABLE "scim_directories" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"provider_directory_id" text NOT NULL,
	"directory_type" text,
	"default_role" text DEFAULT 'viewer' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "scim_group_state" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"scim_directory_id" text NOT NULL,
	"provider_group_id" text NOT NULL,
	"name" text NOT NULL,
	"last_synced_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "scim_processed_events" (
	"event_id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"scim_directory_id" text NOT NULL,
	"event_type" text NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "scim_user_state" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"scim_directory_id" text NOT NULL,
	"provider_user_id" text NOT NULL,
	"email" text NOT NULL,
	"first_name" text,
	"last_name" text,
	"active" boolean DEFAULT true NOT NULL,
	"last_event_id" text,
	"last_event_timestamp" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX "scim_directories_org_idx" ON "scim_directories" ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "scim_directories_provider_directory_idx" ON "scim_directories" ("provider_directory_id");--> statement-breakpoint
CREATE UNIQUE INDEX "scim_group_state_directory_group_idx" ON "scim_group_state" ("scim_directory_id","provider_group_id");--> statement-breakpoint
CREATE INDEX "scim_processed_events_processed_at_idx" ON "scim_processed_events" ("processed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "scim_user_state_directory_user_idx" ON "scim_user_state" ("scim_directory_id","provider_user_id");--> statement-breakpoint
CREATE INDEX "scim_user_state_org_email_idx" ON "scim_user_state" ("org_id","email");
CREATE TABLE "scim_group_role_mappings" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"scim_directory_id" text NOT NULL,
	"provider_group_id" text NOT NULL,
	"role" text NOT NULL,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "scim_user_groups" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"scim_directory_id" text NOT NULL,
	"provider_user_id" text NOT NULL,
	"provider_group_id" text NOT NULL,
	"added_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX "scim_group_role_mappings_directory_group_idx" ON "scim_group_role_mappings" ("scim_directory_id","provider_group_id");--> statement-breakpoint
CREATE INDEX "scim_group_role_mappings_org_idx" ON "scim_group_role_mappings" ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "scim_user_groups_user_group_idx" ON "scim_user_groups" ("scim_directory_id","provider_user_id","provider_group_id");--> statement-breakpoint
CREATE INDEX "scim_user_groups_directory_user_idx" ON "scim_user_groups" ("scim_directory_id","provider_user_id");
CREATE TABLE "org_roles" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"inherits_from" text NOT NULL,
	"description" text,
	"is_builtin" boolean DEFAULT false NOT NULL,
	"granted_permissions" jsonb,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX "org_roles_org_name_idx" ON "org_roles" ("org_id","name");
CREATE TABLE "invitations" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text DEFAULT 'viewer' NOT NULL,
	"invited_by" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "sso_connections" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"provider" text NOT NULL,
	"provider_connection_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"config_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "verified_domains" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"domain" text NOT NULL,
	"default_role" text DEFAULT 'viewer' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_org_email_idx" ON "invitations" ("org_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "sso_connections_org_provider_idx" ON "sso_connections" ("org_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "verified_domains_org_domain_idx" ON "verified_domains" ("org_id","domain");
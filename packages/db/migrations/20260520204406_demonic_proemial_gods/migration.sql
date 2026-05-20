CREATE TABLE "prompt_versions" (
	"id" text PRIMARY KEY,
	"org_id" text DEFAULT 'default' NOT NULL,
	"prompt_id" text NOT NULL,
	"version" integer NOT NULL,
	"template_text" text NOT NULL,
	"variables" jsonb DEFAULT '[]' NOT NULL,
	"status" text DEFAULT 'published' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "prompts" (
	"id" text PRIMARY KEY,
	"org_id" text DEFAULT 'default' NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"pinned_version_id" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX "prompt_versions_org_prompt_version_idx" ON "prompt_versions" ("org_id","prompt_id","version");--> statement-breakpoint
CREATE INDEX "prompt_versions_org_prompt_created_idx" ON "prompt_versions" ("org_id","prompt_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "prompts_org_name_idx" ON "prompts" ("org_id","name");--> statement-breakpoint
CREATE INDEX "prompts_org_created_idx" ON "prompts" ("org_id","created_at" DESC NULLS LAST);
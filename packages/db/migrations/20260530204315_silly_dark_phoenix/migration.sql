CREATE TABLE "onboarding_progress" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"step" text DEFAULT 'org_created' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"skipped_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "onboarding_progress_org_user_idx" ON "onboarding_progress" ("org_id","user_id");
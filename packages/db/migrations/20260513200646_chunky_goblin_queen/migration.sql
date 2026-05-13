CREATE TABLE "workflow_budgets" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"workflow_id" text NOT NULL,
	"monthly_usd" real NOT NULL,
	"warn_percent" integer DEFAULT 80 NOT NULL,
	"policy" text DEFAULT 'warn' NOT NULL,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_budgets_org_workflow_idx" ON "workflow_budgets" ("org_id","workflow_id");
CREATE TABLE "recovery_items" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"dead_letter_id" text NOT NULL,
	"workflow_id" text,
	"owner" text,
	"severity" text DEFAULT 'p3' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"sla_target_at" timestamp with time zone NOT NULL,
	"resolution_reason" text,
	"resolved_by" text,
	"resolved_at" timestamp with time zone,
	"comments" jsonb DEFAULT '[]' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "recovery_items_org_dlq_idx" ON "recovery_items" ("org_id","dead_letter_id");--> statement-breakpoint
CREATE INDEX "recovery_items_org_status_sla_idx" ON "recovery_items" ("org_id","status","sla_target_at");--> statement-breakpoint
CREATE INDEX "recovery_items_org_owner_idx" ON "recovery_items" ("org_id","owner");

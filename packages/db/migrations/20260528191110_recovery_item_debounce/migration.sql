CREATE TABLE "recovery_item_children" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"recovery_item_id" text NOT NULL,
	"dead_letter_id" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "recovery_items" ADD COLUMN "error_signature" text;--> statement-breakpoint
ALTER TABLE "recovery_items" ADD COLUMN "occurrence_count" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "recovery_items" ADD COLUMN "first_occurred_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "recovery_items" ADD COLUMN "last_occurred_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "recovery_item_children_item_dlq_idx" ON "recovery_item_children" ("recovery_item_id","dead_letter_id");--> statement-breakpoint
CREATE INDEX "recovery_item_children_item_occurred_idx" ON "recovery_item_children" ("recovery_item_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "recovery_items_org_wf_sig_idx" ON "recovery_items" ("org_id","workflow_id","error_signature");
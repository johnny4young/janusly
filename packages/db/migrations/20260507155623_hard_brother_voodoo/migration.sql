CREATE TABLE "recovery_feedback" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"user_id" text,
	"dead_letter_id" text NOT NULL,
	"workflow_id" text NOT NULL,
	"suggestion_mode" text NOT NULL,
	"approach_label" text NOT NULL,
	"accepted" boolean NOT NULL,
	"comment" text,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "recovery_feedback_org_workflow_idx" ON "recovery_feedback" ("org_id","workflow_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "recovery_feedback_org_dlq_idx" ON "recovery_feedback" ("org_id","dead_letter_id");
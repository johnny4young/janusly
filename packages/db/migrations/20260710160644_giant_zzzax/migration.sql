CREATE TABLE "recovery_feedback_health" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"workflow_id" text NOT NULL,
	"approach_label" text NOT NULL,
	"feedback_last_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"accepted_fix_last_seen" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "recovery_feedback_health_org_workflow_approach_idx" ON "recovery_feedback_health" ("org_id","workflow_id","approach_label");--> statement-breakpoint
CREATE INDEX "recovery_feedback_health_org_workflow_idx" ON "recovery_feedback_health" ("org_id","workflow_id");--> statement-breakpoint
INSERT INTO "recovery_feedback_health" (
  "id",
  "org_id",
  "workflow_id",
  "approach_label",
  "feedback_last_seen",
  "accepted_fix_last_seen"
)
SELECT
  'recovery-feedback-health:' || md5(
    "org_id" || chr(31) || "workflow_id" || chr(31) || "approach_label"
  ),
  "org_id",
  "workflow_id",
  "approach_label",
  max("created_at"),
  max("created_at") FILTER (WHERE "accepted")
FROM "recovery_feedback"
WHERE "created_at" IS NOT NULL
GROUP BY "org_id", "workflow_id", "approach_label"
ON CONFLICT ("org_id", "workflow_id", "approach_label") DO NOTHING;

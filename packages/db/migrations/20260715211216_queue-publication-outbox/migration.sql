ALTER TABLE "run_nodes" ADD COLUMN IF NOT EXISTS "queue_publication_repair_after" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "run_nodes" ADD COLUMN IF NOT EXISTS "queue_publication_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "parent_link_kind" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "parent_notification_after" timestamp with time zone;--> statement-breakpoint
WITH RECURSIVE "legacy_validation_children"("id") AS (
	SELECT "child"."id"
	FROM "runs" "child"
	INNER JOIN "runs" "parent" ON "child"."parent_run_id" = "parent"."id"
	WHERE "parent"."replay_mode" = 'validation'
		AND "child"."parent_node_id" IS NOT NULL
		AND "child"."parent_link_kind" IS NULL
		AND "child"."replay_mode" IS NULL
	UNION
	SELECT "child"."id"
	FROM "runs" "child"
	INNER JOIN "legacy_validation_children" "parent" ON "child"."parent_run_id" = "parent"."id"
	WHERE "child"."parent_node_id" IS NOT NULL
		AND "child"."parent_link_kind" IS NULL
		AND "child"."replay_mode" IS NULL
)
UPDATE "runs"
SET "parent_link_kind" = 'subworkflow', "replay_mode" = 'validation'
WHERE "id" IN (SELECT "id" FROM "legacy_validation_children");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "run_nodes_queue_publication_repair_idx" ON "run_nodes" ("queue_publication_repair_after","run_id","node_id") WHERE "queue_publication_repair_after" IS NOT NULL AND "status" IN ('pending', 'queued');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "runs_parent_notification_idx" ON "runs" ("parent_notification_after","id") WHERE "parent_notification_after" IS NOT NULL;

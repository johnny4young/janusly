-- Optional post-deploy historical reconciliation for terminal recovery impact.
--
-- This file is intentionally NOT executed by drizzle-kit. Run it only after
-- the application deployment is healthy:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -v batch_size=500 \
--     -f production-reconciliation.sql
--
-- Each invocation processes at most `batch_size` previously-unmaterialized
-- rows. Re-run until the final SELECT reports `remaining_candidates = 0`.
-- The INSERT ... RETURNING rollup makes every batch idempotent.

\if :{?batch_size}
\else
\set batch_size 500
\endif

BEGIN;

WITH candidates AS MATERIALIZED (
  SELECT
    d."id" AS "dead_letter_id",
    d."org_id",
    d."run_id",
    d."node_id",
    d."created_at",
    coalesce(d."replay_claimed_at", d."replayed_at") AS "replay_boundary",
    n."finished_at"
  FROM "dead_letters" d
  JOIN "run_nodes" n
    ON n."run_id" = d."run_id"
   AND n."node_id" = d."node_id"
  LEFT JOIN "recovery_impact_events" existing
    ON existing."dead_letter_id" = d."id"
  WHERE existing."dead_letter_id" IS NULL
    AND d."status" = 'replayed'
    AND coalesce(d."replay_claimed_at", d."replayed_at") IS NOT NULL
    AND n."status" = 'succeeded'
    AND n."finished_at" IS NOT NULL
    AND n."finished_at" >= coalesce(d."replay_claimed_at", d."replayed_at")
    AND NOT EXISTS (
      SELECT 1
      FROM "dead_letters" later
      WHERE later."org_id" = d."org_id"
        AND later."run_id" = d."run_id"
        AND later."node_id" = d."node_id"
        AND later."id" <> d."id"
        AND later."created_at" > coalesce(d."replay_claimed_at", d."replayed_at")
        AND later."created_at" <= n."finished_at"
    )
  ORDER BY d."created_at", d."id"
  LIMIT :batch_size
),
audit_candidates AS MATERIALIZED (
  SELECT
    c."dead_letter_id",
    a."user_id",
    1 AS "priority",
    a."created_at",
    a."id"
  FROM candidates c
  JOIN "audit_logs" a
    ON a."org_id" = c."org_id"
   AND a."target_type" = 'dlq'
   AND a."target_id" = c."dead_letter_id"
   AND a."action" IN ('dlq.replayed', 'recovery.cluster_apply')

  UNION ALL

  SELECT
    c."dead_letter_id",
    CASE
      WHEN a."metadata"->>'decisionActor' = 'auto' THEN 'system:auto-healing'
      ELSE nullif(a."metadata"->>'decisionActor', '')
    END,
    2,
    a."created_at",
    a."id"
  FROM candidates c
  JOIN "audit_logs" a
    ON a."org_id" = c."org_id"
   AND a."action" = 'auto_healing.applied'
   AND a."metadata"->>'deadLetterId' = c."dead_letter_id"

  UNION ALL

  SELECT
    c."dead_letter_id",
    a."user_id",
    3,
    a."created_at",
    a."id"
  FROM candidates c
  JOIN "audit_logs" a
    ON a."org_id" = c."org_id"
   AND a."action" = 'auto_healing.replay.triggered'
   AND a."metadata"->>'deadLetterId' = c."dead_letter_id"
),
actors AS MATERIALIZED (
  SELECT DISTINCT ON ("dead_letter_id")
    "dead_letter_id",
    "user_id"
  FROM audit_candidates
  WHERE "user_id" IS NOT NULL
  ORDER BY "dead_letter_id", "priority", "created_at" DESC NULLS LAST, "id" DESC
),
inserted AS (
  INSERT INTO "recovery_impact_events" (
    "dead_letter_id",
    "org_id",
    "run_id",
    "node_id",
    "user_id",
    "recovered_at",
    "downtime_ended_ms"
  )
  SELECT
    c."dead_letter_id",
    c."org_id",
    c."run_id",
    c."node_id",
    actors."user_id",
    c."finished_at",
    CASE
      WHEN c."created_at" IS NULL THEN 0
      ELSE greatest(
        0,
        floor(extract(epoch FROM (c."finished_at" - c."created_at")) * 1000)::bigint
      )
    END
  FROM candidates c
  LEFT JOIN actors ON actors."dead_letter_id" = c."dead_letter_id"
  ON CONFLICT ("dead_letter_id") DO NOTHING
  RETURNING "org_id", "downtime_ended_ms", "recovered_at"
),
batch_rollups AS (
  SELECT
    "org_id",
    count(*)::integer AS "total_recovered",
    coalesce(sum("downtime_ended_ms"), 0)::bigint AS "downtime_ended_ms",
    min("recovered_at") AS "first_recovered_at",
    max("recovered_at") AS "updated_at"
  FROM inserted
  GROUP BY "org_id"
)
INSERT INTO "recovery_impact_rollups" (
  "org_id",
  "total_recovered",
  "downtime_ended_ms",
  "first_recovered_at",
  "updated_at"
)
SELECT
  "org_id",
  "total_recovered",
  "downtime_ended_ms",
  "first_recovered_at",
  "updated_at"
FROM batch_rollups
ON CONFLICT ("org_id") DO UPDATE SET
  "total_recovered" = "recovery_impact_rollups"."total_recovered" + excluded."total_recovered",
  "downtime_ended_ms" = "recovery_impact_rollups"."downtime_ended_ms" + excluded."downtime_ended_ms",
  "first_recovered_at" = CASE
    WHEN "recovery_impact_rollups"."first_recovered_at" IS NULL THEN excluded."first_recovered_at"
    ELSE least("recovery_impact_rollups"."first_recovered_at", excluded."first_recovered_at")
  END,
  "updated_at" = greatest("recovery_impact_rollups"."updated_at", excluded."updated_at");

COMMIT;

SELECT CASE WHEN EXISTS (
  SELECT 1
  FROM "dead_letters" d
  JOIN "run_nodes" n
    ON n."run_id" = d."run_id"
   AND n."node_id" = d."node_id"
  LEFT JOIN "recovery_impact_events" existing
    ON existing."dead_letter_id" = d."id"
  WHERE existing."dead_letter_id" IS NULL
    AND d."status" = 'replayed'
    AND coalesce(d."replay_claimed_at", d."replayed_at") IS NOT NULL
    AND n."status" = 'succeeded'
    AND n."finished_at" IS NOT NULL
    AND n."finished_at" >= coalesce(d."replay_claimed_at", d."replayed_at")
    AND NOT EXISTS (
      SELECT 1
      FROM "dead_letters" later
      WHERE later."org_id" = d."org_id"
        AND later."run_id" = d."run_id"
        AND later."node_id" = d."node_id"
        AND later."id" <> d."id"
        AND later."created_at" > coalesce(d."replay_claimed_at", d."replayed_at")
        AND later."created_at" <= n."finished_at"
    )
  LIMIT 1
) THEN 1 ELSE 0 END AS "remaining_candidates";

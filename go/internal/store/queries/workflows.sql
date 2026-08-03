-- Workflows, versions, trash, rollouts, tags/folders/metadata, health.

-- name: InsertWorkflow :exec
INSERT INTO workflows (id, org_id, name, created_by)
VALUES ($1, $2, $3, $4);

-- name: GetWorkflow :one
SELECT id, org_id, name, status, paused_reason, created_by, created_at, deleted_at
FROM workflows
WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL;

-- name: ListWorkflows :many
SELECT id, org_id, name, status, created_by, created_at
FROM workflows
WHERE org_id = $1
  AND deleted_at IS NULL
  AND (created_at, id) < (sqlc.arg(before_created_at)::timestamptz, sqlc.arg(before_id)::text)
ORDER BY created_at DESC, id DESC
LIMIT sqlc.arg(page_limit);

-- Workflow list rows with the read-surface aggregates: run count and last
-- run status include production runs linked through saved versions only. The
-- metadata join drives tags/folders and the buffered-trigger count includes
-- both parked events and abandoned backfill claims after the shared 5m lease.
-- name: ListWorkflowRows :many
SELECT w.id, w.org_id, w.name, w.created_by, w.created_at, w.status,
       w.paused_reason, w.deleted_at,
       (SELECT count(*) FROM runs r
        JOIN workflow_versions wv ON wv.id = r.workflow_version_id
        WHERE r.org_id = w.org_id AND wv.workflow_id = w.id
          AND r.replay_mode IS NULL)::int AS run_count,
       COALESCE(last_run.status, '') AS last_run_status,
       COALESCE(m.tags, '[]'::jsonb) AS tags,
       m.folder,
       (SELECT count(*) FROM trigger_events te
        WHERE te.org_id = w.org_id AND te.workflow_id = w.id
          AND (te.status = 'buffered'
               OR (te.status = 'backfilling'
                   AND te.backfill_claimed_at < now() - interval '5 minutes')))::int
         AS buffered_trigger_count
FROM workflows w
LEFT JOIN workflow_metadata m ON m.org_id = w.org_id AND m.workflow_id = w.id
LEFT JOIN LATERAL (
  SELECT r.status FROM runs r
  JOIN workflow_versions wv ON wv.id = r.workflow_version_id
  WHERE r.org_id = w.org_id AND wv.workflow_id = w.id
    AND r.replay_mode IS NULL
  ORDER BY r.created_at DESC, r.id DESC LIMIT 1
) last_run ON true
WHERE w.org_id = $1 AND w.deleted_at IS NULL
  AND (w.created_at, w.id) < (sqlc.arg(before_created_at)::timestamptz, sqlc.arg(before_id)::text)
  AND (COALESCE(sqlc.arg(tags)::jsonb, '[]'::jsonb) = '[]'::jsonb
       OR COALESCE(m.tags, '[]'::jsonb) @> sqlc.arg(tags)::jsonb)
  AND (sqlc.narg(folder)::text IS NULL OR m.folder = sqlc.narg(folder)::text)
  AND (sqlc.narg(search_pattern)::text IS NULL
       OR w.name ILIKE sqlc.narg(search_pattern)::text ESCAPE '\'
       OR w.id ILIKE sqlc.narg(search_pattern)::text ESCAPE '\')
ORDER BY w.created_at DESC, w.id DESC
LIMIT sqlc.arg(page_limit);

-- name: ListWorkflowVersions :many
SELECT id, org_id, workflow_id, version, dag_json, created_by, created_at
FROM workflow_versions
WHERE workflow_id = $1 AND org_id = $2
ORDER BY version DESC;

-- name: SoftDeleteWorkflow :execrows
UPDATE workflows SET deleted_at = now()
WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL;

-- name: RestoreWorkflow :execrows
UPDATE workflows SET deleted_at = NULL
WHERE id = $1 AND org_id = $2 AND deleted_at IS NOT NULL;

-- name: GetWorkflowOwnerState :one
SELECT org_id, deleted_at FROM workflows WHERE id = $1;

-- The trash list: the same list-row shape with deletedAt populated,
-- ordered by (deleted_at, id) DESC with its own keyset.
-- name: ListDeletedWorkflowRows :many
SELECT w.id, w.org_id, w.name, w.created_by, w.created_at, w.status,
       w.paused_reason, w.deleted_at,
       (SELECT count(*) FROM runs r
        JOIN workflow_versions wv ON wv.id = r.workflow_version_id
        WHERE r.org_id = w.org_id AND wv.workflow_id = w.id
          AND r.replay_mode IS NULL)::int AS run_count,
       COALESCE(last_run.status, '') AS last_run_status,
       COALESCE(m.tags, '[]'::jsonb) AS tags,
       m.folder,
       (SELECT count(*) FROM trigger_events te
        WHERE te.org_id = w.org_id AND te.workflow_id = w.id
          AND (te.status = 'buffered'
               OR (te.status = 'backfilling'
                   AND te.backfill_claimed_at < now() - interval '5 minutes')))::int
         AS buffered_trigger_count
FROM workflows w
LEFT JOIN workflow_metadata m ON m.org_id = w.org_id AND m.workflow_id = w.id
LEFT JOIN LATERAL (
  SELECT r.status FROM runs r
  JOIN workflow_versions wv ON wv.id = r.workflow_version_id
  WHERE r.org_id = w.org_id AND wv.workflow_id = w.id
    AND r.replay_mode IS NULL
  ORDER BY r.created_at DESC, r.id DESC LIMIT 1
) last_run ON true
WHERE w.org_id = $1 AND w.deleted_at IS NOT NULL
  AND (w.deleted_at, w.id) < (sqlc.arg(before_deleted_at)::timestamptz, sqlc.arg(before_id)::text)
ORDER BY w.deleted_at DESC, w.id DESC
LIMIT sqlc.arg(page_limit);

-- name: InsertWorkflowVersion :exec
INSERT INTO workflow_versions (id, org_id, workflow_id, version, dag_json, created_by,
                               upstream_health_sources, slo_json)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8);

-- name: GetWorkflowVersionByID :one
SELECT id, org_id, workflow_id, version, dag_json, created_by, created_at
FROM workflow_versions
WHERE id = $1 AND org_id = $2 AND workflow_id = $3;

-- name: GetLatestWorkflowVersion :one
SELECT id, org_id, workflow_id, version, dag_json, created_by, created_at
FROM workflow_versions
WHERE workflow_id = $1 AND org_id = $2
ORDER BY version DESC
LIMIT 1;

-- name: CountWorkflowVersions :one
SELECT COALESCE(MAX(version), 0)::int FROM workflow_versions
WHERE workflow_id = $1 AND org_id = $2;

-- name: GetWorkflowIngestState :one
SELECT org_id, status, deleted_at FROM workflows WHERE id = $1;

-- Per-org retention: the sweep resolves each org's catalog window and
-- purges with an org-scoped cutoff.
-- name: ListOrgsWithSoftDeletedWorkflows :many
SELECT DISTINCT org_id FROM workflows WHERE deleted_at IS NOT NULL;

-- Workflow-scope operator guidance for AI prompt composition.
-- name: GetWorkflowAiGuidance :one
SELECT ai_guidance_markdown FROM workflow_metadata
WHERE org_id = $1 AND workflow_id = $2;

-- name: CountRecentWorkflowRunStatuses :many
SELECT r.status FROM runs r
LEFT JOIN workflow_versions v ON v.id = r.workflow_version_id AND v.org_id = r.org_id
WHERE r.org_id = $1
  AND COALESCE(v.workflow_id, r.workflow_version_id) = sqlc.arg(workflow_id)
  AND r.replay_mode IS NULL
  AND r.status IN ('succeeded', 'failed')
ORDER BY r.created_at DESC
LIMIT sqlc.arg(page_limit);

-- name: GetWorkflowBreakerStatus :one
SELECT status FROM workflows
WHERE org_id = $1 AND id = $2 AND deleted_at IS NULL;

-- name: GetWorkflowVersionAnyWorkflow :one
SELECT id, org_id, workflow_id, version, dag_json FROM workflow_versions
WHERE id = $1 AND org_id = $2;

-- name: LockWorkflowForRollout :one
SELECT id FROM workflows WHERE org_id = $1 AND id = $2 AND deleted_at IS NULL FOR UPDATE;

-- name: ListWorkflowVersionsForRollout :many
SELECT id, version, dag_json FROM workflow_versions
WHERE org_id = $1 AND workflow_id = $2 ORDER BY version DESC LIMIT 200;

-- name: FindActiveWorkflowRollout :one
SELECT id FROM workflow_rollouts WHERE org_id = $1 AND workflow_id = $2 AND status = 'active' LIMIT 1;

-- name: InsertWorkflowRollout :one
INSERT INTO workflow_rollouts (id, org_id, workflow_id, baseline_version_id, canary_version_id,
  traffic_percent, minimum_sample_size, minimum_success_rate_percent, created_by)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
RETURNING *;

-- name: GetLatestWorkflowRolloutRow :one
SELECT wr.* FROM workflow_rollouts wr
JOIN workflows w ON w.id = wr.workflow_id AND w.org_id = wr.org_id
WHERE wr.org_id = $1 AND wr.workflow_id = $2 AND w.deleted_at IS NULL
ORDER BY CASE WHEN wr.status = 'active' THEN 0 ELSE 1 END, wr.created_at DESC, wr.id DESC
LIMIT 1;

-- name: GetWorkflowRolloutRow :one
SELECT * FROM workflow_rollouts WHERE id = $1 AND org_id = $2 AND workflow_id = $3;

-- name: FinishWorkflowRolloutCAS :one
UPDATE workflow_rollouts
SET status = sqlc.arg(new_status),
    rolled_back_reason = CASE WHEN sqlc.arg(new_status) = 'rolled_back' THEN sqlc.narg(reason) ELSE NULL END,
    ended_at = now(), updated_at = now()
WHERE id = $1 AND org_id = $2 AND workflow_id = $3 AND status = 'active'
RETURNING *;

-- name: CancelActiveWorkflowRollout :execrows
UPDATE workflow_rollouts
SET status = 'cancelled', rolled_back_reason = sqlc.arg(reason),
    ended_at = now(), updated_at = now()
WHERE org_id = $1 AND workflow_id = $2 AND status = 'active';

-- name: FindWorkflowRecoveryQualification :one
SELECT * FROM workflow_recovery_qualifications
WHERE org_id = $1 AND workflow_id = $2 AND baseline_version_id = $3
  AND candidate_version_id = $4 AND dataset_version = $5
ORDER BY created_at DESC, id DESC LIMIT 1;

-- name: GetRunForRolloutOutcome :one
SELECT org_id, status, replay_mode, workflow_rollout_id, workflow_rollout_variant, workflow_version_id
FROM runs WHERE id = $1;

-- name: GetActiveRolloutForOutcome :one
SELECT * FROM workflow_rollouts WHERE id = $1 AND org_id = $2 AND status = 'active';

-- name: InsertWorkflowRolloutOutcome :execrows
INSERT INTO workflow_rollout_outcomes (run_id, org_id, rollout_id, workflow_id, variant, status)
VALUES ($1, $2, $3, $4, $5, $6)
ON CONFLICT (run_id) DO NOTHING;

-- name: IncrementRolloutCounters :one
UPDATE workflow_rollouts SET
  baseline_succeeded = baseline_succeeded + sqlc.arg(baseline_succeeded_inc),
  baseline_failed = baseline_failed + sqlc.arg(baseline_failed_inc),
  canary_succeeded = canary_succeeded + sqlc.arg(canary_succeeded_inc),
  canary_failed = canary_failed + sqlc.arg(canary_failed_inc),
  last_outcome_at = now(), updated_at = now()
WHERE id = $1 AND status = 'active'
RETURNING *;

-- name: AutoRollbackRollout :one
UPDATE workflow_rollouts
SET status = 'rolled_back', rolled_back_reason = sqlc.arg(reason), ended_at = now(), updated_at = now()
WHERE id = $1 AND status = 'active'
RETURNING *;

-- name: ListUnrecordedRolloutOutcomes :many
SELECT r.id AS run_id, r.status FROM runs r
JOIN workflow_rollouts wr ON wr.id = r.workflow_rollout_id AND wr.org_id = r.org_id AND wr.status = 'active'
LEFT JOIN workflow_rollout_outcomes o ON o.run_id = r.id
WHERE r.workflow_rollout_id IS NOT NULL AND r.replay_mode IS NULL
  AND r.status IN ('succeeded','failed','cancelled') AND o.run_id IS NULL
ORDER BY r.created_at ASC, r.id ASC
LIMIT sqlc.arg(page_limit);

-- name: ListLatestWorkflowVersionDags :many
SELECT DISTINCT ON (wv.workflow_id) wv.workflow_id, wv.dag_json
FROM workflow_versions wv
JOIN workflows w ON w.id = wv.workflow_id AND w.org_id = wv.org_id
WHERE wv.org_id = $1 AND w.deleted_at IS NULL
ORDER BY wv.workflow_id, wv.version DESC
LIMIT 1000;

-- name: ListExternalWorkflows :many
SELECT * FROM external_workflows
WHERE org_id = $1
ORDER BY last_observed_at DESC NULLS LAST, external_workflow_id ASC
LIMIT 100;

-- name: ListLatestWorkflowVersionUpstreamTags :many
SELECT DISTINCT ON (wv.workflow_id) wv.workflow_id, wv.upstream_health_sources
FROM workflow_versions wv
JOIN workflows w ON w.id = wv.workflow_id AND w.org_id = wv.org_id
WHERE wv.org_id = $1 AND w.deleted_at IS NULL
ORDER BY wv.workflow_id, wv.version DESC
LIMIT 1000;

-- name: GetWorkflowVersionByNumber :one
SELECT wv.id, wv.dag_json, wv.version
FROM workflow_versions wv
JOIN workflows w ON w.id = wv.workflow_id AND w.org_id = wv.org_id
WHERE wv.workflow_id = $1 AND wv.org_id = $2 AND wv.version = $3
  AND w.deleted_at IS NULL;

-- name: ListScheduleEntriesForWorkflow :many
SELECT * FROM schedule_entries WHERE org_id = $1 AND workflow_id = $2 ORDER BY node_id;

-- name: GetLatestWorkflowSlo :one
SELECT slo_json FROM workflow_versions
WHERE org_id = $1 AND workflow_id = $2
ORDER BY version DESC
LIMIT 1;

-- name: QueryWorkflowHealthSignals :one
WITH candidate_runs AS (
  -- A saved workflow's plain runs carry workflow_version_id = the WORKFLOW
  -- id (the pilot's no-rollout convention); pinned/rollout runs carry a
  -- real version-row id. The effective version for un-pinned runs is the
  -- number of versions saved at run time.
  SELECT r.id, r.status, r.created_at,
         coalesce(
           (SELECT wv.version FROM workflow_versions wv
            WHERE wv.id = r.workflow_version_id AND wv.org_id = sqlc.arg(org_id)),
           (SELECT count(*) FROM workflow_versions v2
            WHERE v2.workflow_id = sqlc.arg(workflow_id) AND v2.org_id = sqlc.arg(org_id)
              AND v2.created_at <= r.created_at)
         )::int AS effective_version
  FROM runs r
  WHERE r.org_id = sqlc.arg(org_id)
    AND r.created_at >= sqlc.arg(since)
    AND r.replay_mode IS NULL
    AND (r.workflow_version_id = sqlc.arg(workflow_id)
         OR r.workflow_version_id IN (SELECT v3.id FROM workflow_versions v3
              WHERE v3.workflow_id = sqlc.arg(workflow_id) AND v3.org_id = sqlc.arg(org_id)))
), window_runs AS (
  SELECT id, status, created_at FROM candidate_runs
  WHERE (sqlc.narg(before_version)::int IS NULL OR effective_version < sqlc.narg(before_version)::int)
    AND (sqlc.narg(from_version)::int IS NULL OR effective_version >= sqlc.narg(from_version)::int)
), terminal AS (
  SELECT wr.id, wr.status, wr.created_at,
         (SELECT min(e.created_at) FROM run_events e
          WHERE e.run_id = wr.id AND e.type IN ('run.succeeded','run.failed','run.cancelled','run.timed_out')) AS terminal_at
  FROM window_runs wr
  WHERE wr.status IN ('succeeded','failed','cancelled','timed_out')
)
SELECT
  (SELECT count(*) FROM terminal)::int AS total_runs,
  (SELECT count(*) FROM terminal WHERE status = 'succeeded')::int AS success_count,
  (SELECT count(*) FROM terminal WHERE status = 'failed')::int AS failure_count,
  (SELECT count(*) FROM run_events e JOIN window_runs wr ON wr.id = e.run_id
   WHERE e.type = 'node.retry')::int AS retry_count,
  (SELECT count(*) FROM dead_letters d JOIN window_runs wr ON wr.id = d.run_id
   WHERE d.status = 'open')::int AS dlq_open_count,
  coalesce((SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM (t.terminal_at - t.created_at)) * 1000)
   FROM terminal t WHERE t.terminal_at IS NOT NULL), -1)::float8 AS p95_latency_ms,
  coalesce((SELECT sum((u.metadata ->> 'costUsd')::float8) FROM usage_events u
   JOIN window_runs wr ON wr.id = u.run_id
   WHERE u.metadata ? 'costUsd' AND u.metadata ->> 'costUsd' != '<nil>'), 0)::float8 AS total_cost_usd,
  coalesce((SELECT sum(u.quantity) FROM usage_events u
   JOIN window_runs wr ON wr.id = u.run_id), 0)::float8 AS total_tokens,
  (SELECT count(*) FROM workflow_versions v2
   WHERE v2.workflow_id = sqlc.arg(workflow_id) AND v2.org_id = sqlc.arg(org_id))::int AS version_count;

-- The post-Apply dialog needs every production status, not just terminal
-- health samples: an in-flight run is visible immediately while the score
-- remains below its sample floor. Keep the effective-version rules identical
-- to QueryWorkflowHealthSignals so plain pilot runs and pinned rollout runs
-- land on the same side of the cutoff.
-- name: QueryRecentRunsAgainstWorkflowVersion :one
WITH candidate_runs AS (
  SELECT r.status,
         coalesce(
           (SELECT wv.version FROM workflow_versions wv
            WHERE wv.id = r.workflow_version_id AND wv.org_id = sqlc.arg(org_id)),
           (SELECT count(*) FROM workflow_versions v2
            WHERE v2.workflow_id = sqlc.arg(workflow_id) AND v2.org_id = sqlc.arg(org_id)
              AND v2.created_at <= r.created_at)
         )::int AS effective_version
  FROM runs r
  WHERE r.org_id = sqlc.arg(org_id)
    AND r.created_at >= sqlc.arg(since)
    AND r.replay_mode IS NULL
    AND (r.workflow_version_id = sqlc.arg(workflow_id)
         OR r.workflow_version_id IN (SELECT v3.id FROM workflow_versions v3
              WHERE v3.workflow_id = sqlc.arg(workflow_id) AND v3.org_id = sqlc.arg(org_id)))
)
SELECT
  count(*)::int AS total_runs,
  count(*) FILTER (WHERE status = 'succeeded')::int AS succeeded,
  count(*) FILTER (WHERE status IN ('failed', 'cancelled', 'timed_out'))::int AS failed,
  count(*) FILTER (WHERE status IN ('created', 'running', 'waiting'))::int AS running
FROM candidate_runs
WHERE effective_version >= sqlc.arg(from_version)::int;

-- name: ListRecentDeadLettersForWorkflowDelta :many
SELECT d.id, d.error_json, d.node_id, d.node_json
FROM dead_letters d
JOIN runs r ON r.id = d.run_id
WHERE d.org_id = sqlc.arg(org_id)
  AND r.org_id = sqlc.arg(org_id)
  AND d.created_at >= sqlc.arg(created_at)
  AND (r.workflow_version_id = sqlc.arg(workflow_id)
       OR r.workflow_version_id IN (SELECT v3.id FROM workflow_versions v3
            WHERE v3.workflow_id = sqlc.arg(workflow_id) AND v3.org_id = sqlc.arg(org_id)))
  AND (sqlc.narg(from_version)::int IS NULL OR coalesce(
        (SELECT wv.version FROM workflow_versions wv
         WHERE wv.id = r.workflow_version_id AND wv.org_id = sqlc.arg(org_id)),
        (SELECT count(*) FROM workflow_versions v2
         WHERE v2.workflow_id = sqlc.arg(workflow_id) AND v2.org_id = sqlc.arg(org_id)
           AND v2.created_at <= r.created_at))::int >= sqlc.narg(from_version)::int)
ORDER BY d.created_at DESC
LIMIT 100;

-- name: GetWorkflowMetadata :one
SELECT * FROM workflow_metadata WHERE org_id = $1 AND workflow_id = $2;

-- name: UpsertWorkflowMetadata :one
INSERT INTO workflow_metadata (id, org_id, workflow_id, owners, tags, description,
                               slack_channel, linear_project, severity_default,
                               folder, runbook_markdown, ai_guidance_markdown, created_by)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
ON CONFLICT (org_id, workflow_id) DO UPDATE SET
  owners = excluded.owners, tags = excluded.tags, description = excluded.description,
  slack_channel = excluded.slack_channel, linear_project = excluded.linear_project,
  severity_default = excluded.severity_default, folder = excluded.folder,
  runbook_markdown = excluded.runbook_markdown,
  ai_guidance_markdown = excluded.ai_guidance_markdown, updated_at = now()
RETURNING *;

-- name: SetWorkflowFolderOnly :one
INSERT INTO workflow_metadata (id, org_id, workflow_id, folder, created_by)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (org_id, workflow_id) DO UPDATE SET
  folder = excluded.folder, updated_at = now()
RETURNING *;

-- name: SetWorkflowTagsOnly :one
INSERT INTO workflow_metadata (id, org_id, workflow_id, tags, created_by)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (org_id, workflow_id) DO UPDATE SET
  tags = excluded.tags, updated_at = now()
RETURNING *;

-- name: ListDistinctWorkflowTags :many
SELECT DISTINCT jsonb_array_elements_text(m.tags)::text AS tag
FROM workflow_metadata m
JOIN workflows w ON w.id = m.workflow_id AND w.org_id = m.org_id
WHERE m.org_id = $1 AND w.deleted_at IS NULL
ORDER BY tag ASC
LIMIT 200;

-- name: ListDistinctWorkflowFolders :many
SELECT DISTINCT m.folder::text AS folder
FROM workflow_metadata m
JOIN workflows w ON w.id = m.workflow_id AND w.org_id = m.org_id
WHERE m.org_id = $1 AND m.folder IS NOT NULL AND w.deleted_at IS NULL
ORDER BY folder ASC
LIMIT 200;

-- name: RenameWorkflowFolderBulk :execrows
UPDATE workflow_metadata SET folder = sqlc.arg(to_folder), updated_at = now()
WHERE org_id = $1 AND folder = sqlc.arg(from_folder);

-- name: DeleteWorkflowFolderBulk :execrows
UPDATE workflow_metadata SET folder = NULL, updated_at = now()
WHERE org_id = $1 AND folder = sqlc.arg(folder);

-- name: RenameWorkflowTagBulk :execrows
UPDATE workflow_metadata
SET tags = (tags - sqlc.arg(from_tag)::text) || to_jsonb(sqlc.arg(to_tag)::text),
    updated_at = now()
WHERE org_id = $1 AND tags ? sqlc.arg(from_tag)::text;

-- name: DeleteWorkflowTagBulk :execrows
UPDATE workflow_metadata
SET tags = tags - sqlc.arg(tag)::text, updated_at = now()
WHERE org_id = $1 AND tags ? sqlc.arg(tag)::text;

-- name: ListOwnedActiveWorkflowIDs :many
SELECT id FROM workflows
WHERE org_id = $1 AND id = ANY(sqlc.arg(ids)::text[]) AND deleted_at IS NULL;

-- name: GetWorkflowSeverityDefault :one
SELECT severity_default FROM workflow_metadata WHERE org_id = $1 AND workflow_id = $2;

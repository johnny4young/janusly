-- Usage, prompts, memoria, evals, experiments, budget, routing.

-- name: DeleteExpiredUsageEventsBatch :execrows
DELETE FROM usage_events WHERE id IN (
  SELECT u.id FROM usage_events u
  WHERE u.org_id = sqlc.arg(target_org)::text
    AND u.created_at < sqlc.arg(cutoff)::timestamptz
    AND (u.hold_until IS NULL OR u.hold_until <= now())
  LIMIT sqlc.arg(batch_size));

-- One LLM usage row per attempt (the telemetry chokepoint's writer).
-- name: InsertUsageEvent :exec
INSERT INTO usage_events (id, org_id, user_id, run_id, metric, quantity, metadata)
VALUES ($1, $2, $3, $4, $5, $6, $7);

-- PromptOps registry: named prompts with immutable versions; the active
-- version is the pinned one or the latest published.
-- name: GetPromptByName :one
SELECT * FROM prompts WHERE org_id = $1 AND name = $2;

-- name: InsertPrompt :exec
INSERT INTO prompts (id, org_id, name, description, created_by)
VALUES ($1, $2, $3, $4, $5);

-- name: ListPrompts :many
SELECT * FROM prompts WHERE org_id = $1
ORDER BY created_at DESC, id DESC LIMIT $2;

-- name: NextPromptVersionNumber :one
SELECT COALESCE(max(version), 0) + 1 FROM prompt_versions
WHERE org_id = $1 AND prompt_id = $2;

-- name: InsertPromptVersion :exec
INSERT INTO prompt_versions (id, org_id, prompt_id, version, template_text, variables, created_by)
VALUES ($1, $2, $3, $4, $5, $6, $7);

-- name: GetLatestPublishedPromptVersion :one
SELECT * FROM prompt_versions
WHERE org_id = $1 AND prompt_id = $2 AND status = 'published'
ORDER BY version DESC LIMIT 1;

-- name: GetPromptVersionByID :one
SELECT * FROM prompt_versions WHERE org_id = $1 AND id = $2;

-- name: GetPromptVersionByNumber :one
SELECT * FROM prompt_versions
WHERE org_id = $1 AND prompt_id = $2 AND version = $3;

-- name: PinPromptVersion :execrows
UPDATE prompts SET pinned_version_id = $3, updated_at = now()
WHERE org_id = $1 AND id = $2;

-- name: GetPromptRowByID :one
SELECT * FROM prompts WHERE org_id = $1 AND id = $2;

-- name: ListMemoryConsentRevokedOrgs :many
SELECT org_id, updated_at FROM org_configs
WHERE key = 'memory.enabled' AND value_json = 'false'::jsonb AND updated_at <= $1;

-- name: PurgeMemoryEntriesForOrg :execrows
DELETE FROM memory_entries WHERE org_id = $1;

-- name: ListEvalDatasets :many
SELECT * FROM eval_datasets WHERE org_id = $1 ORDER BY created_at DESC LIMIT 100;

-- name: GetEvalDataset :one
SELECT * FROM eval_datasets WHERE org_id = $1 AND id = $2;

-- name: FindEvalDatasetByName :one
SELECT * FROM eval_datasets WHERE org_id = $1 AND name = $2;

-- name: InsertEvalDataset :exec
INSERT INTO eval_datasets (id, org_id, name, description, workflow_id,
                           example_count, retention_days, created_by)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8);

-- name: DeleteEvalDataset :execrows
DELETE FROM eval_datasets WHERE org_id = $1 AND id = $2;

-- name: DeleteEvalExamplesForDataset :exec
DELETE FROM eval_examples WHERE org_id = $1 AND dataset_id = $2;

-- Dataset retention is dataset-owned rather than a tenant-wide window. One
-- statement claims a bounded group of expired parents and removes their
-- consented examples atomically. Experiment summaries intentionally survive:
-- they are immutable comparison evidence and do not contain the dataset rows.
-- SKIP LOCKED lets HA maintenance replicas divide a backlog without waiting on
-- or double-counting the same datasets.
-- name: PurgeExpiredEvalDatasetsBatch :one
WITH expired AS (
  SELECT dataset.id, dataset.org_id
  FROM eval_datasets dataset
  WHERE dataset.retention_days IS NOT NULL
    AND dataset.retention_days BETWEEN 1 AND 3650
    AND dataset.created_at + dataset.retention_days * interval '1 day'
        <= sqlc.arg(now_at)::timestamptz
  ORDER BY dataset.created_at ASC, dataset.id ASC
  FOR UPDATE OF dataset SKIP LOCKED
  LIMIT sqlc.arg(batch_size)
), deleted_examples AS (
  DELETE FROM eval_examples example
  USING expired
  WHERE example.org_id = expired.org_id
    AND example.dataset_id = expired.id
  RETURNING example.id
), deleted_datasets AS (
  DELETE FROM eval_datasets dataset
  USING expired
  WHERE dataset.org_id = expired.org_id
    AND dataset.id = expired.id
  RETURNING dataset.id
)
SELECT count(*)::bigint FROM deleted_datasets;

-- name: InsertEvalExample :exec
INSERT INTO eval_examples (id, org_id, dataset_id, source_feedback_id, workflow_id,
                           dead_letter_id, failure_signature, input_context,
                           expected_approach_label, accepted, suggestion_mode)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11);

-- name: ListEvalExamples :many
SELECT * FROM eval_examples WHERE org_id = $1 AND dataset_id = $2
ORDER BY created_at ASC LIMIT 500;

-- name: InsertExperiment :exec
INSERT INTO experiments (id, org_id, name, kind, control_ref, candidate_ref,
                         eval_dataset_id, scorer_kind, status, created_by)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'running', $9);

-- name: CompleteExperiment :execrows
UPDATE experiments
SET status = $3, summary_json = $4, completed_at = now()
WHERE org_id = $1 AND id = $2 AND status = 'running';

-- name: GetExperiment :one
SELECT * FROM experiments WHERE org_id = $1 AND id = $2;

-- name: ListExperiments :many
SELECT * FROM experiments WHERE org_id = $1 ORDER BY created_at DESC LIMIT 100;

-- name: CountMemoryEntriesForOrg :one
SELECT count(*)::int8 FROM memory_entries WHERE org_id = $1;

-- Billing reads/writes: bounded usage slices, the per-workflow
-- budget override, and the workflow-scope month spend for the composite
-- budget gate (workflow override -> org default -> none).

-- name: ListUsageEventsForBilling :many
SELECT metric, quantity, metadata, created_at
FROM usage_events
WHERE org_id = $1 AND created_at >= sqlc.arg(since)::timestamptz
LIMIT 10000;

-- name: GetWorkflowBudget :one
SELECT id, org_id, workflow_id, monthly_usd, warn_percent, policy,
       updated_by, created_at, updated_at
FROM workflow_budgets
WHERE org_id = $1 AND workflow_id = $2;

-- name: UpsertWorkflowBudget :one
INSERT INTO workflow_budgets (id, org_id, workflow_id, monthly_usd, warn_percent, policy, updated_by)
VALUES ($1, $2, $3, $4, $5, $6, $7)
ON CONFLICT (org_id, workflow_id) DO UPDATE
SET monthly_usd = EXCLUDED.monthly_usd,
    warn_percent = EXCLUDED.warn_percent,
    policy = EXCLUDED.policy,
    updated_by = EXCLUDED.updated_by,
    updated_at = now()
RETURNING id, org_id, workflow_id, monthly_usd, warn_percent, policy,
          updated_by, created_at, updated_at;

-- name: SumWorkflowSpendThisMonth :one
SELECT sum((metadata->>'costUsd')::double precision)::double precision
FROM usage_events
WHERE org_id = $1 AND metric = 'llm.completion'
  AND metadata->>'workflowId' = sqlc.arg(workflow_id)::text
  AND created_at >= date_trunc('month', now())
  AND jsonb_typeof(metadata->'costUsd') = 'number';

-- The dispatcher resolves the run's saved-workflow id for the composite
-- budget gate; ad-hoc runs fall back to their run-scoped identity.
-- name: GetRunWorkflowID :one
SELECT coalesce(wv.workflow_id, r.workflow_version_id)
FROM runs r
LEFT JOIN workflow_versions wv ON wv.id = r.workflow_version_id
WHERE r.id = $1;

-- Billing reads/writes: bounded usage slices, the per-workflow
-- budget override, and the workflow-scope month spend for the composite
-- budget gate (workflow override -> org default -> none).

-- name: ListUsageEventsForBilling :many
SELECT metric, quantity, metadata, created_at
FROM usage_events
WHERE org_id = $1 AND created_at >= sqlc.arg(since)::timestamptz
LIMIT 10000;

-- Exact totals of a window per model, split by whether the call ran inside a run.
-- Simulated calls count as calls but add no cost and no tokens.
-- name: ListUsageCostModels :many
SELECT
  (CASE WHEN jsonb_typeof(metadata->'provider') = 'string' THEN metadata->>'provider' ELSE 'unknown' END)::text AS provider,
  (CASE WHEN jsonb_typeof(metadata->'model') = 'string' THEN metadata->>'model' ELSE 'unknown' END)::text AS model,
  (run_id IS NULL OR run_id = '')::boolean AS without_run,
  count(*)::bigint AS calls,
  count(*) FILTER (WHERE metadata->'providerSimulated' = 'true'::jsonb)::bigint AS simulated_calls,
  count(*) FILTER (WHERE jsonb_typeof(metadata->'costUsd') = 'number'
    AND metadata->'providerSimulated' IS DISTINCT FROM 'true'::jsonb)::bigint AS priced_calls,
  coalesce(sum(greatest((metadata->>'costUsd')::double precision, 0))
    FILTER (WHERE jsonb_typeof(metadata->'costUsd') = 'number'
      AND metadata->'providerSimulated' IS DISTINCT FROM 'true'::jsonb), 0)::double precision AS cost_usd,
  sum(CASE WHEN jsonb_typeof(metadata->'inputTokens') = 'number' AND metadata->'providerSimulated' IS DISTINCT FROM 'true'::jsonb
    THEN greatest((metadata->>'inputTokens')::double precision, 0) ELSE 0 END)::double precision AS input_tokens,
  sum(CASE WHEN jsonb_typeof(metadata->'cachedInputTokens') = 'number' AND metadata->'providerSimulated' IS DISTINCT FROM 'true'::jsonb
    THEN greatest((metadata->>'cachedInputTokens')::double precision, 0) ELSE 0 END)::double precision AS cached_input_tokens,
  sum(CASE WHEN jsonb_typeof(metadata->'cacheCreationInputTokens') = 'number' AND metadata->'providerSimulated' IS DISTINCT FROM 'true'::jsonb
    THEN greatest((metadata->>'cacheCreationInputTokens')::double precision, 0) ELSE 0 END)::double precision AS cache_creation_input_tokens,
  sum(CASE WHEN jsonb_typeof(metadata->'outputTokens') = 'number' AND metadata->'providerSimulated' IS DISTINCT FROM 'true'::jsonb
    THEN greatest((metadata->>'outputTokens')::double precision, 0) ELSE 0 END)::double precision AS output_tokens
FROM usage_events
WHERE org_id = $1 AND metric = 'llm.completion'
  AND created_at >= sqlc.arg(since)::timestamptz
GROUP BY 1, 2, 3
ORDER BY 1, 2, 3;

-- The newest bounded slice of in-run calls, grouped per run, node and model.
-- Only counters and identifiers leave the slice: never prompts or aiError.
-- name: ListUsageCostSteps :many
WITH slice AS (
  SELECT run_id, metadata, created_at FROM usage_events
  WHERE org_id = $1 AND metric = 'llm.completion'
    AND created_at >= sqlc.arg(since)::timestamptz
    AND run_id <> ''
    AND (sqlc.narg(model)::text IS NULL OR (CASE WHEN jsonb_typeof(metadata->'model') = 'string' THEN metadata->>'model' ELSE 'unknown' END)::text = sqlc.narg(model)::text)
  ORDER BY created_at DESC NULLS LAST
  LIMIT sqlc.arg(row_cap)
)
SELECT
  run_id::text AS run_id,
  (CASE WHEN jsonb_typeof(metadata->'nodeId') = 'string' THEN metadata->>'nodeId' ELSE '' END)::text AS node_id,
  (CASE WHEN jsonb_typeof(metadata->'provider') = 'string' THEN metadata->>'provider' ELSE 'unknown' END)::text AS provider,
  (CASE WHEN jsonb_typeof(metadata->'model') = 'string' THEN metadata->>'model' ELSE 'unknown' END)::text AS model,
  min(created_at)::timestamptz AS oldest_at,
  count(*)::bigint AS calls,
  count(*) FILTER (WHERE metadata->'providerSimulated' = 'true'::jsonb)::bigint AS simulated_calls,
  count(*) FILTER (WHERE jsonb_typeof(metadata->'costUsd') = 'number'
    AND metadata->'providerSimulated' IS DISTINCT FROM 'true'::jsonb)::bigint AS priced_calls,
  coalesce(sum(greatest((metadata->>'costUsd')::double precision, 0))
    FILTER (WHERE jsonb_typeof(metadata->'costUsd') = 'number'
      AND metadata->'providerSimulated' IS DISTINCT FROM 'true'::jsonb), 0)::double precision AS cost_usd,
  sum(CASE WHEN jsonb_typeof(metadata->'inputTokens') = 'number' AND metadata->'providerSimulated' IS DISTINCT FROM 'true'::jsonb
    THEN greatest((metadata->>'inputTokens')::double precision, 0) ELSE 0 END)::double precision AS input_tokens,
  sum(CASE WHEN jsonb_typeof(metadata->'cachedInputTokens') = 'number' AND metadata->'providerSimulated' IS DISTINCT FROM 'true'::jsonb
    THEN greatest((metadata->>'cachedInputTokens')::double precision, 0) ELSE 0 END)::double precision AS cached_input_tokens,
  sum(CASE WHEN jsonb_typeof(metadata->'cacheCreationInputTokens') = 'number' AND metadata->'providerSimulated' IS DISTINCT FROM 'true'::jsonb
    THEN greatest((metadata->>'cacheCreationInputTokens')::double precision, 0) ELSE 0 END)::double precision AS cache_creation_input_tokens,
  sum(CASE WHEN jsonb_typeof(metadata->'outputTokens') = 'number' AND metadata->'providerSimulated' IS DISTINCT FROM 'true'::jsonb
    THEN greatest((metadata->>'outputTokens')::double precision, 0) ELSE 0 END)::double precision AS output_tokens
FROM slice
GROUP BY 1, 2, 3, 4
ORDER BY 1, 2, 3, 4;

-- name: ListUsageCostRuns :many
SELECT r.id, coalesce(w.name, r.input_json->'workflow'->>'name', '')::text AS workflow_name
FROM runs r
LEFT JOIN workflows w ON w.id = r.workflow_id AND w.org_id = r.org_id
WHERE r.org_id = $1 AND r.id = ANY(sqlc.arg(run_ids)::text[]);

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

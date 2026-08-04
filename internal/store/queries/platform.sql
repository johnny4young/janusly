-- Org config, audit, snippets, onboarding, alerts, reports, misc.

-- name: NotifyWake :exec
SELECT pg_notify('janusly_wake', sqlc.arg(run_id)::text);

-- name: ListOrgHTTPConfig :many
SELECT key, value_json FROM org_configs
WHERE org_id = $1 AND category = 'http';

-- Deferred hard cascade for tombstoned workflows: one data-modifying CTE
-- purges the expired workflows plus their versions and metadata atomically
-- — either the whole family goes or none of it does.
-- name: PurgeExpiredSoftDeletedWorkflows :one
WITH expired_workflows AS (
  SELECT id, org_id FROM workflows
  WHERE deleted_at IS NOT NULL AND deleted_at <= sqlc.arg(cutoff)::timestamptz
),
deleted_versions AS (
  DELETE FROM workflow_versions
  WHERE (org_id, workflow_id) IN (SELECT org_id, id FROM expired_workflows)
  RETURNING 1
),
deleted_metadata AS (
  DELETE FROM workflow_metadata
  WHERE (org_id, workflow_id) IN (SELECT org_id, id FROM expired_workflows)
  RETURNING 1
),
deleted_workflows AS (
  DELETE FROM workflows
  WHERE id IN (SELECT id FROM expired_workflows)
  RETURNING id
)
SELECT count(*)::int AS rows_deleted FROM deleted_workflows;

-- name: GetOrgConfigValue :one
SELECT value_json FROM org_configs WHERE org_id = $1 AND key = $2;

-- Operator-facing audit-trail reader: org-scoped, optional action PREFIX
-- filter, `(created_at, id)` DESC keyset so history pages backward without
-- repeats or skips on shared timestamps. The caller over-fetches limit+1
-- to derive hasMore + the next cursor.
-- name: QueryAuditLogs :many
SELECT * FROM audit_logs
WHERE org_id = $1
  AND (sqlc.narg(action_prefix)::text IS NULL OR action LIKE sqlc.narg(action_prefix) || '%')
  AND (created_at < @before_created_at
       OR (created_at = @before_created_at AND id < @before_id))
ORDER BY created_at DESC, id DESC
LIMIT @page_limit;

-- Rate limiter: one O(1) UPSERT per request — the fixed window lives in
-- the PK, so a fresh window is an insert and a repeat hit an increment.
-- name: BumpRateWindow :one
INSERT INTO rate_limit_windows (name, key, window_start, count, expires_at)
VALUES ($1, $2, $3, 1, $4)
ON CONFLICT (name, key, window_start)
DO UPDATE SET count = rate_limit_windows.count + 1
RETURNING count;

-- name: CleanupExpiredRateWindows :execrows
DELETE FROM rate_limit_windows WHERE expires_at < now();

-- Org-config rows for the layered catalog read. The closed catalog is
-- ~69 keys; the 200 cap guards a pathological row count, like the
-- contract's defensive limit.
-- name: ListOrgConfigRows :many
SELECT key, value_json, updated_at FROM org_configs WHERE org_id = $1 LIMIT 200;

-- name: UpsertOrgConfigValue :exec
INSERT INTO org_configs (id, org_id, key, value_json, category, description, value_type, updated_by, updated_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
ON CONFLICT (org_id, key)
DO UPDATE SET value_json = EXCLUDED.value_json, updated_by = EXCLUDED.updated_by, updated_at = now();

-- name: PurgeExpiredSoftDeletedWorkflowsForOrg :one
WITH expired_workflows AS (
  SELECT w.id, w.org_id FROM workflows w
  WHERE w.org_id = sqlc.arg(target_org)::text AND w.deleted_at IS NOT NULL
    AND w.deleted_at <= sqlc.arg(cutoff)::timestamptz
),
deleted_versions AS (
  DELETE FROM workflow_versions
  WHERE (org_id, workflow_id) IN (SELECT org_id, id FROM expired_workflows)
  RETURNING 1
),
deleted_metadata AS (
  DELETE FROM workflow_metadata
  WHERE (org_id, workflow_id) IN (SELECT org_id, id FROM expired_workflows)
  RETURNING 1
),
deleted_workflows AS (
  DELETE FROM workflows WHERE id IN (SELECT id FROM expired_workflows)
  RETURNING 1
)
SELECT count(*) FROM deleted_workflows;

-- name: DeleteExpiredAuditLogsBatch :execrows
DELETE FROM audit_logs WHERE id IN (
  SELECT a.id FROM audit_logs a
  WHERE a.org_id = sqlc.arg(target_org)::text
    AND a.created_at < sqlc.arg(cutoff)::timestamptz
    AND (a.hold_until IS NULL OR a.hold_until <= now())
  LIMIT sqlc.arg(batch_size));

-- Orgs holding data old enough to POSSIBLY be expired — bounded by each
-- table's catalog FLOOR (run_events >= 7 days, audit/usage >= 30), so an
-- org with only fresh data never enters the sweep loop at all.
-- name: ListOrgsWithRetainableData :many
SELECT DISTINCT org_id FROM (
  SELECT r.org_id FROM runs r
  JOIN run_events re ON re.run_id = r.id
  WHERE re.created_at < now() - interval '7 days'
  UNION SELECT org_id FROM audit_logs WHERE created_at < now() - interval '30 days'
  UNION SELECT org_id FROM usage_events WHERE created_at < now() - interval '30 days'
) all_orgs;

-- One read for every org's retention windows — the sweep resolves the
-- layer chain in memory instead of one config query per org/table.
-- name: ListRetentionConfigRows :many
SELECT org_id, key, value_json FROM org_configs WHERE key LIKE 'retention.%';

-- Operations LLM cost rollup: aggregate the COMPLETE rolling window in
-- Postgres, rank provider/model groups by operator value, and fold every
-- group past the first 100 into one explicit aggregated remainder — the
-- totals stay exact while the response cardinality stays bounded.
-- name: QueryCostByProvider :many
WITH grouped AS (
  SELECT
    CASE WHEN jsonb_typeof(metadata->'provider') = 'string'
      THEN metadata->>'provider' ELSE 'unknown' END AS provider,
    CASE WHEN jsonb_typeof(metadata->'model') = 'string'
      THEN metadata->>'model' ELSE 'unknown' END AS model,
    sum(CASE WHEN jsonb_typeof(metadata->'costUsd') = 'number'
      THEN greatest((metadata->>'costUsd')::double precision, 0) ELSE 0 END)::double precision AS usd,
    sum(greatest(quantity, 0))::double precision AS tokens,
    sum(CASE WHEN jsonb_typeof(metadata->'inputTokens') = 'number'
      THEN greatest((metadata->>'inputTokens')::double precision, 0) ELSE 0 END)::double precision AS input_tokens,
    sum(CASE WHEN jsonb_typeof(metadata->'cachedInputTokens') = 'number'
      THEN greatest((metadata->>'cachedInputTokens')::double precision, 0) ELSE 0 END)::double precision AS cached_input_tokens,
    sum(CASE WHEN jsonb_typeof(metadata->'cacheCreationInputTokens') = 'number'
      THEN greatest((metadata->>'cacheCreationInputTokens')::double precision, 0) ELSE 0 END)::double precision AS cache_creation_input_tokens,
    count(*)::double precision AS calls
  FROM usage_events
  WHERE org_id = sqlc.arg(target_org)::text
    AND metric = 'llm.completion'
    AND created_at >= sqlc.arg(since)::timestamptz
  GROUP BY 1, 2
), ranked AS (
  SELECT grouped.*, row_number() OVER (
    ORDER BY usd DESC, tokens DESC, provider, model) AS group_rank
  FROM grouped
), bucketed AS (
  SELECT
    CASE WHEN group_rank <= 100 THEN provider ELSE '__other__' END AS provider,
    CASE WHEN group_rank <= 100 THEN model ELSE '__other__' END AS model,
    group_rank > 100 AS aggregated,
    usd, tokens, input_tokens, cached_input_tokens, cache_creation_input_tokens, calls
  FROM ranked
)
SELECT
  provider, model,
  sum(usd)::double precision AS usd,
  sum(tokens)::double precision AS tokens,
  sum(input_tokens)::double precision AS input_tokens,
  sum(cached_input_tokens)::double precision AS cached_input_tokens,
  sum(cache_creation_input_tokens)::double precision AS cache_creation_input_tokens,
  sum(calls)::double precision AS calls,
  aggregated
FROM bucketed
GROUP BY aggregated, provider, model
ORDER BY aggregated, usd DESC, tokens DESC, provider, model;

-- name: InsertAuditLogRow :exec
INSERT INTO audit_logs (id, org_id, user_id, action, target_type, target_id, metadata)
VALUES ($1, $2, $3, $4, $5, $6, $7);

-- name: TripWorkflowCircuitBreaker :execrows
UPDATE workflows SET status = 'paused_circuit_breaker', paused_reason = sqlc.arg(reason)
WHERE org_id = $1 AND id = $2 AND status = 'active' AND deleted_at IS NULL;

-- name: ResumeWorkflowCircuitBreaker :execrows
UPDATE workflows SET status = 'active', paused_reason = NULL
WHERE org_id = $1 AND id = $2 AND status = 'paused_circuit_breaker' AND deleted_at IS NULL;

-- name: ListCalibratableApproaches :many
SELECT DISTINCT approach_label FROM recovery_feedback
WHERE org_id = $1 AND raw_confidence IS NOT NULL
  AND created_at >= now() - make_interval(days => sqlc.arg(window_days)::int);

-- name: ListAlertPolicies :many
SELECT * FROM alert_policies WHERE org_id = $1 ORDER BY created_at DESC, id DESC LIMIT 200;

-- name: ListEnabledAlertPolicies :many
SELECT * FROM alert_policies WHERE org_id = $1 AND trigger = $2 AND enabled ORDER BY created_at ASC LIMIT 100;

-- name: GetAlertPolicy :one
SELECT * FROM alert_policies WHERE org_id = $1 AND id = $2;

-- name: InsertAlertPolicy :exec
INSERT INTO alert_policies (id, org_id, name, trigger, parameters, channels, cooldown_seconds, enabled, created_by)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9);

-- name: UpdateAlertPolicy :execrows
UPDATE alert_policies
SET name = COALESCE(sqlc.narg(new_name), name),
    parameters = COALESCE(sqlc.narg(new_parameters), parameters),
    channels = COALESCE(sqlc.narg(new_channels), channels),
    cooldown_seconds = COALESCE(sqlc.narg(new_cooldown_seconds), cooldown_seconds),
    enabled = COALESCE(sqlc.narg(new_enabled), enabled),
    updated_at = now()
WHERE org_id = $1 AND id = $2;

-- name: DeleteAlertPolicy :execrows
DELETE FROM alert_policies WHERE org_id = $1 AND id = $2;

-- name: CountRecentAlertDispatches :one
SELECT count(*) FROM alert_dispatches
WHERE org_id = $1 AND policy_id = $2 AND dedupe_key = $3 AND dispatched_at >= $4;

-- name: InsertAlertDispatch :exec
INSERT INTO alert_dispatches (id, org_id, policy_id, dedupe_key, outcome, channel_results, trigger_payload)
VALUES ($1, $2, $3, $4, $5, $6, $7);

-- name: ListRecentAlertDispatches :many
SELECT * FROM alert_dispatches
WHERE org_id = $1 AND (sqlc.narg(cursor)::timestamptz IS NULL OR dispatched_at < sqlc.narg(cursor))
ORDER BY dispatched_at DESC, id DESC
LIMIT sqlc.arg(page_limit);

-- name: ListAuditRowsForTargets :many
SELECT id, action, target_type, target_id, user_id, created_at FROM audit_logs
WHERE org_id = $1 AND target_id = ANY(sqlc.arg(target_ids)::text[])
ORDER BY created_at DESC, id DESC LIMIT 50;

-- name: QueryTimeToFirstAction :one
WITH samples AS (
  SELECT extract(epoch FROM (item.first_action_at - item.created_at))::float8 AS seconds
  FROM recovery_items item
  JOIN dead_letters item_dlq ON item_dlq.org_id = item.org_id AND item_dlq.id = item.dead_letter_id
  JOIN runs item_run ON item_run.org_id = item.org_id AND item_run.id = item_dlq.run_id
  WHERE item.org_id = $1 AND item.created_at >= $2
    AND item.first_action_at IS NOT NULL AND item_run.replay_mode IS NULL
  UNION ALL
  SELECT extract(epoch FROM (coalesce(dlq.replay_claimed_at, dlq.replayed_at) - dlq.created_at))::float8 AS seconds
  FROM dead_letters dlq
  JOIN runs fallback_run ON fallback_run.org_id = dlq.org_id AND fallback_run.id = dlq.run_id
  WHERE dlq.org_id = $1 AND dlq.created_at >= $2
    AND coalesce(dlq.replay_claimed_at, dlq.replayed_at) IS NOT NULL
    AND fallback_run.replay_mode IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM recovery_items item WHERE item.org_id = $1 AND item.dead_letter_id = dlq.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM recovery_item_children child WHERE child.org_id = $1 AND child.dead_letter_id = dlq.id
    )
)
SELECT count(*) FILTER (WHERE seconds >= 0)::int AS sample_size,
       coalesce(avg(seconds) FILTER (WHERE seconds >= 0), -1)::float8 AS avg_seconds,
       coalesce(percentile_disc(0.95) WITHIN GROUP (ORDER BY seconds)
         FILTER (WHERE seconds >= 0), -1)::float8 AS p95_seconds
FROM samples;

-- name: UpsertExternalWorkflowPlaceholder :exec
INSERT INTO external_workflows (id, org_id, connection_id, external_workflow_id,
                                name, evidence_json, last_sequence)
VALUES ($1, $2, $3, $4, $4, '[]'::jsonb, -1)
ON CONFLICT (connection_id, external_workflow_id) DO NOTHING;

-- name: UpsertExternalWorkflowObservation :execrows
INSERT INTO external_workflows (id, org_id, connection_id, external_workflow_id,
                                name, version, snapshot_json, evidence_json,
                                last_sequence, last_event_id, last_observed_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
ON CONFLICT (connection_id, external_workflow_id) DO UPDATE SET
  name = excluded.name, version = excluded.version,
  snapshot_json = excluded.snapshot_json, evidence_json = excluded.evidence_json,
  last_sequence = excluded.last_sequence, last_event_id = excluded.last_event_id,
  last_observed_at = excluded.last_observed_at, updated_at = now()
WHERE external_workflows.last_sequence < excluded.last_sequence;

-- name: UpsertExternalStepObservation :execrows
INSERT INTO external_run_steps (id, org_id, connection_id, external_workflow_id,
                                external_run_id, external_step_id, name, status,
                                attempt, started_at, completed_at, snapshot_json,
                                evidence_json, last_sequence, last_event_id,
                                last_observed_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
ON CONFLICT (connection_id, external_run_id, external_step_id) DO UPDATE SET
  external_workflow_id = excluded.external_workflow_id, name = excluded.name,
  status = excluded.status, attempt = excluded.attempt,
  started_at = excluded.started_at, completed_at = excluded.completed_at,
  snapshot_json = excluded.snapshot_json, evidence_json = excluded.evidence_json,
  last_sequence = excluded.last_sequence, last_event_id = excluded.last_event_id,
  last_observed_at = excluded.last_observed_at, updated_at = now()
WHERE external_run_steps.last_sequence < excluded.last_sequence;

-- name: ClearParentNotification :exec
UPDATE runs SET parent_notification_after = NULL
WHERE id = $1 AND status = $2;

-- name: ListSnippets :many
SELECT * FROM snippets WHERE org_id = $1 ORDER BY lower(name) LIMIT 200;

-- name: GetSnippet :one
SELECT * FROM snippets WHERE org_id = $1 AND id = $2;

-- name: FindSnippetByName :one
SELECT * FROM snippets WHERE org_id = $1 AND lower(name) = lower($2);

-- name: InsertSnippet :one
INSERT INTO snippets (id, org_id, name, description, category, tags, builtin,
                      nodes_json, edges_json, entry_node_id, created_by)
VALUES ($1, $2, $3, $4, $5, $6, false, $7, $8, $9, $10)
RETURNING *;

-- name: UpdateSnippet :one
UPDATE snippets
SET name = $3, description = $4, category = $5, tags = $6,
    nodes_json = $7, edges_json = $8, entry_node_id = $9, updated_at = now()
WHERE org_id = $1 AND id = $2 AND builtin = false
RETURNING *;

-- name: DeleteSnippet :one
DELETE FROM snippets WHERE org_id = $1 AND id = $2 AND builtin = false
RETURNING *;

-- name: GetOnboardingProgress :one
SELECT * FROM onboarding_progress WHERE org_id = $1 AND user_id = $2;

-- name: EnsureOnboardingRow :exec
INSERT INTO onboarding_progress (id, org_id, user_id, step, status)
VALUES ($1, $2, $3, 'org_created', 'active')
ON CONFLICT (org_id, user_id) DO NOTHING;

-- name: SetOnboardingStep :exec
UPDATE onboarding_progress SET step = $3, updated_at = now()
WHERE org_id = $1 AND user_id = $2;

-- name: SetOnboardingStatus :execrows
UPDATE onboarding_progress
SET status = sqlc.arg(status),
    skipped_at = CASE WHEN sqlc.arg(status)::text = 'skipped' THEN now() ELSE NULL END,
    updated_at = now()
WHERE org_id = $1 AND user_id = $2 AND status != 'completed'
  AND status != sqlc.arg(status)::text;

-- name: CompleteOnboardingCas :execrows
UPDATE onboarding_progress
SET status = 'completed', step = 'completed', completed_at = now(), updated_at = now()
WHERE org_id = $1 AND user_id = $2 AND status != 'completed';

-- name: RestartOnboarding :execrows
UPDATE onboarding_progress
SET status = 'active', step = 'org_created', skipped_at = NULL,
    completed_at = NULL, restarted_at = now(), updated_at = now()
WHERE org_id = $1 AND user_id = $2;

-- name: ResolveOnboardingSignals :one
SELECT
  EXISTS(SELECT 1 FROM credentials c WHERE c.org_id = sqlc.arg(org_id)
         AND (sqlc.narg(since)::timestamptz IS NULL OR c.created_at >= sqlc.narg(since)::timestamptz)) AS credential_configured,
  EXISTS(SELECT 1 FROM audit_logs a WHERE a.org_id = sqlc.arg(org_id) AND a.action = 'workflow.pack_imported'
         AND (sqlc.narg(since)::timestamptz IS NULL OR a.created_at >= sqlc.narg(since)::timestamptz)) AS pack_installed,
  EXISTS(SELECT 1 FROM runs r WHERE r.org_id = sqlc.arg(org_id) AND r.status = 'succeeded'
         AND (sqlc.narg(since)::timestamptz IS NULL OR r.created_at >= sqlc.narg(since)::timestamptz)) AS first_run_succeeded,
  EXISTS(SELECT 1 FROM dead_letters d WHERE d.org_id = sqlc.arg(org_id)
         AND (sqlc.narg(since)::timestamptz IS NULL OR d.created_at >= sqlc.narg(since)::timestamptz)) AS failure_injected,
  (EXISTS(SELECT 1 FROM dead_letters d2 WHERE d2.org_id = sqlc.arg(org_id) AND d2.status IN ('replayed','resolved')
          AND (sqlc.narg(since)::timestamptz IS NULL OR d2.created_at >= sqlc.narg(since)::timestamptz))
   OR EXISTS(SELECT 1 FROM recovery_items ri WHERE ri.org_id = sqlc.arg(org_id) AND ri.status = 'resolved'
          AND (sqlc.narg(since)::timestamptz IS NULL OR ri.created_at >= sqlc.narg(since)::timestamptz))) AS recovery_applied;

-- The `memory.enabled=false` flip time backing the purge projection.
-- name: GetOrgConfigRevokedAt :one
SELECT updated_at FROM org_configs
WHERE org_id = $1 AND key = 'memory.enabled' AND value_json = 'false'::jsonb;

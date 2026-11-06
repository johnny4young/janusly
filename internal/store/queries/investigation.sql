-- name: GetRunInvestigationContext :one
SELECT r.input_json, r.created_at, coalesce(r.workflow_id, '')::text AS workflow_id, r.workflow_version_id,
       coalesce(wv.version, 0)::int AS version,
       coalesce(wv.upstream_health_sources, '[]'::jsonb)::jsonb AS upstream_tags
FROM runs r
LEFT JOIN workflow_versions wv ON wv.id = r.workflow_version_id AND wv.org_id = r.org_id
WHERE r.org_id = sqlc.arg(org_id) AND r.id = sqlc.arg(run_id);

-- Bounded: only the newest page of the workflow's runs before the failure is read.
-- name: ListRecentWorkflowSuccesses :many
SELECT recent.id, recent.workflow_version_id, coalesce(wv.version, 0)::int AS version
FROM (
  SELECT r.id, r.org_id, r.workflow_version_id, r.status, r.replay_mode, r.created_at
  FROM runs r
  WHERE r.org_id = sqlc.arg(org_id) AND r.workflow_id = sqlc.arg(workflow_id)
    AND r.created_at < sqlc.arg(before)
  ORDER BY r.created_at DESC, r.id DESC
  LIMIT sqlc.arg(run_limit)
) recent
LEFT JOIN workflow_versions wv ON wv.id = recent.workflow_version_id AND wv.org_id = recent.org_id
WHERE recent.status = 'succeeded' AND recent.replay_mode IS NULL
ORDER BY recent.created_at DESC, recent.id DESC;

-- Bounded: the same step across the newest runs of the workflow in the window.
-- name: ListRecentStepOutcomes :many
SELECT recent.id AS run_id, rn.status, rn.error_json
FROM (
  SELECT r.id, r.org_id, r.created_at
  FROM runs r
  WHERE r.org_id = sqlc.arg(org_id) AND r.workflow_id = sqlc.arg(workflow_id)
    AND r.created_at >= sqlc.arg(since) AND r.created_at <= sqlc.arg(until)
    AND r.replay_mode IS NULL
  ORDER BY r.created_at DESC, r.id DESC
  LIMIT sqlc.arg(run_limit)
) recent
JOIN run_nodes rn ON rn.run_id = recent.id AND rn.org_id = recent.org_id AND rn.node_id = sqlc.arg(node_id)
ORDER BY recent.created_at DESC, recent.id DESC;

-- name: ListWatchedUpstreamReadings :many
SELECT name, last_status, last_degraded, last_checked_at, last_error_reason, check_interval_seconds
FROM upstream_health_sources
WHERE org_id = sqlc.arg(org_id) AND enabled AND name = ANY(sqlc.arg(names)::text[])
ORDER BY lower(name);

-- name: ListCredentialExpiries :many
SELECT name, expires_at FROM credentials
WHERE org_id = sqlc.arg(org_id) AND name = ANY(sqlc.arg(names)::text[]);

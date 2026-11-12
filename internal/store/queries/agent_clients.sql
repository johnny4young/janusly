-- name: CreateAgentClient :one
INSERT INTO agent_clients (
  id, org_id, name, capabilities, scope_workflow_ids, scope_tags,
  token_digest, token_last4, rate_limit_per_minute, created_by, token_issued_at, expires_at,
  gate_tools, capture_content
) VALUES (
  sqlc.arg(id), sqlc.arg(org_id), sqlc.arg(name), sqlc.arg(capabilities)::text[],
  sqlc.arg(scope_workflow_ids)::text[], sqlc.arg(scope_tags)::text[],
  sqlc.arg(token_digest), sqlc.arg(token_last4), sqlc.arg(rate_limit_per_minute),
  sqlc.arg(created_by), sqlc.arg(token_issued_at), sqlc.arg(expires_at),
  sqlc.arg(gate_tools)::text[], sqlc.arg(capture_content)
)
RETURNING *;

-- name: GetAgentClientByTokenDigest :one
SELECT * FROM agent_clients WHERE token_digest = $1;

-- name: GetAgentClient :one
SELECT * FROM agent_clients WHERE org_id = $1 AND id = $2;

-- name: ListAgentClients :many
SELECT * FROM agent_clients
WHERE org_id = sqlc.arg(org_id)
  AND (created_at, id) < (sqlc.arg(before_created_at)::timestamptz, sqlc.arg(before_id)::text)
ORDER BY created_at DESC, id DESC
LIMIT sqlc.arg(page_limit);

-- name: ListAgentClientCreators :many
SELECT id, created_by FROM agent_clients
WHERE org_id = sqlc.arg(org_id) AND id = ANY(sqlc.arg(ids)::text[]);

-- name: RotateAgentClientToken :one
UPDATE agent_clients
SET token_digest = sqlc.arg(token_digest), token_last4 = sqlc.arg(token_last4),
    token_issued_at = sqlc.arg(token_issued_at), expires_at = sqlc.arg(expires_at)
WHERE org_id = sqlc.arg(org_id) AND id = sqlc.arg(id) AND revoked_at IS NULL
  AND expires_at > sqlc.arg(token_issued_at) AND oauth_client_id IS NULL
RETURNING *;

-- name: RevokeAgentClient :one
UPDATE agent_clients SET revoked_at = now(), revoked_by = sqlc.arg(revoked_by)::text
WHERE org_id = sqlc.arg(org_id) AND id = sqlc.arg(id) AND revoked_at IS NULL
RETURNING *;

-- Throttled so a busy agent does not write the row on every call.
-- name: TouchAgentClientLastUsed :exec
UPDATE agent_clients SET last_used_at = now()
WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute');

-- name: ResolveAgentScopeWorkflowIDs :many
SELECT w.id FROM workflows w
LEFT JOIN workflow_metadata m ON m.org_id = w.org_id AND m.workflow_id = w.id
WHERE w.org_id = sqlc.arg(org_id)
  AND (w.id = ANY(sqlc.arg(workflow_ids)::text[])
       OR COALESCE(m.tags, '[]'::jsonb) ?| sqlc.arg(tags)::text[])
ORDER BY w.id
LIMIT 1001;

-- name: ListAgentScopedWorkflows :many
SELECT w.id, w.name, w.created_at,
       (SELECT count(*) FROM runs r
        JOIN workflow_versions wv ON wv.id = r.workflow_version_id
        WHERE r.org_id = w.org_id AND wv.workflow_id = w.id
          AND r.replay_mode IS NULL)::int AS run_count,
       COALESCE((SELECT r.status FROM runs r
        JOIN workflow_versions wv ON wv.id = r.workflow_version_id
        WHERE r.org_id = w.org_id AND wv.workflow_id = w.id AND r.replay_mode IS NULL
        ORDER BY r.created_at DESC, r.id DESC LIMIT 1), '')::text AS last_run_status
FROM workflows w
WHERE w.org_id = sqlc.arg(org_id) AND w.deleted_at IS NULL
  AND w.id = ANY(sqlc.arg(workflow_ids)::text[])
  AND (w.created_at, w.id) < (sqlc.arg(before_created_at)::timestamptz, sqlc.arg(before_id)::text)
ORDER BY w.created_at DESC, w.id DESC
LIMIT sqlc.arg(page_limit);

-- name: ListAgentScopedRuns :many
SELECT r.id, r.status, r.workflow_id, coalesce(w.name, '')::text AS workflow_name, r.created_at
FROM runs r
LEFT JOIN workflows w ON w.id = r.workflow_id AND w.org_id = r.org_id
WHERE r.org_id = sqlc.arg(org_id)
  AND r.workflow_id = ANY(sqlc.arg(workflow_ids)::text[])
  AND (r.created_at, r.id) < (sqlc.arg(before_created_at)::timestamptz, sqlc.arg(before_id)::text)
  AND (sqlc.narg(filter_workflow_id)::text IS NULL OR r.workflow_id = sqlc.narg(filter_workflow_id))
  AND (sqlc.narg(filter_status)::text IS NULL OR r.status = sqlc.narg(filter_status))
ORDER BY r.created_at DESC, r.id DESC
LIMIT sqlc.arg(page_limit);

-- name: ListAgentScopedDeadLetters :many
SELECT dl.id, dl.run_id, dl.node_id, dl.attempt, dl.error_json, dl.status, dl.created_at
FROM dead_letters dl
JOIN runs r ON r.org_id = dl.org_id AND r.id = dl.run_id
WHERE dl.org_id = sqlc.arg(org_id)
  AND dl.replay_mode IS NULL
  AND r.workflow_id = ANY(sqlc.arg(workflow_ids)::text[])
  AND (dl.created_at, dl.id) < (sqlc.arg(before_created_at)::timestamptz, sqlc.arg(before_id)::text)
ORDER BY dl.created_at DESC, dl.id DESC
LIMIT sqlc.arg(page_limit);

-- name: GetRunWorkflowForOrg :one
SELECT coalesce(workflow_id, '')::text AS workflow_id, coalesce(created_by, '')::text AS created_by
FROM runs WHERE org_id = $1 AND id = $2;

-- name: GetDeadLetterWorkflowForOrg :one
SELECT coalesce(r.workflow_id, '')::text
FROM dead_letters dl
JOIN runs r ON r.org_id = dl.org_id AND r.id = dl.run_id
WHERE dl.org_id = $1 AND dl.id = $2;

-- name: GetRecoveryCaseWorkflowForOrg :one
SELECT coalesce(workflow_id, '')::text FROM recovery_cases WHERE org_id = $1 AND id = $2;

-- Served by the partial tool-call index on (org_id, user_id).
-- name: ListAgentClientToolCalls :many
SELECT target_id, metadata, created_at FROM audit_logs
WHERE org_id = sqlc.arg(org_id) AND user_id = sqlc.arg(actor)::text AND action = 'mcp.tool.invoked'
ORDER BY created_at DESC, id DESC
LIMIT 20;

-- name: ListMemberRoles :many
SELECT user_id, role FROM org_members
WHERE org_id = sqlc.arg(org_id) AND user_id = ANY(sqlc.arg(user_ids)::text[]);

-- name: ListAgentClientOpenRequests :many
SELECT id, workflow_id, reasons, created_at, expires_at FROM publish_requests
WHERE org_id = sqlc.arg(org_id) AND requested_by = sqlc.arg(actor)::text
  AND status = 'pending' AND expires_at > now()
ORDER BY created_at DESC, id DESC
LIMIT 20;

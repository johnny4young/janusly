-- name: CountPendingAgentGates :one
SELECT count(*)::int FROM agent_session_gates
WHERE agent_client_id = $1 AND status = 'pending';

-- name: InsertAgentGate :one
INSERT INTO agent_session_gates (id, org_id, agent_client_id, session_id, tool_use_id, tool, mcp_server, agent_id, content, expires_at)
VALUES (sqlc.arg(id), sqlc.arg(org_id), sqlc.arg(agent_client_id), sqlc.arg(session_id), sqlc.arg(tool_use_id),
        sqlc.arg(tool), sqlc.narg(mcp_server), sqlc.narg(agent_id), sqlc.narg(content), sqlc.arg(expires_at))
ON CONFLICT (session_id, tool_use_id) DO NOTHING
RETURNING *;

-- name: GetAgentGateByCall :one
SELECT * FROM agent_session_gates WHERE session_id = $1 AND tool_use_id = $2;

-- The agent's own read: only its client's gates.
-- name: GetAgentGateForClient :one
SELECT id, status, reason, expires_at FROM agent_session_gates
WHERE org_id = $1 AND agent_client_id = $2 AND id = $3;

-- name: GetAgentGate :one
SELECT g.*, c.created_by AS client_created_by, c.name AS agent_client_name
FROM agent_session_gates g
JOIN agent_clients c ON c.org_id = g.org_id AND c.id = g.agent_client_id
WHERE g.org_id = $1 AND g.id = $2;

-- name: DecideAgentGate :one
UPDATE agent_session_gates
SET status = sqlc.arg(status), decided_by = sqlc.arg(decided_by), decided_at = sqlc.arg(decided_at), reason = sqlc.narg(reason)
WHERE org_id = sqlc.arg(org_id) AND id = sqlc.arg(id) AND status = 'pending' AND expires_at > sqlc.arg(decided_at)
RETURNING *;

-- name: ExpireAgentGates :execrows
UPDATE agent_session_gates SET status = 'expired'
WHERE status = 'pending' AND expires_at <= sqlc.arg(now)::timestamptz;

-- name: ListPendingAgentGatesForSession :many
SELECT id, tool_use_id, tool, mcp_server, agent_id, content, expires_at, created_at
FROM agent_session_gates
WHERE org_id = sqlc.arg(org_id) AND session_id = sqlc.arg(session_id) AND status = 'pending'
  AND expires_at > sqlc.arg(now)::timestamptz
ORDER BY created_at
LIMIT 50;

-- name: ListPendingAgentGatesForOrg :many
SELECT g.id, g.session_id, g.tool, g.expires_at, c.created_by AS client_created_by, c.name AS agent_client_name
FROM agent_session_gates g
JOIN agent_clients c ON c.org_id = g.org_id AND c.id = g.agent_client_id
WHERE g.org_id = sqlc.arg(org_id) AND g.status = 'pending' AND g.expires_at > sqlc.arg(now)::timestamptz
ORDER BY g.created_at
LIMIT 50;

-- Captured content is kept for a shorter window than the gate itself.
-- name: ClearExpiredAgentGateContent :execrows
UPDATE agent_session_gates SET content = NULL
WHERE content IS NOT NULL AND created_at < sqlc.arg(cutoff)::timestamptz;

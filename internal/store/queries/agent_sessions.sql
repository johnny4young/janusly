-- Locks the session row so seq stays dense under concurrent hooks.
-- name: LockAgentSessionByExternal :one
SELECT * FROM agent_sessions
WHERE org_id = $1 AND agent_client_id = $2 AND external_session_id = $3
FOR UPDATE;

-- name: CountLiveAgentSessions :one
SELECT count(*)::int FROM agent_sessions
WHERE agent_client_id = sqlc.arg(agent_client_id) AND status = 'running'
  AND last_event_at > sqlc.arg(idle_before)::timestamptz;

-- name: InsertAgentSession :one
INSERT INTO agent_sessions (id, org_id, agent_client_id, external_session_id, runtime, started_at, last_event_at)
VALUES (sqlc.arg(id), sqlc.arg(org_id), sqlc.arg(agent_client_id), sqlc.arg(external_session_id),
        sqlc.arg(runtime), sqlc.arg(at), sqlc.arg(at))
ON CONFLICT (org_id, agent_client_id, external_session_id) DO NOTHING
RETURNING *;

-- name: InsertAgentSessionEvent :execrows
INSERT INTO agent_session_events (
  id, org_id, agent_client_id, session_id, event_id, seq, outcome, type,
  agent_id, parent_agent_id, agent_type, tool_use_id, tool, tool_kind, mcp_server,
  status, duration_ms, janusly_refs, occurred_at, received_at
) VALUES (
  sqlc.arg(id), sqlc.arg(org_id), sqlc.arg(agent_client_id), sqlc.arg(session_id), sqlc.arg(event_id),
  sqlc.narg(seq), sqlc.arg(outcome), sqlc.arg(type),
  sqlc.narg(agent_id), sqlc.narg(parent_agent_id), sqlc.narg(agent_type), sqlc.narg(tool_use_id),
  sqlc.narg(tool), sqlc.narg(tool_kind), sqlc.narg(mcp_server), sqlc.narg(status), sqlc.narg(duration_ms),
  sqlc.narg(janusly_refs), sqlc.arg(occurred_at), sqlc.arg(received_at)
)
ON CONFLICT (agent_client_id, event_id) DO NOTHING;

-- name: GetAgentSessionReceipt :one
SELECT session_id, outcome, seq, received_at FROM agent_session_events
WHERE agent_client_id = $1 AND event_id = $2;

-- name: ProjectAgentSessionEvent :one
UPDATE agent_sessions
SET event_count = event_count + 1,
    last_seq = last_seq + 1,
    last_event_at = GREATEST(last_event_at, sqlc.arg(at)),
    project = COALESCE(sqlc.narg(project), project),
    runtime_version = COALESCE(sqlc.narg(runtime_version), runtime_version),
    model = COALESCE(sqlc.narg(model), model),
    truncated = truncated OR event_count + 1 >= sqlc.arg(max_events)::int,
    status = CASE WHEN sqlc.arg(ends)::bool THEN 'ended' ELSE status END,
    end_status = CASE WHEN sqlc.arg(ends)::bool THEN sqlc.narg(end_status) ELSE end_status END,
    ended_at = CASE WHEN sqlc.arg(ends)::bool THEN COALESCE(ended_at, sqlc.arg(at)) ELSE ended_at END
WHERE org_id = sqlc.arg(org_id) AND id = sqlc.arg(id)
RETURNING last_seq;

-- A stale receipt counts toward the session's cap without touching its order.
-- name: CountAgentSessionReceipt :exec
UPDATE agent_sessions SET event_count = event_count + 1
WHERE org_id = sqlc.arg(org_id) AND id = sqlc.arg(id);

-- Serializes new sessions per client so the live cap holds under concurrency.
-- name: LockAgentClientSessions :exec
SELECT pg_advisory_xact_lock(hashtextextended('agent_sessions:' || sqlc.arg(agent_client_id)::text, 0));

-- Drops a batch of sessions silent past the cutoff; their events cascade.
-- Rows an ingest holds are skipped and rechecked on the next pass.
-- name: DeleteExpiredAgentSessionsBatch :execrows
WITH doomed AS (
  SELECT a.id FROM agent_sessions a
  WHERE a.last_event_at < sqlc.arg(cutoff)::timestamptz
  ORDER BY a.last_event_at
  LIMIT sqlc.arg(batch_size)::int
  FOR UPDATE SKIP LOCKED
)
DELETE FROM agent_sessions s USING doomed
WHERE s.id = doomed.id AND s.last_event_at < sqlc.arg(cutoff)::timestamptz;

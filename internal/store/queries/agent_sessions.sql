-- Locks the session row so seq stays dense under concurrent hooks.
-- name: LockAgentSessionByExternal :one
SELECT * FROM agent_sessions
WHERE org_id = $1 AND agent_client_id = $2 AND external_session_id = $3
FOR UPDATE;

-- name: GetAgentSessionByExternal :one
SELECT id FROM agent_sessions
WHERE org_id = $1 AND agent_client_id = $2 AND external_session_id = $3;

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

-- name: ListAgentSessions :many
SELECT s.id, s.agent_client_id, coalesce(c.name, '')::text AS agent_client_name, s.runtime, s.project, s.model,
       s.status, s.truncated, s.event_count, s.started_at, s.last_event_at, s.ended_at,
       coalesce(c.created_by, '')::text AS client_created_by
FROM agent_sessions s
LEFT JOIN agent_clients c ON c.org_id = s.org_id AND c.id = s.agent_client_id
WHERE s.org_id = sqlc.arg(org_id)
  AND (s.last_event_at, s.id) < (sqlc.arg(before_at)::timestamptz, sqlc.arg(before_id)::text)
ORDER BY s.last_event_at DESC, s.id DESC
LIMIT sqlc.arg(page_limit);

-- name: GetAgentSession :one
SELECT s.id, s.agent_client_id, coalesce(c.name, '')::text AS agent_client_name, s.runtime, s.project, s.model,
       s.status, s.truncated, s.event_count, s.started_at, s.last_event_at, s.ended_at,
       coalesce(c.created_by, '')::text AS client_created_by
FROM agent_sessions s
LEFT JOIN agent_clients c ON c.org_id = s.org_id AND c.id = s.agent_client_id
WHERE s.org_id = $1 AND s.id = $2;

-- name: ListAgentSessionEvents :many
SELECT seq, type, agent_id, parent_agent_id, agent_type, tool_use_id, tool, tool_kind, mcp_server,
       status, duration_ms, janusly_refs, occurred_at
FROM agent_session_events
WHERE org_id = sqlc.arg(org_id) AND session_id = sqlc.arg(session_id) AND outcome = 'applied'
ORDER BY seq
LIMIT sqlc.arg(row_limit);

-- Sessions whose Janusly calls named this run. A session reports the link
-- itself, so it counts only when an agent client of the same creator started
-- the run.
-- name: ListAgentSessionsForRun :many
SELECT DISTINCT s.id, c.name AS agent_client_name, s.runtime, s.last_event_at
FROM agent_session_events e
JOIN agent_sessions s ON s.id = e.session_id AND s.org_id = e.org_id
JOIN agent_clients c ON c.org_id = s.org_id AND c.id = s.agent_client_id
JOIN runs r ON r.org_id = e.org_id AND r.id = sqlc.arg(run_id)::text
JOIN agent_clients starter ON starter.org_id = r.org_id AND 'agent:' || starter.id = r.created_by
WHERE e.org_id = sqlc.arg(org_id) AND e.janusly_refs->>'runId' = sqlc.arg(run_id)::text
  AND starter.created_by = c.created_by
ORDER BY s.last_event_at DESC
LIMIT 10;

-- The reported run ids an agent client of the session client's creator started.
-- name: VerifyAgentSessionRunRefs :many
SELECT r.id FROM runs r
JOIN agent_clients starter ON starter.org_id = r.org_id AND 'agent:' || starter.id = r.created_by
JOIN agent_clients c ON c.org_id = r.org_id AND c.id = sqlc.arg(agent_client_id)::text
WHERE r.org_id = sqlc.arg(org_id) AND r.id = ANY(sqlc.arg(run_ids)::text[])
  AND starter.created_by = c.created_by
ORDER BY r.id;

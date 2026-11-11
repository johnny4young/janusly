-- name: ListRunMapNodes :many
SELECT node_id, status, coalesce(attempts, 0)::int AS attempts, started_at, finished_at, state_json,
       coalesce(error_json->>'childRunId', '')::text AS failed_child_run_id
FROM run_nodes
WHERE org_id = $1 AND run_id = $2
ORDER BY node_id;

-- name: ListRunNodeCosts :many
SELECT coalesce(metadata->>'nodeId', '')::text AS node_id,
       coalesce(sum(greatest((metadata->>'costUsd')::double precision, 0))
         FILTER (WHERE jsonb_typeof(metadata->'costUsd') = 'number'), 0)::float8 AS cost_usd,
       coalesce(sum(quantity), 0)::bigint AS tokens
FROM usage_events
WHERE org_id = $1 AND run_id = $2 AND metric = 'llm.completion'
  AND metadata->'providerSimulated' IS DISTINCT FROM 'true'::jsonb
GROUP BY 1;

-- How long this step usually takes in this workflow: the median of its
-- successful executions in the workflow's last 200 runs, so the cost of a
-- poll never grows with the workflow's history.
-- name: ListRunNodeTypicalDurations :many
WITH recent_runs AS (
  SELECT r.id FROM runs r
  WHERE r.org_id = sqlc.arg(org_id) AND r.workflow_id = sqlc.arg(workflow_id)::text AND r.id <> sqlc.arg(run_id)
  ORDER BY r.created_at DESC, r.id DESC
  LIMIT 200
)
SELECT rn.node_id,
       (percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM rn.finished_at - rn.started_at) * 1000))::float8 AS median_ms
FROM recent_runs
JOIN run_nodes rn ON rn.org_id = sqlc.arg(org_id) AND rn.run_id = recent_runs.id
WHERE rn.status = 'succeeded' AND rn.started_at IS NOT NULL AND rn.finished_at IS NOT NULL
  AND rn.node_id = ANY(sqlc.arg(node_ids)::text[])
GROUP BY rn.node_id;

-- The latest events of each agent node, so one busy node cannot hide another's lane.
-- name: ListRunAgentEvents :many
SELECT node_id, type, payload, created_at FROM (
  SELECT coalesce(node_id, '')::text AS node_id, type, payload, created_at, seq,
         row_number() OVER (PARTITION BY node_id ORDER BY seq DESC) AS recent
  FROM run_events
  WHERE org_id = sqlc.arg(org_id) AND run_id = sqlc.arg(run_id) AND (type LIKE 'agent.%' OR type LIKE 'multi_agent.%')
) events
WHERE recent <= sqlc.arg(per_node)::int
ORDER BY seq;

-- name: ListPendingToolApprovalsForOrg :many
SELECT t.id, t.run_id, t.node_id, t.tool, t.requester_ids, t.expires_at, coalesce(r.workflow_id, '')::text AS workflow_id
FROM tool_approval_requests t
JOIN runs r ON r.id = t.run_id AND r.org_id = t.org_id
WHERE t.org_id = sqlc.arg(org_id) AND t.status = 'pending' AND t.consumed_at IS NULL AND t.expires_at > now()
  AND sqlc.arg(viewer)::text <> ALL (t.requester_ids)
  AND r.status = 'running' AND r.replay_mode IS NULL
  AND EXISTS (SELECT 1 FROM run_nodes rn WHERE rn.org_id = t.org_id AND rn.run_id = t.run_id AND rn.node_id = t.node_id
              AND rn.status = 'waiting' AND rn.state_json #>> '{waiting,kind}' = 'tool_approval')
ORDER BY t.created_at
LIMIT 50;

-- name: ListWaitingPersonStepsForOrg :many
SELECT rn.run_id, rn.node_id, rn.started_at, coalesce(rn.state_json->'waiting'->>'kind', '')::text AS kind,
       coalesce(r.workflow_id, '')::text AS workflow_id
FROM run_nodes rn
JOIN runs r ON r.org_id = rn.org_id AND r.id = rn.run_id
WHERE rn.org_id = $1 AND rn.status = 'waiting' AND r.status = 'running' AND r.replay_mode IS NULL
  AND (rn.state_json->'waiting'->>'kind' = 'approval'
       OR (rn.state_json->'waiting'->>'kind' = 'human_form'
           AND (rn.state_json->'waiting'->>'resumeTokenExpiresAt')::timestamptz > now()))
ORDER BY rn.started_at NULLS LAST
LIMIT 50;

-- name: ListPendingToolApprovalRequesters :many
SELECT node_id, requester_ids FROM tool_approval_requests
WHERE org_id = $1 AND run_id = $2 AND status = 'pending' AND consumed_at IS NULL AND expires_at > now();

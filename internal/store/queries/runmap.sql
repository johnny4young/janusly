-- name: ListRunMapNodes :many
SELECT node_id, status, coalesce(attempts, 0)::int AS attempts, started_at, finished_at, state_json
FROM run_nodes
WHERE org_id = $1 AND run_id = $2
ORDER BY node_id;

-- name: ListRunNodeCosts :many
SELECT coalesce(metadata->>'nodeId', '')::text AS node_id,
       coalesce(sum((metadata->>'costUsd')::numeric), 0)::float8 AS cost_usd,
       coalesce(sum(quantity), 0)::bigint AS tokens
FROM usage_events
WHERE org_id = $1 AND run_id = $2 AND metric = 'llm.completion'
GROUP BY 1;

-- How long this step usually takes in this workflow: the median of its last
-- twenty successful executions.
-- name: ListRunNodeTypicalDurations :many
SELECT recent.node_id, (percentile_cont(0.5) WITHIN GROUP (ORDER BY recent.ms))::float8 AS median_ms
FROM (
  SELECT rn.node_id, extract(epoch FROM rn.finished_at - rn.started_at) * 1000 AS ms,
         row_number() OVER (PARTITION BY rn.node_id ORDER BY rn.finished_at DESC) AS position
  FROM run_nodes rn
  JOIN runs r ON r.org_id = rn.org_id AND r.id = rn.run_id
  WHERE rn.org_id = sqlc.arg(org_id) AND r.workflow_id = sqlc.arg(workflow_id)::text AND r.id <> sqlc.arg(run_id)
    AND rn.status = 'succeeded' AND rn.started_at IS NOT NULL AND rn.finished_at IS NOT NULL
    AND rn.node_id = ANY(sqlc.arg(node_ids)::text[])
) recent
WHERE recent.position <= 20
GROUP BY recent.node_id;

-- name: ListRunAgentEvents :many
SELECT coalesce(node_id, '')::text AS node_id, type, payload, created_at
FROM run_events
WHERE org_id = $1 AND run_id = $2 AND (type LIKE 'agent.%' OR type LIKE 'multi_agent.%')
ORDER BY seq
LIMIT 500;

-- name: ListPendingToolApprovalsForOrg :many
SELECT t.id, t.run_id, t.node_id, t.tool, t.requester_ids, t.expires_at, coalesce(r.workflow_id, '')::text AS workflow_id
FROM tool_approval_requests t
JOIN runs r ON r.id = t.run_id AND r.org_id = t.org_id
WHERE t.org_id = $1 AND t.status = 'pending' AND t.consumed_at IS NULL AND t.expires_at > now()
ORDER BY t.created_at
LIMIT 50;

-- name: ListWaitingPersonStepsForOrg :many
SELECT rn.run_id, rn.node_id, rn.started_at, coalesce(rn.state_json->'waiting'->>'kind', '')::text AS kind,
       coalesce(r.workflow_id, '')::text AS workflow_id
FROM run_nodes rn
JOIN runs r ON r.org_id = rn.org_id AND r.id = rn.run_id
WHERE rn.org_id = $1 AND rn.status = 'waiting' AND r.status = 'running' AND r.replay_mode IS NULL
  AND rn.state_json->'waiting'->>'kind' IN ('approval', 'human_form')
ORDER BY rn.started_at NULLS LAST
LIMIT 50;

-- name: ListPendingToolApprovalRequesters :many
SELECT node_id, requester_ids FROM tool_approval_requests
WHERE org_id = $1 AND run_id = $2 AND status = 'pending' AND consumed_at IS NULL;

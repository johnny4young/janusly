-- Tool approvals: one human decision per tool execution.

-- name: GetLiveToolApproval :one
SELECT * FROM tool_approval_requests
WHERE run_id = $1 AND node_id = $2 AND consumed_at IS NULL
FOR UPDATE;

-- name: GetToolApprovalForOrg :one
SELECT * FROM tool_approval_requests WHERE id = $1 AND org_id = $2
FOR UPDATE;

-- name: InsertToolApproval :one
INSERT INTO tool_approval_requests
  (id, org_id, run_id, node_id, tool, params_json, params_digest, requester_ids, eligible_approvers, expires_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, sqlc.arg(requester_ids)::text[], sqlc.narg(eligible_approvers), now() + interval '30 minutes')
RETURNING *;

-- The people who caused this execution: the creators of the run and its
-- subworkflow parents, anyone who submitted a form along that lineage, and
-- whoever redrove this run most recently.
-- name: ListToolApprovalRequesters :many
WITH RECURSIVE lineage (id, parent_run_id, follow, depth) AS (
  SELECT r.id, r.parent_run_id,
         r.parent_node_id IS NOT NULL AND coalesce(r.parent_link_kind, 'subworkflow') = 'subworkflow', 0
  FROM runs r WHERE r.id = sqlc.arg(run_id)
  UNION ALL
  SELECT p.id, p.parent_run_id,
         p.parent_node_id IS NOT NULL AND coalesce(p.parent_link_kind, 'subworkflow') = 'subworkflow', l.depth + 1
  FROM runs p JOIN lineage l ON p.id = l.parent_run_id
  WHERE l.follow AND l.depth < 32
)
SELECT DISTINCT actor::text FROM (
  SELECT r.created_by AS actor FROM runs r JOIN lineage l ON r.id = l.id
  UNION ALL
  SELECT a.actor FROM run_actors a JOIN lineage l ON a.run_id = l.id WHERE a.role = 'resume'
  UNION ALL
  (SELECT a.actor FROM run_actors a WHERE a.run_id = sqlc.arg(run_id) AND a.role = 'redrive'
   ORDER BY a.acted_at DESC LIMIT 1)
) actors
WHERE actor IS NOT NULL AND actor <> ''
ORDER BY actor;

-- name: RecordRunActor :exec
INSERT INTO run_actors (run_id, role, actor) VALUES ($1, $2, $3)
ON CONFLICT (run_id, role, actor) DO UPDATE SET acted_at = now();

-- A step that fails or is redriven before the gate spends its decision gives
-- the decision up, so the next execution asks again.
-- name: RetireToolApprovals :exec
UPDATE tool_approval_requests
SET consumed_at = now(), status = CASE WHEN status = 'pending' THEN 'expired' ELSE status END
WHERE run_id = $1 AND node_id = $2 AND consumed_at IS NULL;

-- name: DecideToolApproval :execrows
UPDATE tool_approval_requests
SET status = sqlc.arg(status), decided_by = sqlc.arg(actor)::text, decided_at = now()
WHERE id = sqlc.arg(id) AND org_id = sqlc.arg(org_id)
  AND status = 'pending' AND consumed_at IS NULL AND expires_at > now()
  AND params_digest = sqlc.arg(params_digest)
  AND sqlc.arg(actor)::text <> ALL (requester_ids);

-- name: ExpireToolApproval :execrows
UPDATE tool_approval_requests SET status = 'expired'
WHERE id = $1 AND status = 'pending' AND consumed_at IS NULL AND expires_at <= now();

-- A worker acts on a decision exactly once: execute, or fail the step.
-- A timely approval stays spendable for a while after the decision deadline,
-- so a busy queue does not fail it.
-- name: ConsumeToolApproval :one
UPDATE tool_approval_requests SET consumed_at = now()
WHERE id = $1 AND consumed_at IS NULL AND status <> 'pending'
RETURNING status <> 'approved' OR now() <= decided_at + interval '30 minutes' AS in_time;

-- name: RequeueToolApprovalNode :one
UPDATE run_nodes
SET status = 'queued', enqueued_at = clock_timestamp(),
    queue_publication_repair_after = clock_timestamp(),
    queue_publication_generation = queue_publication_generation + 1
WHERE run_id = sqlc.arg(run_id) AND node_id = sqlc.arg(node_id) AND status = 'waiting'
  AND state_json #>> '{waiting,kind}' = 'tool_approval'
  AND state_json #>> '{waiting,approvalId}' = sqlc.arg(approval_id)::text
RETURNING id;

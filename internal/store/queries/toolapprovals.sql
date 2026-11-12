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

-- The people who caused this call. Run-tree roles count anywhere in the tree
-- (the lineage up through subworkflow, rerun and replay links, plus every
-- subworkflow descendant): form submitters (resume), a redrive that replaced the document
-- (fix), a person who replaced a step's output (output) and a service-token
-- starter (service). A plain redrive counts in this run and the runs above
-- it, whose steps can feed this call, but not in sibling or child runs. Plus
-- the creators up the lineage, everyone an earlier request for the step
-- excluded, and, when no person started this run or a subworkflow parent (a
-- replay or rerun source does not count), whoever saved its versions. An
-- agent client counts with the member it acts for. Walks stop at max_depth.
-- name: ListToolApprovalRequesters :many
WITH RECURSIVE lineage (id, parent_run_id, follow, via_subworkflow, own, depth) AS (
  SELECT r.id, r.parent_run_id,
         r.parent_link_kind IN ('rerun', 'replay') OR (r.parent_node_id IS NOT NULL AND coalesce(r.parent_link_kind, 'subworkflow') = 'subworkflow'),
         r.parent_node_id IS NOT NULL AND coalesce(r.parent_link_kind, 'subworkflow') = 'subworkflow',
         true, 0
  FROM runs r WHERE r.id = sqlc.arg(run_id)
  UNION ALL
  SELECT p.id, p.parent_run_id,
         p.parent_link_kind IN ('rerun', 'replay') OR (p.parent_node_id IS NOT NULL AND coalesce(p.parent_link_kind, 'subworkflow') = 'subworkflow'),
         p.parent_node_id IS NOT NULL AND coalesce(p.parent_link_kind, 'subworkflow') = 'subworkflow',
         l.own AND l.via_subworkflow, l.depth + 1
  FROM runs p JOIN lineage l ON p.id = l.parent_run_id
  WHERE l.follow AND l.depth < sqlc.arg(max_depth)::int
),
tree (id, depth) AS (
  SELECT l.id, 0 FROM lineage l
  UNION
  SELECT c.id, t.depth + 1 FROM runs c JOIN tree t ON c.parent_run_id = t.id
  WHERE c.parent_node_id IS NOT NULL AND coalesce(c.parent_link_kind, 'subworkflow') = 'subworkflow'
    AND t.depth < sqlc.arg(max_depth)::int
),
started AS (
  SELECT r.id, r.created_by, r.trigger_kind, r.workflow_version_id, l.own FROM runs r JOIN lineage l ON r.id = l.id
),
found AS (
SELECT DISTINCT actor::text AS actor FROM (
  SELECT created_by AS actor FROM started
  UNION ALL
  SELECT a.actor FROM run_actors a JOIN tree t ON a.run_id = t.id WHERE a.role <> 'redrive'
  UNION ALL
  SELECT a.actor FROM run_actors a JOIN lineage l ON a.run_id = l.id WHERE a.role = 'redrive'
  UNION ALL
  SELECT unnest(t.requester_ids) FROM tool_approval_requests t
  WHERE t.run_id = sqlc.arg(run_id) AND t.node_id = sqlc.arg(node_id)
  UNION ALL
  SELECT v.created_by FROM workflow_versions v JOIN started s ON v.id = s.workflow_version_id
  WHERE NOT EXISTS (
    SELECT 1 FROM started h
    WHERE h.own AND coalesce(h.created_by, '') <> '' AND h.created_by NOT LIKE 'system:%' AND h.trigger_kind IS NULL
      AND NOT EXISTS (SELECT 1 FROM run_actors sa WHERE sa.run_id = h.id AND sa.role = 'service')
  )
) actors
WHERE actor IS NOT NULL AND actor <> ''
)
SELECT f.actor FROM found f
UNION
SELECT ac.created_by FROM found f
JOIN agent_clients ac ON f.actor LIKE 'agent:%' AND ac.id = substr(f.actor, 7)
  AND ac.org_id = (SELECT r.org_id FROM runs r WHERE r.id = sqlc.arg(run_id))
ORDER BY actor;

-- name: HasLiveToolApproval :one
SELECT EXISTS (SELECT 1 FROM tool_approval_requests WHERE run_id = $1 AND node_id = $2 AND consumed_at IS NULL);

-- name: RecordRunActor :exec
INSERT INTO run_actors (run_id, node_id, role, actor) VALUES ($1, $2, $3, $4)
ON CONFLICT (run_id, node_id, role, actor) DO UPDATE SET acted_at = now();

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

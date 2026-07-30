-- Typed access to the shared schema. Conventions:
--   * every tenant-scoped read filters by org_id;
--   * keyset pagination orders by (created_at, id) with the id as tiebreak,
--     matching the wire cursors the Node API emits;
--   * status transitions are conditional updates (compare-and-set) so a
--     concurrent worker can never double-apply one;
--   * jsonb parameters and columns are raw bytes end to end.

-- name: InsertWorkflow :exec
INSERT INTO workflows (id, org_id, name, created_by)
VALUES ($1, $2, $3, $4);

-- name: GetWorkflow :one
SELECT id, org_id, name, status, paused_reason, created_by, created_at, deleted_at
FROM workflows
WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL;

-- name: ListWorkflows :many
SELECT id, org_id, name, status, created_by, created_at
FROM workflows
WHERE org_id = $1
  AND deleted_at IS NULL
  AND (created_at, id) < (sqlc.arg(before_created_at)::timestamptz, sqlc.arg(before_id)::text)
ORDER BY created_at DESC, id DESC
LIMIT sqlc.arg(page_limit);

-- name: InsertWorkflowVersion :exec
INSERT INTO workflow_versions (id, org_id, workflow_id, version, dag_json, created_by)
VALUES ($1, $2, $3, $4, $5, $6);

-- name: GetLatestWorkflowVersion :one
SELECT id, org_id, workflow_id, version, dag_json, created_by, created_at
FROM workflow_versions
WHERE workflow_id = $1 AND org_id = $2
ORDER BY version DESC
LIMIT 1;

-- name: InsertRun :exec
INSERT INTO runs (id, org_id, workflow_version_id, status, input_json, created_by)
VALUES ($1, $2, $3, $4, $5, $6);

-- name: GetRun :one
SELECT id, org_id, workflow_version_id, status, input_json, output_json,
       parent_run_id, parent_node_id, replay_mode, created_by, created_at
FROM runs
WHERE id = $1 AND org_id = $2;

-- name: ListRuns :many
SELECT id, org_id, workflow_version_id, status, created_by, created_at
FROM runs
WHERE org_id = $1
  AND (created_at, id) < (sqlc.arg(before_created_at)::timestamptz, sqlc.arg(before_id)::text)
ORDER BY created_at DESC, id DESC
LIMIT sqlc.arg(page_limit);

-- name: UpdateRunStatusCAS :execrows
UPDATE runs SET status = $4, output_json = COALESCE($5, output_json)
WHERE id = $1 AND org_id = $2 AND status = $3;

-- name: InsertRunNode :exec
INSERT INTO run_nodes (id, run_id, node_id, status, attempts, state_json)
VALUES ($1, $2, $3, $4, $5, $6);

-- name: GetRunNode :one
SELECT id, run_id, node_id, status, state_json, attempts, started_at,
       finished_at, error_json
FROM run_nodes
WHERE run_id = $1 AND node_id = $2;

-- name: ListRunNodesByRun :many
SELECT id, run_id, node_id, status, state_json, attempts, started_at,
       finished_at, error_json
FROM run_nodes
WHERE run_id = $1
ORDER BY id;

-- name: QueueRunNode :execrows
UPDATE run_nodes SET status = 'queued'
WHERE run_id = $1 AND node_id = $2 AND status = 'pending';

-- name: CompleteRunNode :execrows
UPDATE run_nodes
SET status = 'succeeded', state_json = $3, finished_at = now()
WHERE run_id = $1 AND node_id = $2 AND status = 'running';

-- name: FailRunNode :execrows
UPDATE run_nodes
SET status = $4, error_json = $3, finished_at = now()
WHERE run_id = $1 AND node_id = $2 AND status = 'running';

-- name: InsertRunEvent :exec
INSERT INTO run_events (id, run_id, node_id, type, payload)
VALUES ($1, $2, $3, $4, $5);

-- name: ListRunEvents :many
SELECT id, run_id, node_id, type, payload, created_at
FROM run_events
WHERE run_id = $1
  AND (created_at, id) < (sqlc.arg(before_created_at)::timestamptz, sqlc.arg(before_id)::text)
ORDER BY created_at DESC, id DESC
LIMIT sqlc.arg(page_limit);

-- name: InsertDeadLetter :exec
INSERT INTO dead_letters (id, org_id, run_id, node_id, attempt, workflow_json, node_json, error_json)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8);

-- name: GetDeadLetter :one
SELECT id, org_id, run_id, node_id, attempt, workflow_json, node_json,
       error_json, status, replayed_at, created_at, replay_claimed_at
FROM dead_letters
WHERE id = $1 AND org_id = $2;

-- name: ListDeadLetters :many
SELECT id, org_id, run_id, node_id, attempt, error_json, status, created_at
FROM dead_letters
WHERE org_id = $1
  AND (created_at, id) < (sqlc.arg(before_created_at)::timestamptz, sqlc.arg(before_id)::text)
ORDER BY created_at DESC, id DESC
LIMIT sqlc.arg(page_limit);

-- name: ClaimDeadLetterReplay :execrows
UPDATE dead_letters SET replay_claimed_at = now()
WHERE id = $1 AND org_id = $2 AND replay_claimed_at IS NULL;

-- name: UpsertWakeup :exec
INSERT INTO go_pilot_wakeups (run_node_id, wake_at, reason)
VALUES ($1, $2, $3)
ON CONFLICT (run_node_id) DO UPDATE SET wake_at = EXCLUDED.wake_at, reason = EXCLUDED.reason;

-- name: ListDueWakeups :many
SELECT run_node_id, wake_at, reason
FROM go_pilot_wakeups
WHERE wake_at <= now()
ORDER BY wake_at
LIMIT $1;

-- name: DeleteWakeup :exec
DELETE FROM go_pilot_wakeups WHERE run_node_id = $1;

-- name: NotifyWake :exec
SELECT pg_notify('janusly_go_wake', sqlc.arg(run_id)::text);

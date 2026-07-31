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
UPDATE run_nodes SET status = 'queued', attempts = 1
WHERE run_id = $1 AND node_id = $2 AND status = 'pending';

-- The claim is the queue's consume operation: SKIP LOCKED lets N workers
-- pull disjoint rows without blocking each other, and the runs join keeps
-- nodes of cancelled/failed runs from ever being picked up.
-- name: ClaimQueuedRunNodes :many
UPDATE run_nodes SET status = 'running', started_at = now()
WHERE id IN (
  SELECT rn.id
  FROM run_nodes rn
  JOIN runs r ON r.id = rn.run_id
  WHERE rn.status = 'queued' AND r.status = 'running'
    AND NOT EXISTS (
      SELECT 1 FROM go_pilot_wakeups w
      WHERE w.run_node_id = rn.id AND w.wake_at > now()
    )
  ORDER BY rn.id
  LIMIT sqlc.arg(batch_size)
  FOR UPDATE OF rn SKIP LOCKED
)
RETURNING id, run_id, node_id, COALESCE(attempts, 1)::int AS attempt;

-- Serializes node-completion transactions per run: the xact lock releases
-- on commit, so a concurrent sibling's readiness scan always observes this
-- completion — the fan-in gate for joins.
-- name: AcquireRunCompletionLock :exec
SELECT pg_advisory_xact_lock(hashtextextended(sqlc.arg(run_id)::text, 0));

-- name: CompleteRunNode :execrows
UPDATE run_nodes
SET status = 'succeeded', state_json = sqlc.arg(state_json),
    finished_at = sqlc.arg(finished_at)
WHERE run_id = sqlc.arg(run_id) AND node_id = sqlc.arg(node_id)
  AND status = 'running';

-- name: FailRunNode :execrows
UPDATE run_nodes
SET status = 'failed', error_json = sqlc.arg(error_json),
    finished_at = sqlc.arg(finished_at)
WHERE run_id = sqlc.arg(run_id) AND node_id = sqlc.arg(node_id)
  AND status = 'running';

-- name: GetRunExecution :one
SELECT status, org_id, input_json FROM runs WHERE id = $1;

-- name: RequeueRunNodeForRetry :execrows
UPDATE run_nodes SET status = 'queued', attempts = sqlc.arg(attempt)
WHERE run_id = sqlc.arg(run_id) AND node_id = sqlc.arg(node_id)
  AND status = 'running';

-- name: ListRunNodeStatuses :many
SELECT node_id, status FROM run_nodes WHERE run_id = $1;

-- name: MarkRunTerminalFromRunning :execrows
UPDATE runs SET status = sqlc.arg(status), output_json = sqlc.arg(output_json)
WHERE id = sqlc.arg(id) AND status = 'running';

-- name: MarkRunNodeWaiting :execrows
UPDATE run_nodes SET status = 'waiting', state_json = sqlc.arg(state_json)
WHERE run_id = sqlc.arg(run_id) AND node_id = sqlc.arg(node_id)
  AND status = 'running';

-- name: MarkWaitingNodeSucceeded :one
UPDATE run_nodes
SET status = 'succeeded', state_json = sqlc.arg(state_json),
    finished_at = sqlc.arg(finished_at)
WHERE run_id = sqlc.arg(run_id) AND node_id = sqlc.arg(node_id)
  AND status = 'waiting'
RETURNING id;

-- name: SkipRunNode :execrows
UPDATE run_nodes
SET status = 'skipped', state_json = sqlc.arg(state_json),
    finished_at = sqlc.arg(finished_at)
WHERE run_id = sqlc.arg(run_id) AND node_id = sqlc.arg(node_id)
  AND status = 'pending';

-- name: InsertRunEvent :exec
INSERT INTO run_events (id, run_id, node_id, type, payload)
VALUES ($1, $2, $3, $4, $5);

-- name: InsertRunEventAt :exec
INSERT INTO run_events (id, run_id, node_id, type, payload, created_at)
VALUES ($1, $2, $3, $4, $5, $6);

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

-- Garbage-collects consumed wake-ups. Correctness never depends on this:
-- the claim's anti-join reads wake_at against now(), so a due retry is
-- claimable the moment its clock passes — this just trims rows and nudges
-- idle workers awake.
-- name: SweepDueWakeups :execrows
DELETE FROM go_pilot_wakeups w
WHERE w.wake_at <= now()
  AND NOT EXISTS (
    SELECT 1 FROM run_nodes rn
    WHERE rn.id = w.run_node_id AND rn.status = 'waiting'
  );

-- Due timers attached to still-waiting nodes: the sweeper resumes these —
-- the auto-completion path for wait_until.
-- name: ListDueWaitingWakeups :many
SELECT w.run_node_id, rn.run_id, rn.node_id
FROM go_pilot_wakeups w
JOIN run_nodes rn ON rn.id = w.run_node_id
WHERE w.wake_at <= now() AND rn.status = 'waiting'
LIMIT sqlc.arg(batch_size);

-- name: NotifyWake :exec
SELECT pg_notify('janusly_go_wake', sqlc.arg(run_id)::text);

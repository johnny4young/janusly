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

-- Workflow list rows with the read-surface aggregates: run count and last
-- run status match runs either through saved versions or the ad-hoc
-- version-id fallback, mirroring the runs-list filter.
-- name: ListWorkflowRows :many
SELECT w.id, w.org_id, w.name, w.created_by, w.created_at, w.status,
       w.paused_reason, w.deleted_at,
       (SELECT count(*) FROM runs r
        WHERE r.org_id = w.org_id
          AND (r.workflow_version_id = w.id OR r.workflow_version_id IN (
            SELECT wv.id FROM workflow_versions wv WHERE wv.workflow_id = w.id
          )))::int AS run_count,
       (SELECT r.status FROM runs r
        WHERE r.org_id = w.org_id
          AND (r.workflow_version_id = w.id OR r.workflow_version_id IN (
            SELECT wv.id FROM workflow_versions wv WHERE wv.workflow_id = w.id
          ))
        ORDER BY r.created_at DESC, r.id DESC LIMIT 1) AS last_run_status
FROM workflows w
WHERE w.org_id = $1 AND w.deleted_at IS NULL
  AND (w.created_at, w.id) < (sqlc.arg(before_created_at)::timestamptz, sqlc.arg(before_id)::text)
  AND (sqlc.narg(search)::text IS NULL
       OR w.name ILIKE '%' || sqlc.narg(search) || '%'
       OR w.id ILIKE '%' || sqlc.narg(search) || '%')
ORDER BY w.created_at DESC, w.id DESC
LIMIT sqlc.arg(page_limit);

-- name: ListWorkflowVersions :many
SELECT id, org_id, workflow_id, version, dag_json, created_by, created_at
FROM workflow_versions
WHERE workflow_id = $1 AND org_id = $2
ORDER BY version DESC;

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

-- The claim is the queue's consume operation, split in TWO statements
-- inside one transaction on purpose. A single UPDATE-with-subquery is
-- vulnerable to an EvalPlanQual race under READ COMMITTED: when the locked
-- row changed since the statement snapshot, the NOT EXISTS wake-up guard
-- re-evaluates against the OLD snapshot — which predates a retry's
-- freshly-committed future wake-up — and a delayed retry gets claimed
-- instantly. Statement one locks candidates (SKIP LOCKED keeps workers
-- disjoint); statement two re-checks every guard under a FRESH snapshot on
-- rows we already hold, where no EPQ re-evaluation can occur.
-- name: LockClaimableRunNodes :many
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
FOR UPDATE OF rn SKIP LOCKED;

-- name: MarkLockedNodesRunning :many
UPDATE run_nodes SET status = 'running', started_at = now()
WHERE id = ANY(sqlc.arg(ids)::text[])
  AND status = 'queued'
  AND NOT EXISTS (
    SELECT 1 FROM go_pilot_wakeups w
    WHERE w.run_node_id = run_nodes.id AND w.wake_at > now()
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

-- name: GetRunOwner :one
SELECT org_id, status FROM runs WHERE id = $1;

-- name: CancelRun :exec
UPDATE runs SET status = 'cancelled' WHERE id = $1;

-- Running is deliberately excluded: an executing node finishes naturally
-- and the post-success guard absorbs its downstream scheduling.
-- name: CancelRunNodes :execrows
UPDATE run_nodes
SET status = 'cancelled', state_json = sqlc.arg(state_json),
    finished_at = sqlc.arg(finished_at)
WHERE run_id = sqlc.arg(run_id)
  AND status IN ('pending', 'queued', 'waiting');

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

-- Ascending page for the SSE catch-up: everything strictly after the
-- composite cursor, oldest first.
-- name: ListRunEventsAfter :many
SELECT id, run_id, node_id, type, payload, created_at
FROM run_events
WHERE run_id = $1
  AND (created_at, id) > (sqlc.arg(after_created_at)::timestamptz, sqlc.arg(after_id)::text)
ORDER BY created_at ASC, id ASC
LIMIT sqlc.arg(page_limit);

-- name: ListRunEvents :many
SELECT id, run_id, node_id, type, payload, created_at
FROM run_events
WHERE run_id = $1
  AND (created_at, id) < (sqlc.arg(before_created_at)::timestamptz, sqlc.arg(before_id)::text)
ORDER BY created_at DESC, id DESC
LIMIT sqlc.arg(page_limit);

-- Run summaries for the list surface: workflow identity joined through the
-- version snapshot, the waiting-node flag the Activity UI reads, the
-- (created_at, id) keyset the web walks via `before=<iso>|<id>` cursors, and
-- the contract's optional filters.
-- name: ListRunSummaries :many
SELECT r.id, r.org_id, r.workflow_version_id, r.status, r.output_json,
       r.parent_run_id, r.parent_node_id, r.replay_mode, r.created_by,
       r.created_at,
       wv.workflow_id AS workflow_id, w.name AS workflow_name,
       EXISTS (
         SELECT 1 FROM run_nodes rn
         WHERE rn.run_id = r.id AND rn.status = 'waiting'
       ) AS has_waiting_nodes
FROM runs r
LEFT JOIN workflow_versions wv ON wv.id = r.workflow_version_id
LEFT JOIN workflows w ON w.id = wv.workflow_id
WHERE r.org_id = $1
  AND (r.created_at, r.id) < (sqlc.arg(before_created_at)::timestamptz, sqlc.arg(before_id)::text)
  AND (sqlc.narg(filter_workflow_id)::text IS NULL
       OR wv.workflow_id = sqlc.narg(filter_workflow_id)
       OR (wv.id IS NULL AND r.workflow_version_id = sqlc.narg(filter_workflow_id)))
  AND (sqlc.narg(filter_status)::text IS NULL OR r.status = sqlc.narg(filter_status))
ORDER BY r.created_at DESC, r.id DESC
LIMIT sqlc.arg(page_limit);

-- name: ListDeadLetterSummaries :many
SELECT dl.id, dl.org_id, dl.run_id, dl.node_id, dl.attempt, dl.error_json,
       dl.status, dl.replayed_at, dl.created_at,
       dl.node_json->>'type' AS node_type,
       w.name AS workflow_name
FROM dead_letters dl
LEFT JOIN runs r ON r.id = dl.run_id
LEFT JOIN workflow_versions wv ON wv.id = r.workflow_version_id
LEFT JOIN workflows w ON w.id = wv.workflow_id
WHERE dl.org_id = $1
ORDER BY dl.created_at DESC, dl.id DESC
LIMIT sqlc.arg(page_limit);

-- name: CountWorkflowVersions :one
SELECT COALESCE(MAX(version), 0)::int FROM workflow_versions
WHERE workflow_id = $1 AND org_id = $2;

-- Stalled running nodes: the one failure mode the atomic claim cannot
-- self-heal (a worker killed mid-execution). Joined to open runs only.
-- name: FindStalledRunningNodes :many
SELECT rn.id, rn.run_id, rn.node_id, COALESCE(rn.attempts, 1)::int AS attempt
FROM run_nodes rn
JOIN runs r ON r.id = rn.run_id
WHERE rn.status = 'running'
  AND rn.started_at < now() - make_interval(secs => sqlc.arg(threshold_seconds)::float8)
  AND r.status IN ('running', 'failed')
ORDER BY rn.started_at
LIMIT sqlc.arg(batch_size);

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

-- name: CountDeadLettersByStatus :many
SELECT status, count(*) AS count FROM dead_letters
WHERE org_id = $1 GROUP BY status;

-- name: ClaimDeadLetterReplay :execrows
UPDATE dead_letters SET replay_claimed_at = now()
WHERE id = $1 AND org_id = $2 AND replay_claimed_at IS NULL;

-- name: RedriveFailedRunNode :one
UPDATE run_nodes
SET status = 'queued', attempts = COALESCE(attempts, 0) + 1
WHERE run_id = sqlc.arg(run_id) AND node_id = sqlc.arg(node_id)
  AND status = 'failed'
RETURNING COALESCE(attempts, 1)::int AS attempt;

-- name: ReviveFailedRun :execrows
UPDATE runs SET status = 'running'
WHERE id = sqlc.arg(id) AND status = 'failed';

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

-- Event-stream signal: fired inside every transaction that appends run
-- events, so SSE subscribers re-query exactly when something committed.
-- name: NotifyRunEvents :exec
SELECT pg_notify('janusly_go_run_events', sqlc.arg(run_id)::text);

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
       COALESCE(last_run.status, '') AS last_run_status
FROM workflows w
LEFT JOIN LATERAL (
  SELECT r.status FROM runs r
  WHERE r.org_id = w.org_id
    AND (r.workflow_version_id = w.id OR r.workflow_version_id IN (
      SELECT wv.id FROM workflow_versions wv WHERE wv.workflow_id = w.id
    ))
  ORDER BY r.created_at DESC, r.id DESC LIMIT 1
) last_run ON true
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

-- name: SoftDeleteWorkflow :execrows
UPDATE workflows SET deleted_at = now()
WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL;

-- name: RestoreWorkflow :execrows
UPDATE workflows SET deleted_at = NULL
WHERE id = $1 AND org_id = $2 AND deleted_at IS NOT NULL;

-- name: GetWorkflowOwnerState :one
SELECT org_id, deleted_at FROM workflows WHERE id = $1;

-- The trash list: the same list-row shape with deletedAt populated,
-- ordered by (deleted_at, id) DESC with its own keyset.
-- name: ListDeletedWorkflowRows :many
SELECT w.id, w.org_id, w.name, w.created_by, w.created_at, w.status,
       w.paused_reason, w.deleted_at,
       (SELECT count(*) FROM runs r
        WHERE r.org_id = w.org_id
          AND (r.workflow_version_id = w.id OR r.workflow_version_id IN (
            SELECT wv.id FROM workflow_versions wv WHERE wv.workflow_id = w.id
          )))::int AS run_count,
       COALESCE(last_run.status, '') AS last_run_status
FROM workflows w
LEFT JOIN LATERAL (
  SELECT r.status FROM runs r
  WHERE r.org_id = w.org_id
    AND (r.workflow_version_id = w.id OR r.workflow_version_id IN (
      SELECT wv.id FROM workflow_versions wv WHERE wv.workflow_id = w.id
    ))
  ORDER BY r.created_at DESC, r.id DESC LIMIT 1
) last_run ON true
WHERE w.org_id = $1 AND w.deleted_at IS NOT NULL
  AND (w.deleted_at, w.id) < (sqlc.arg(before_deleted_at)::timestamptz, sqlc.arg(before_id)::text)
ORDER BY w.deleted_at DESC, w.id DESC
LIMIT sqlc.arg(page_limit);

-- name: InsertWorkflowVersion :exec
INSERT INTO workflow_versions (id, org_id, workflow_id, version, dag_json, created_by)
VALUES ($1, $2, $3, $4, $5, $6);

-- name: GetWorkflowVersionByID :one
SELECT id, org_id, workflow_id, version, dag_json, created_by, created_at
FROM workflow_versions
WHERE id = $1 AND org_id = $2 AND workflow_id = $3;

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
  AND (sqlc.narg(filter_status)::text IS NULL OR dl.status = sqlc.narg(filter_status))
  AND (sqlc.narg(filter_node_id)::text IS NULL OR dl.node_id = sqlc.narg(filter_node_id))
  AND (sqlc.narg(filter_workflow_id)::text IS NULL
       OR wv.workflow_id = sqlc.narg(filter_workflow_id)
       OR (wv.id IS NULL AND r.workflow_version_id = sqlc.narg(filter_workflow_id)))
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

-- The claim is also the lifecycle flip: one statement takes the causal
-- replay claim AND moves the row open → replayed, so a claimed dead letter
-- can never linger as an eligible "open" member of a second cohort.
-- name: ClaimDeadLetterReplay :execrows
UPDATE dead_letters
SET replay_claimed_at = now(), status = 'replayed', replayed_at = now()
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
-- the auto-completion path for wait_until. Fairness under a mass-expiry
-- backlog (a downtime window leaving thousands due): round-robin by run —
-- every run's FIRST due timer sorts before any run's second — so one run
-- with a huge pile cannot starve the rest of the fleet out of a batch.
-- name: ListDueWaitingWakeups :many
SELECT run_node_id, run_id, node_id
FROM (
  SELECT w.run_node_id, rn.run_id, rn.node_id,
         ROW_NUMBER() OVER (PARTITION BY rn.run_id ORDER BY w.wake_at, w.run_node_id) AS run_rank
  FROM go_pilot_wakeups w
  JOIN run_nodes rn ON rn.id = w.run_node_id
  WHERE w.wake_at <= now() AND rn.status = 'waiting'
) ranked
ORDER BY run_rank, run_node_id
LIMIT sqlc.arg(batch_size);

-- name: NotifyWake :exec
SELECT pg_notify('janusly_go_wake', sqlc.arg(run_id)::text);

-- Event-stream signal: fired inside every transaction that appends run
-- events, so SSE subscribers re-query exactly when something committed.
-- name: NotifyRunEvents :exec
SELECT pg_notify('janusly_go_run_events', sqlc.arg(run_id)::text);

-- ── Trigger events (webhook ingest) ───────────────────────────────────
-- The shared trigger_events table is the DLQ-style replay anchor: the row
-- persists BEFORE the run spawns, idempotent on (org_id, dedupe_key) so a
-- relay retry converges instead of double-running.

-- name: GetWorkflowIngestState :one
SELECT org_id, status, deleted_at FROM workflows WHERE id = $1;

-- name: InsertTriggerEvent :execrows
INSERT INTO trigger_events (id, org_id, trigger_type, workflow_id,
                            workflow_version_id, node_id, status, dedupe_key, payload_json)
VALUES ($1, $2, $3, $4, $5, $6, 'received', $7, $8)
ON CONFLICT (org_id, dedupe_key) DO NOTHING;

-- name: FindTriggerEventByDedupe :one
SELECT id, org_id, trigger_type, workflow_id, workflow_version_id, node_id,
       status, run_id, dedupe_key, payload_json, skipped_reason, created_at
FROM trigger_events
WHERE org_id = $1 AND dedupe_key = $2;

-- name: GetTriggerEvent :one
SELECT id, org_id, trigger_type, workflow_id, workflow_version_id, node_id,
       status, run_id, dedupe_key, payload_json, skipped_reason, created_at
FROM trigger_events
WHERE org_id = $1 AND id = $2;

-- The start-claim CAS: runs inside the run-start transaction so "event
-- claimed" and "run exists" commit or roll back together (the reference
-- claims inside startRun's transaction the same way).
-- name: ClaimTriggerEventStart :execrows
UPDATE trigger_events
SET status = 'started', run_id = $3, skipped_reason = NULL,
    backfill_claim_token = NULL, backfill_claimed_at = NULL
WHERE org_id = $1 AND id = $2 AND status = 'received' AND run_id IS NULL;

-- name: MarkTriggerEventOutcome :execrows
UPDATE trigger_events
SET status = $3, skipped_reason = $4
WHERE org_id = $1 AND id = $2 AND status = 'received';
-- name: ListOrgHTTPConfig :many
SELECT key, value_json FROM org_configs
WHERE org_id = $1 AND category = 'http';

-- ── Failure clustering samples ────────────────────────────────────────
-- Both surfaces emit a sample for a failed run that landed in DLQ; the
-- aggregator dedupes by (run_id, node_id) preferring the dead_letter row.

-- name: ListDeadLetterFailureSamples :many
SELECT dl.id, dl.run_id, dl.node_id, dl.error_json, dl.created_at,
       r.input_json
FROM dead_letters dl
JOIN runs r ON r.id = dl.run_id
WHERE dl.org_id = $1 AND dl.created_at >= $2
ORDER BY dl.created_at DESC
LIMIT 2000;

-- name: ListFailedRunNodeSamples :many
SELECT rn.run_id, rn.node_id, rn.error_json, rn.finished_at,
       r.input_json
FROM run_nodes rn
JOIN runs r ON r.id = rn.run_id
WHERE r.org_id = $1 AND rn.status = 'failed' AND rn.finished_at >= $2
ORDER BY rn.finished_at DESC
LIMIT 2000;

-- ── Replay campaigns ──────────────────────────────────────────────────
-- The Postgres due clock (next_dispatch_at + the partial running index) is
-- the authoritative pacing substrate; the pilot pumps it directly instead
-- of mirroring dispatches into a queue.

-- name: ListReplayCampaignDeadLetters :many
SELECT id, run_id, node_id, status, error_json, node_json
FROM dead_letters
WHERE org_id = $1 AND id = ANY(sqlc.arg(ids)::text[]);

-- name: InsertReplayCampaign :exec
INSERT INTO replay_campaigns (id, org_id, name, cluster_signature, filter_json,
                              pacing_ms, total_count, created_by)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8);

-- name: InsertReplayCampaignItem :exec
INSERT INTO replay_campaign_items (id, org_id, campaign_id, dead_letter_id, position)
VALUES ($1, $2, $3, $4, $5);

-- name: GetReplayCampaign :one
SELECT * FROM replay_campaigns WHERE org_id = $1 AND id = $2;

-- name: ListReplayCampaignItems :many
SELECT * FROM replay_campaign_items
WHERE org_id = $1 AND campaign_id = $2
ORDER BY position;

-- name: ListReplayCampaigns :many
SELECT * FROM replay_campaigns
WHERE org_id = $1
ORDER BY created_at DESC
LIMIT $2;

-- Cancellation: pending items flip to cancelled and the campaign records
-- the truthful counter in one statement pair (same tx).
-- name: CancelRunningReplayCampaign :one
UPDATE replay_campaigns
SET status = 'cancelled', cancelled_by = $3, cancelled_at = now(), updated_at = now(),
    cancelled_count = cancelled_count + (
      SELECT count(*) FROM replay_campaign_items i
      WHERE i.campaign_id = replay_campaigns.id AND i.status = 'pending')
WHERE replay_campaigns.org_id = $1 AND replay_campaigns.id = $2
  AND replay_campaigns.status = 'running'
RETURNING *;

-- name: CancelPendingReplayCampaignItems :execrows
UPDATE replay_campaign_items SET status = 'cancelled', completed_at = now()
WHERE org_id = $1 AND campaign_id = $2 AND status = 'pending';

-- The pump's dispatch claim: lease one due running campaign and push its
-- clock forward by its own pacing in the same statement, so concurrent
-- pumps can't double-dispatch a step.
-- name: ClaimDueReplayCampaign :one
UPDATE replay_campaigns
SET next_dispatch_at = now() + make_interval(secs => pacing_ms / 1000.0),
    updated_at = now()
WHERE id = (
  SELECT id FROM replay_campaigns
  WHERE status = 'running' AND next_dispatch_at <= now()
  ORDER BY next_dispatch_at
  LIMIT 1
  FOR UPDATE SKIP LOCKED)
RETURNING *;

-- name: ClaimNextReplayCampaignItem :one
UPDATE replay_campaign_items
SET status = 'processing', claim_token = sqlc.arg(claim_token),
    claimed_at = now(), attempt_count = attempt_count + 1
WHERE replay_campaign_items.id = (
  SELECT i.id FROM replay_campaign_items i
  WHERE i.campaign_id = sqlc.arg(campaign_id) AND i.status = 'pending'
  ORDER BY i.position
  LIMIT 1
  FOR UPDATE SKIP LOCKED)
RETURNING *;

-- name: SettleReplayCampaignItem :execrows
UPDATE replay_campaign_items
SET status = sqlc.arg(status), error = sqlc.arg(error), completed_at = now()
WHERE id = sqlc.arg(id) AND claim_token = sqlc.arg(claim_token) AND status = 'processing';

-- name: BumpReplayCampaignCounter :exec
UPDATE replay_campaigns
SET replayed_count = replayed_count + sqlc.arg(replayed)::int,
    failed_count = failed_count + sqlc.arg(failed)::int,
    updated_at = now()
WHERE id = $1;

-- name: CompleteReplayCampaignIfExhausted :one
UPDATE replay_campaigns
SET status = 'completed', completed_at = now(), updated_at = now()
WHERE replay_campaigns.id = $1 AND replay_campaigns.status = 'running'
  AND NOT EXISTS (
    SELECT 1 FROM replay_campaign_items i
    WHERE i.campaign_id = $1 AND i.status IN ('pending', 'processing'))
RETURNING *;

-- Deferred hard cascade for tombstoned workflows: one data-modifying CTE
-- purges the expired workflows plus their versions and metadata atomically
-- — either the whole family goes or none of it does.
-- name: PurgeExpiredSoftDeletedWorkflows :one
WITH expired_workflows AS (
  SELECT id, org_id FROM workflows
  WHERE deleted_at IS NOT NULL AND deleted_at <= sqlc.arg(cutoff)::timestamptz
),
deleted_versions AS (
  DELETE FROM workflow_versions
  WHERE (org_id, workflow_id) IN (SELECT org_id, id FROM expired_workflows)
  RETURNING 1
),
deleted_metadata AS (
  DELETE FROM workflow_metadata
  WHERE (org_id, workflow_id) IN (SELECT org_id, id FROM expired_workflows)
  RETURNING 1
),
deleted_workflows AS (
  DELETE FROM workflows
  WHERE id IN (SELECT id FROM expired_workflows)
  RETURNING id
)
SELECT count(*)::int AS rows_deleted FROM deleted_workflows;

-- Verified-recovery north star over REAL redrives: a dead letter whose
-- replay was claimed and whose run then reached succeeded. Duration is
-- detection (dead letter row) → the run's terminal success event, the
-- pilot's equivalent of the reference's detectedAt → verifiedRecoveredAt.
-- percentile_cont matches the reference's percentile semantics exactly.
-- name: QueryVerifiedRecoveryStats :one
WITH recovered AS (
  SELECT EXTRACT(EPOCH FROM (ev.created_at - dl.created_at)) * 1000 AS duration_ms
  FROM dead_letters dl
  JOIN runs r ON r.id = dl.run_id
  JOIN LATERAL (
    SELECT re.created_at FROM run_events re
    WHERE re.run_id = dl.run_id AND re.type = 'run.succeeded'
      AND re.created_at >= dl.created_at
    ORDER BY re.created_at DESC LIMIT 1
  ) ev ON true
  WHERE dl.org_id = $1 AND dl.status = 'replayed' AND r.status = 'succeeded'
    AND dl.created_at >= now() - make_interval(days => sqlc.arg(window_days)::int)
)
SELECT count(*)::int AS sample_size,
       COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms), -1)::float8 AS p50_ms,
       COALESCE(percentile_cont(0.9) WITHIN GROUP (ORDER BY duration_ms), -1)::float8 AS p90_ms,
       COALESCE(avg(duration_ms), -1)::float8 AS mttr_avg_ms
FROM recovered;

-- name: GetOrgConfigValue :one
SELECT value_json FROM org_configs WHERE org_id = $1 AND key = $2;

-- name: ClaimStartIdempotencyKey :execrows
INSERT INTO go_pilot_start_idempotency (org_id, idempotency_key, run_id)
VALUES ($1, $2, $3)
ON CONFLICT (org_id, idempotency_key) DO NOTHING;

-- name: GetStartIdempotencyRun :one
SELECT run_id FROM go_pilot_start_idempotency
WHERE org_id = $1 AND idempotency_key = $2;

-- name: FindOpenDeadLetterForNode :one
SELECT id FROM dead_letters
WHERE org_id = $1 AND run_id = $2 AND node_id = $3 AND status = 'open'
ORDER BY created_at DESC
LIMIT 1;

-- ── Membership (the grant IS the org_members row) ─────────────────────

-- name: GetOrgMembership :one
SELECT id, org_id, user_id, role FROM org_members
WHERE org_id = $1 AND user_id = $2;

-- name: ListOrgMembershipsForUser :many
SELECT id, org_id, user_id, role FROM org_members
WHERE user_id = $1
ORDER BY created_at, id;

-- Legacy-orphan lazy backfill: rows seeded with userId = email before
-- invite-acceptance shipped migrate to the real provider UUID on first
-- authenticated sign-in.
-- name: FindOrgMemberByEmail :one
SELECT id, org_id, user_id, role FROM org_members
WHERE org_id = $1 AND lower(email) = lower($2);

-- name: MigrateOrgMemberUserID :execrows
UPDATE org_members SET user_id = $3
WHERE id = $1 AND org_id = $2;

-- name: GetOrgRole :one
SELECT id, org_id, name, inherits_from, description, is_builtin, granted_permissions
FROM org_roles
WHERE org_id = $1 AND name = $2;

-- ── Members + invitations ─────────────────────────────────────────────

-- name: ListOrgMembers :many
SELECT id, org_id, user_id, email, role, invited_by, created_at
FROM org_members WHERE org_id = $1
ORDER BY created_at, id;

-- name: UpdateOrgMemberRole :execrows
UPDATE org_members SET role = $3
WHERE org_id = $1 AND user_id = $2;

-- name: DeleteOrgMember :execrows
DELETE FROM org_members WHERE org_id = $1 AND user_id = $2;

-- name: FindOrgMemberRowByEmail :one
SELECT id FROM org_members WHERE org_id = $1 AND email = $2;

-- name: ListOrgInvitations :many
SELECT id, org_id, email, role, invited_by, status, accepted_at, created_at
FROM invitations WHERE org_id = $1
ORDER BY created_at DESC, id;

-- name: FindPendingInvitation :one
SELECT id FROM invitations
WHERE org_id = $1 AND email = $2 AND status = 'pending';

-- name: InsertInvitation :exec
INSERT INTO invitations (id, org_id, email, role, invited_by)
VALUES ($1, $2, $3, $4, $5);

-- name: RevokePendingInvitation :execrows
UPDATE invitations SET status = 'revoked'
WHERE id = $1 AND org_id = $2 AND status = 'pending';

-- ── Org roles CRUD ────────────────────────────────────────────────────

-- name: ListOrgRoles :many
SELECT id, org_id, name, inherits_from, description, is_builtin, granted_permissions
FROM org_roles WHERE org_id = $1
ORDER BY name;

-- name: InsertOrgRole :exec
INSERT INTO org_roles (id, org_id, name, inherits_from, description, is_builtin, granted_permissions)
VALUES ($1, $2, $3, $4, $5, $6, $7);

-- name: UpdateOrgRole :one
UPDATE org_roles
SET granted_permissions = COALESCE(sqlc.narg(granted_permissions), granted_permissions),
    description = COALESCE(sqlc.narg(description), description),
    inherits_from = COALESCE(sqlc.narg(inherits_from), inherits_from)
WHERE org_id = $1 AND name = $2
RETURNING id, org_id, name, inherits_from, description, is_builtin, granted_permissions;

-- name: DeleteOrgRole :execrows
DELETE FROM org_roles WHERE org_id = $1 AND name = $2;

-- name: CountMembersInRole :one
SELECT count(*)::int FROM org_members WHERE org_id = $1 AND role = $2;

-- Operator-facing audit-trail reader: org-scoped, optional action PREFIX
-- filter, `(created_at, id)` DESC keyset so history pages backward without
-- repeats or skips on shared timestamps. The caller over-fetches limit+1
-- to derive hasMore + the next cursor.
-- name: QueryAuditLogs :many
SELECT * FROM audit_logs
WHERE org_id = $1
  AND (sqlc.narg(action_prefix)::text IS NULL OR action LIKE sqlc.narg(action_prefix) || '%')
  AND (created_at < @before_created_at
       OR (created_at = @before_created_at AND id < @before_id))
ORDER BY created_at DESC, id DESC
LIMIT @page_limit;

-- Rate limiter: one O(1) UPSERT per request — the fixed window lives in
-- the PK, so a fresh window is an insert and a repeat hit an increment.
-- name: BumpRateWindow :one
INSERT INTO go_pilot_rate_windows (name, key, window_start, count, expires_at)
VALUES ($1, $2, $3, 1, $4)
ON CONFLICT (name, key, window_start)
DO UPDATE SET count = go_pilot_rate_windows.count + 1
RETURNING count;

-- name: CleanupExpiredRateWindows :execrows
DELETE FROM go_pilot_rate_windows WHERE expires_at < now();

-- Org-config rows for the layered catalog read. The closed catalog is
-- ~69 keys; the 200 cap guards a pathological row count, like the
-- reference's defensive limit.
-- name: ListOrgConfigRows :many
SELECT key, value_json, updated_at FROM org_configs WHERE org_id = $1 LIMIT 200;

-- name: UpsertOrgConfigValue :exec
INSERT INTO org_configs (id, org_id, key, value_json, category, description, value_type, updated_by, updated_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
ON CONFLICT (org_id, key)
DO UPDATE SET value_json = EXCLUDED.value_json, updated_by = EXCLUDED.updated_by, updated_at = now();

-- Per-org retention: the sweep resolves each org's catalog window and
-- purges with an org-scoped cutoff.
-- name: ListOrgsWithSoftDeletedWorkflows :many
SELECT DISTINCT org_id FROM workflows WHERE deleted_at IS NOT NULL;

-- name: PurgeExpiredSoftDeletedWorkflowsForOrg :one
WITH expired_workflows AS (
  SELECT w.id, w.org_id FROM workflows w
  WHERE w.org_id = sqlc.arg(target_org)::text AND w.deleted_at IS NOT NULL
    AND w.deleted_at <= sqlc.arg(cutoff)::timestamptz
),
deleted_versions AS (
  DELETE FROM workflow_versions
  WHERE (org_id, workflow_id) IN (SELECT org_id, id FROM expired_workflows)
  RETURNING 1
),
deleted_metadata AS (
  DELETE FROM workflow_metadata
  WHERE (org_id, workflow_id) IN (SELECT org_id, id FROM expired_workflows)
  RETURNING 1
),
deleted_workflows AS (
  DELETE FROM workflows WHERE id IN (SELECT id FROM expired_workflows)
  RETURNING 1
)
SELECT count(*) FROM deleted_workflows;

-- Batched per-org data retention (the reference's subquery+LIMIT shape):
-- each round-trip removes at most one batch, honoring per-row legal holds.
-- run_events scopes through the parent run (it has no org column).
-- name: DeleteExpiredRunEventsBatch :execrows
DELETE FROM run_events WHERE id IN (
  SELECT re.id FROM run_events re
  JOIN runs r ON r.id = re.run_id
  WHERE r.org_id = sqlc.arg(target_org)::text
    AND re.created_at < sqlc.arg(cutoff)::timestamptz
    AND (re.hold_until IS NULL OR re.hold_until <= now())
  LIMIT sqlc.arg(batch_size));

-- name: DeleteExpiredAuditLogsBatch :execrows
DELETE FROM audit_logs WHERE id IN (
  SELECT a.id FROM audit_logs a
  WHERE a.org_id = sqlc.arg(target_org)::text
    AND a.created_at < sqlc.arg(cutoff)::timestamptz
    AND (a.hold_until IS NULL OR a.hold_until <= now())
  LIMIT sqlc.arg(batch_size));

-- name: DeleteExpiredUsageEventsBatch :execrows
DELETE FROM usage_events WHERE id IN (
  SELECT u.id FROM usage_events u
  WHERE u.org_id = sqlc.arg(target_org)::text
    AND u.created_at < sqlc.arg(cutoff)::timestamptz
    AND (u.hold_until IS NULL OR u.hold_until <= now())
  LIMIT sqlc.arg(batch_size));

-- Orgs holding data old enough to POSSIBLY be expired — bounded by each
-- table's catalog FLOOR (run_events >= 7 days, audit/usage >= 30), so an
-- org with only fresh data never enters the sweep loop at all.
-- name: ListOrgsWithRetainableData :many
SELECT DISTINCT org_id FROM (
  SELECT r.org_id FROM runs r
  JOIN run_events re ON re.run_id = r.id
  WHERE re.created_at < now() - interval '7 days'
  UNION SELECT org_id FROM audit_logs WHERE created_at < now() - interval '30 days'
  UNION SELECT org_id FROM usage_events WHERE created_at < now() - interval '30 days'
) all_orgs;

-- One read for every org's retention windows — the sweep resolves the
-- layer chain in memory instead of one config query per org/table.
-- name: ListRetentionConfigRows :many
SELECT org_id, key, value_json FROM org_configs WHERE key LIKE 'retention.%';

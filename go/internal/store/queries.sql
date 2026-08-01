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
INSERT INTO workflow_versions (id, org_id, workflow_id, version, dag_json, created_by,
                               upstream_health_sources, slo_json)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8);

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
INSERT INTO runs (id, org_id, workflow_version_id, status, input_json, created_by, replay_mode, validation_evidence_level,
  parent_run_id, parent_node_id, parent_link_kind, workflow_rollout_id, workflow_rollout_variant)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13);

-- name: GetRun :one
SELECT id, org_id, workflow_version_id, status, input_json, output_json,
       parent_run_id, parent_node_id, replay_mode, created_by, created_at,
       outcome_status, semantic_violation_count, validation_evidence_level
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
SELECT status, org_id, input_json, replay_mode FROM runs WHERE id = $1;

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
UPDATE runs SET status = sqlc.arg(status), output_json = sqlc.arg(output_json),
    parent_notification_after = CASE
      WHEN parent_run_id IS NOT NULL AND parent_node_id IS NOT NULL
           AND (parent_link_kind = 'subworkflow'
                OR (parent_link_kind IS NULL AND replay_mode IS NULL))
      THEN now() ELSE parent_notification_after END
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
SET status = 'queued', attempts = 1
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
                            workflow_version_id, node_id, status, dedupe_key, payload_json,
                            workflow_rollout_id, workflow_rollout_variant)
VALUES ($1, $2, $3, $4, $5, $6, 'received', $7, $8, $9, $10)
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
-- Accepts 'received' (the ordinary ingest path) AND 'buffered' (the
-- breaker-resume backfill): both are "owed a run" states, and the CAS
-- keeps a concurrent backfill/relay from spawning a second run.
UPDATE trigger_events
SET status = 'started', run_id = $3, skipped_reason = NULL,
    backfill_claim_token = NULL, backfill_claimed_at = NULL
WHERE org_id = $1 AND id = $2 AND status IN ('received', 'buffered') AND run_id IS NULL;

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
-- The durable generation-bound facts are the ONLY source (T-137
-- reconciliation of T-055): a row exists only when a claimed replay
-- reached terminal success, so initiation can never inflate the metric;
-- validation replays are excluded via the run's replay_mode.
WITH recovered AS (
  SELECT ie.downtime_ended_ms::float8 AS duration_ms
  FROM recovery_impact_events ie
  JOIN runs r ON r.id = ie.run_id AND r.org_id = ie.org_id
  WHERE ie.org_id = $1 AND r.replay_mode IS NULL
    AND ie.recovered_at >= now() - make_interval(days => sqlc.arg(window_days)::int)
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

-- One LLM usage row per attempt (the telemetry chokepoint's writer).
-- name: InsertUsageEvent :exec
INSERT INTO usage_events (id, org_id, user_id, run_id, metric, quantity, metadata)
VALUES ($1, $2, $3, $4, $5, $6, $7);

-- Newest bounded usage slice for one run (the /run/usage read). The
-- explicit NULLS LAST matches the index order — created_at is
-- historically nullable even though new writes default it.
-- name: ListRunUsageSlice :many
SELECT metric, quantity, metadata FROM usage_events
WHERE org_id = $1 AND run_id = $2
ORDER BY created_at DESC NULLS LAST, id DESC NULLS LAST
LIMIT $3;

-- Operations LLM cost rollup: aggregate the COMPLETE rolling window in
-- Postgres, rank provider/model groups by operator value, and fold every
-- group past the first 100 into one explicit aggregated remainder — the
-- totals stay exact while the response cardinality stays bounded.
-- name: QueryCostByProvider :many
WITH grouped AS (
  SELECT
    CASE WHEN jsonb_typeof(metadata->'provider') = 'string'
      THEN metadata->>'provider' ELSE 'unknown' END AS provider,
    CASE WHEN jsonb_typeof(metadata->'model') = 'string'
      THEN metadata->>'model' ELSE 'unknown' END AS model,
    sum(CASE WHEN jsonb_typeof(metadata->'costUsd') = 'number'
      THEN greatest((metadata->>'costUsd')::double precision, 0) ELSE 0 END)::double precision AS usd,
    sum(greatest(quantity, 0))::double precision AS tokens,
    sum(CASE WHEN jsonb_typeof(metadata->'inputTokens') = 'number'
      THEN greatest((metadata->>'inputTokens')::double precision, 0) ELSE 0 END)::double precision AS input_tokens,
    sum(CASE WHEN jsonb_typeof(metadata->'cachedInputTokens') = 'number'
      THEN greatest((metadata->>'cachedInputTokens')::double precision, 0) ELSE 0 END)::double precision AS cached_input_tokens,
    sum(CASE WHEN jsonb_typeof(metadata->'cacheCreationInputTokens') = 'number'
      THEN greatest((metadata->>'cacheCreationInputTokens')::double precision, 0) ELSE 0 END)::double precision AS cache_creation_input_tokens,
    count(*)::double precision AS calls
  FROM usage_events
  WHERE org_id = sqlc.arg(target_org)::text
    AND metric = 'llm.completion'
    AND created_at >= sqlc.arg(since)::timestamptz
  GROUP BY 1, 2
), ranked AS (
  SELECT grouped.*, row_number() OVER (
    ORDER BY usd DESC, tokens DESC, provider, model) AS group_rank
  FROM grouped
), bucketed AS (
  SELECT
    CASE WHEN group_rank <= 100 THEN provider ELSE '__other__' END AS provider,
    CASE WHEN group_rank <= 100 THEN model ELSE '__other__' END AS model,
    group_rank > 100 AS aggregated,
    usd, tokens, input_tokens, cached_input_tokens, cache_creation_input_tokens, calls
  FROM ranked
)
SELECT
  provider, model,
  sum(usd)::double precision AS usd,
  sum(tokens)::double precision AS tokens,
  sum(input_tokens)::double precision AS input_tokens,
  sum(cached_input_tokens)::double precision AS cached_input_tokens,
  sum(cache_creation_input_tokens)::double precision AS cache_creation_input_tokens,
  sum(calls)::double precision AS calls,
  aggregated
FROM bucketed
GROUP BY aggregated, provider, model
ORDER BY aggregated, usd DESC, tokens DESC, provider, model;

-- Queue health over the Postgres substrate: waiting = queued nodes of
-- running runs whose wake-up (if any) has passed; active = running nodes.
-- The oldest age starts at ELIGIBILITY — the latest node.queued event or
-- the retry wake-at, whichever is later. A node with neither signal has
-- unknown age and is excluded (the analogue of the reference's BullMQ
-- retry/stalled-age caveat).
-- name: QueryQueueHealth :one
WITH eligible AS (
  SELECT rn.id, rn.run_id, rn.node_id
  FROM run_nodes rn
  JOIN runs r ON r.id = rn.run_id
  WHERE rn.status = 'queued' AND r.status = 'running'
    AND NOT EXISTS (
      SELECT 1 FROM go_pilot_wakeups w
      WHERE w.run_node_id = rn.id AND w.wake_at > now())
)
SELECT
  (SELECT count(*) FROM eligible)::int AS waiting,
  (SELECT count(*) FROM run_nodes WHERE status = 'running')::int AS active,
  (SELECT min(candidate) FROM (
     SELECT GREATEST(
       COALESCE((SELECT max(ev.created_at) FROM run_events ev
         WHERE ev.run_id = e.run_id AND ev.node_id = e.node_id
           AND ev.type = 'node.queued'), '-infinity'::timestamptz),
       COALESCE((SELECT w.wake_at FROM go_pilot_wakeups w
         WHERE w.run_node_id = e.id), '-infinity'::timestamptz)
     ) AS candidate FROM eligible e
   ) instants
   WHERE candidate > '-infinity'::timestamptz) AS oldest_eligible_at;

-- Workflow-scope operator guidance for AI prompt composition.
-- name: GetWorkflowAiGuidance :one
SELECT ai_guidance_markdown FROM workflow_metadata
WHERE org_id = $1 AND workflow_id = $2;

-- PromptOps registry: named prompts with immutable versions; the active
-- version is the pinned one or the latest published.
-- name: GetPromptByName :one
SELECT * FROM prompts WHERE org_id = $1 AND name = $2;

-- name: InsertPrompt :exec
INSERT INTO prompts (id, org_id, name, description, created_by)
VALUES ($1, $2, $3, $4, $5);

-- name: ListPrompts :many
SELECT * FROM prompts WHERE org_id = $1
ORDER BY created_at DESC, id DESC LIMIT $2;

-- name: NextPromptVersionNumber :one
SELECT COALESCE(max(version), 0) + 1 FROM prompt_versions
WHERE org_id = $1 AND prompt_id = $2;

-- name: InsertPromptVersion :exec
INSERT INTO prompt_versions (id, org_id, prompt_id, version, template_text, variables, created_by)
VALUES ($1, $2, $3, $4, $5, $6, $7);

-- name: GetLatestPublishedPromptVersion :one
SELECT * FROM prompt_versions
WHERE org_id = $1 AND prompt_id = $2 AND status = 'published'
ORDER BY version DESC LIMIT 1;

-- name: GetPromptVersionByID :one
SELECT * FROM prompt_versions WHERE org_id = $1 AND id = $2;

-- name: GetPromptVersionByNumber :one
SELECT * FROM prompt_versions
WHERE org_id = $1 AND prompt_id = $2 AND version = $3;

-- name: PinPromptVersion :execrows
UPDATE prompts SET pinned_version_id = $3, updated_at = now()
WHERE org_id = $1 AND id = $2;

-- name: GetPromptRowByID :one
SELECT * FROM prompts WHERE org_id = $1 AND id = $2;

-- name: GetMcpConnectionByAlias :one
SELECT * FROM mcp_connections WHERE org_id = $1 AND alias = $2;

-- name: InsertMcpConnection :exec
INSERT INTO mcp_connections (id, org_id, alias, transport, command, args, url, env_refs, enabled, status, created_by)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11);

-- name: GetMcpToolDescriptor :one
SELECT * FROM mcp_tool_descriptors WHERE connection_id = $1 AND name = $2;

-- name: UpsertMcpToolDescriptor :exec
INSERT INTO mcp_tool_descriptors (id, connection_id, name, description, input_schema, write_side, enabled, rate_limit_per_min)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
ON CONFLICT (connection_id, name) DO UPDATE SET
  description = EXCLUDED.description,
  input_schema = EXCLUDED.input_schema,
  updated_at = now();

-- name: ListMcpToolDescriptorsByConnection :many
SELECT * FROM mcp_tool_descriptors WHERE connection_id = $1 ORDER BY name LIMIT 200;

-- name: SetMcpConnectionStatus :exec
UPDATE mcp_connections
SET status = $3, status_reason = $4, last_discovery_at = $5, updated_at = now()
WHERE org_id = $1 AND id = $2;

-- name: ListExposedMcpToolsForAi :many
SELECT c.alias, d.name, d.description
FROM mcp_connections c
JOIN mcp_tool_descriptors d ON d.connection_id = c.id
WHERE c.org_id = $1 AND c.enabled = true AND c.expose_to_ai = true
  AND d.enabled = true AND d.expose_to_ai = true
ORDER BY c.alias, d.name;

-- name: UpdateMcpToolFlags :one
UPDATE mcp_tool_descriptors
SET enabled = $3, write_side = $4, rate_limit_per_min = $5, expose_to_ai = $6, updated_at = now()
WHERE connection_id = $1 AND name = $2
RETURNING *;

-- name: InsertRecoveryCase :exec
INSERT INTO recovery_cases (id, org_id, run_id, workflow_id, workflow_version_id, source,
  detector_id, source_node_id, detector_kind, action, message, details_json, state, created_by)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
ON CONFLICT (org_id, run_id, detector_id) DO NOTHING;

-- name: GetRecoveryCase :one
SELECT * FROM recovery_cases WHERE org_id = $1 AND id = $2;

-- name: ListRecoveryCases :many
SELECT * FROM recovery_cases
WHERE org_id = $1
  AND (sqlc.narg(run_id)::text IS NULL OR run_id = sqlc.narg(run_id))
  AND (NOT sqlc.arg(open_only)::boolean OR state NOT IN ('verified_recovered','recurred','accepted_loss','abandoned'))
ORDER BY created_at DESC, id DESC
LIMIT sqlc.arg(page_limit);

-- name: TransitionRecoveryCaseState :execrows
UPDATE recovery_cases
SET state = sqlc.arg(to_state), updated_at = now(),
    resolved_at = CASE WHEN sqlc.arg(terminal)::boolean THEN now() ELSE resolved_at END
WHERE org_id = $1 AND id = $2 AND state = sqlc.arg(from_state);

-- name: InsertRecoveryCaseTransition :execrows
INSERT INTO recovery_case_transitions (id, org_id, case_id, from_state, to_state, actor_kind, actor_id, evidence_json, reason, occurred_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
ON CONFLICT (case_id, to_state) DO NOTHING;

-- name: ListRecoveryCaseTransitions :many
SELECT * FROM recovery_case_transitions
WHERE org_id = $1 AND case_id = $2
ORDER BY occurred_at, id
LIMIT 100;

-- name: CountRunSemanticCases :one
SELECT count(*) AS total,
  count(*) FILTER (WHERE action = 'quarantine'
    AND state NOT IN ('verified_recovered','recurred','accepted_loss','abandoned')) AS open_quarantines
FROM recovery_cases WHERE org_id = $1 AND run_id = $2;

-- name: SetRunSemanticOutcome :exec
UPDATE runs SET
  status = CASE WHEN sqlc.arg(quarantine)::boolean THEN 'waiting' ELSE status END,
  outcome_status = sqlc.arg(outcome_status),
  semantic_violation_count = sqlc.arg(violation_count)
WHERE id = $1;

-- name: StampRedriveRecoveryClaim :exec
UPDATE run_nodes
SET recovery_dead_letter_id = $3, recovery_requested_by = $4, recovery_claim_token = $5,
    recovery_playbook_id = $6, recovery_validation_run_id = $7
WHERE run_id = $1 AND node_id = $2;

-- name: GetRunNodeRecoveryClaim :one
SELECT recovery_dead_letter_id, recovery_requested_by, recovery_claim_token,
       recovery_playbook_id, recovery_validation_run_id
FROM run_nodes WHERE run_id = $1 AND node_id = $2;

-- name: GetDeadLetterForImpact :one
SELECT d.org_id, d.created_at, d.replay_claimed_at, d.replayed_at, r.replay_mode
FROM dead_letters d
JOIN runs r ON r.id = d.run_id AND r.org_id = d.org_id
WHERE d.id = $1 AND d.run_id = $2 AND d.node_id = $3;

-- name: ConvergeDeadLetterReplayed :exec
UPDATE dead_letters SET status = 'replayed', replayed_at = sqlc.arg(recovered_at)
WHERE id = $1 AND org_id = $2 AND status = 'open';

-- name: InsertRecoveryImpactEvent :execrows
INSERT INTO recovery_impact_events (dead_letter_id, org_id, run_id, node_id, user_id, recovered_at, downtime_ended_ms)
VALUES ($1, $2, $3, $4, $5, $6, $7)
ON CONFLICT (dead_letter_id) DO NOTHING;

-- name: UpsertRecoveryImpactRollup :exec
INSERT INTO recovery_impact_rollups (org_id, total_recovered, downtime_ended_ms, first_recovered_at, updated_at)
VALUES ($1, 1, $2, sqlc.arg(recovered_at), sqlc.arg(recovered_at))
ON CONFLICT (org_id) DO UPDATE SET
  total_recovered = recovery_impact_rollups.total_recovered + 1,
  downtime_ended_ms = recovery_impact_rollups.downtime_ended_ms + EXCLUDED.downtime_ended_ms,
  first_recovered_at = LEAST(COALESCE(recovery_impact_rollups.first_recovered_at, EXCLUDED.first_recovered_at), EXCLUDED.first_recovered_at),
  updated_at = GREATEST(recovery_impact_rollups.updated_at, EXCLUDED.updated_at);

-- name: GetRecoveryImpactRollup :one
SELECT * FROM recovery_impact_rollups WHERE org_id = $1;

-- name: InsertRecoveryItem :execrows
INSERT INTO recovery_items (id, org_id, dead_letter_id, workflow_id, severity, status, sla_target_at, error_signature, created_by)
VALUES ($1, $2, $3, $4, $5, 'open', $6, $7, $8)
ON CONFLICT (org_id, dead_letter_id) DO NOTHING;

-- name: FindRecoveryItemForDeadLetter :one
SELECT id, status, resolution_reason FROM recovery_items
WHERE org_id = $1 AND dead_letter_id = $2
FOR UPDATE;

-- name: ResolveRecoveryItemFromTerminal :execrows
UPDATE recovery_items
SET status = 'resolved', resolution_reason = 'sandbox_replay_succeeded',
    resolved_by = sqlc.arg(actor), resolved_at = sqlc.arg(recovered_at),
    first_action_at = COALESCE(first_action_at, sqlc.arg(first_action_at)),
    updated_at = sqlc.arg(recovered_at)
WHERE org_id = $1 AND id = $2 AND status = sqlc.arg(from_status);

-- name: InsertAuditLogRow :exec
INSERT INTO audit_logs (id, org_id, user_id, action, target_type, target_id, metadata)
VALUES ($1, $2, $3, $4, $5, $6, $7);

-- name: CountRecentWorkflowRunStatuses :many
SELECT r.status FROM runs r
LEFT JOIN workflow_versions v ON v.id = r.workflow_version_id AND v.org_id = r.org_id
WHERE r.org_id = $1
  AND COALESCE(v.workflow_id, r.workflow_version_id) = sqlc.arg(workflow_id)
  AND r.replay_mode IS NULL
  AND r.status IN ('succeeded', 'failed')
ORDER BY r.created_at DESC
LIMIT sqlc.arg(page_limit);

-- name: GetWorkflowBreakerStatus :one
SELECT status FROM workflows
WHERE org_id = $1 AND id = $2 AND deleted_at IS NULL;

-- name: TripWorkflowCircuitBreaker :execrows
UPDATE workflows SET status = 'paused_circuit_breaker', paused_reason = sqlc.arg(reason)
WHERE org_id = $1 AND id = $2 AND status = 'active' AND deleted_at IS NULL;

-- name: ResumeWorkflowCircuitBreaker :execrows
UPDATE workflows SET status = 'active', paused_reason = NULL
WHERE org_id = $1 AND id = $2 AND status = 'paused_circuit_breaker' AND deleted_at IS NULL;

-- name: ClaimBufferedTriggerEvents :many
UPDATE trigger_events SET backfill_claim_token = sqlc.arg(claim_token), backfill_claimed_at = now()
WHERE trigger_events.id IN (
  SELECT te.id FROM trigger_events te
  WHERE te.org_id = sqlc.arg(org_id) AND te.workflow_id = sqlc.arg(workflow_id) AND te.status = 'buffered'
    AND te.backfill_claim_token IS NULL
  ORDER BY te.created_at ASC
  LIMIT sqlc.arg(page_limit)
  FOR UPDATE SKIP LOCKED
)
RETURNING trigger_events.id, trigger_events.node_id, trigger_events.payload_json, trigger_events.created_at,
          trigger_events.workflow_version_id, trigger_events.workflow_rollout_id, trigger_events.workflow_rollout_variant;

-- name: CountBufferedTriggerEvents :one
SELECT count(*) FROM trigger_events te
WHERE te.org_id = sqlc.arg(org_id) AND te.workflow_id = sqlc.arg(workflow_id) AND te.status = 'buffered'
  AND te.backfill_claim_token IS NULL;

-- name: GetRecoveryPlaybook :one
SELECT * FROM recovery_playbooks WHERE org_id = $1 AND id = $2;

-- name: FindMatchingActivePlaybook :one
SELECT * FROM recovery_playbooks
WHERE org_id = $1 AND workflow_id = $2 AND signature = $3 AND status = 'active';

-- name: FindPlaybookBySourceVersion :one
SELECT * FROM recovery_playbooks
WHERE org_id = $1 AND source_workflow_version_id = $2;

-- name: MaxPlaybookVersion :one
SELECT COALESCE(max(version), 0)::int FROM recovery_playbooks
WHERE org_id = $1 AND signature = $2;

-- name: InsertRecoveryPlaybookDraft :exec
INSERT INTO recovery_playbooks (id, org_id, workflow_id, signature, version, status, title,
  instructions_markdown, evidence_requirements_json, source_workflow_version_id, approach_label,
  last_validated_at, last_validation_run_id, created_by, updated_by)
VALUES ($1, $2, $3, $4, $5, 'draft', $6, $7, $8, $9, $10, now(), $11, $12, $12);

-- name: RetirePreviousActivePlaybookMatch :execrows
UPDATE recovery_playbooks
SET status = 'retired', retired_at = now(), updated_at = now(), updated_by = sqlc.arg(actor)
WHERE org_id = $1 AND workflow_id = $2 AND signature = $3 AND status = 'active' AND id <> sqlc.arg(exclude_id);

-- name: ActivateDraftPlaybook :execrows
UPDATE recovery_playbooks
SET status = 'active', activated_at = now(), retired_at = NULL, updated_at = now(), updated_by = sqlc.arg(actor)
WHERE org_id = $1 AND id = $2 AND status = 'draft';

-- name: RetireRecoveryPlaybook :execrows
UPDATE recovery_playbooks
SET status = 'retired', retired_at = now(), updated_at = now(), updated_by = sqlc.arg(actor)
WHERE org_id = $1 AND id = $2 AND status <> 'retired';

-- name: RecordPlaybookValidationSuccess :execrows
UPDATE recovery_playbooks
SET last_validated_at = now(), last_validation_run_id = sqlc.arg(validation_run_id), updated_at = now()
WHERE org_id = $1 AND id = $2 AND status <> 'retired';

-- name: RecordPlaybookValidationRegression :execrows
UPDATE recovery_playbooks
SET status = 'retired', retired_at = now(), regressions = regressions + 1, updated_at = now()
WHERE org_id = $1 AND id = $2 AND status <> 'retired';

-- name: RecordPlaybookApplied :execrows
UPDATE recovery_playbooks
SET successful_uses = successful_uses + 1,
    last_applied_validation_run_id = sqlc.arg(validation_run_id), updated_at = now()
WHERE org_id = $1 AND id = $2
  AND (last_applied_validation_run_id IS NULL OR last_applied_validation_run_id <> sqlc.arg(validation_run_id));


-- name: GetWorkflowVersionAnyWorkflow :one
SELECT id, org_id, workflow_id, version, dag_json FROM workflow_versions
WHERE id = $1 AND org_id = $2;

-- name: ListDrillRootDeadLetters :many
SELECT id FROM dead_letters
WHERE org_id = $1 AND replay_claimed_at IS NOT NULL
ORDER BY created_at DESC LIMIT 50;

-- name: InsertRecoveryFeedback :exec
INSERT INTO recovery_feedback (id, org_id, user_id, dead_letter_id, workflow_id,
  suggestion_mode, approach_label, accepted, raw_confidence, comment, eval_consent)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11);

-- name: ListCalibrationSamples :many
SELECT raw_confidence, accepted FROM recovery_feedback
WHERE org_id = $1 AND approach_label = $2 AND raw_confidence IS NOT NULL
  AND created_at >= now() - make_interval(days => sqlc.arg(window_days)::int)
ORDER BY created_at ASC
LIMIT 5000;

-- name: ListCalibratableApproaches :many
SELECT DISTINCT approach_label FROM recovery_feedback
WHERE org_id = $1 AND raw_confidence IS NOT NULL
  AND created_at >= now() - make_interval(days => sqlc.arg(window_days)::int);

-- name: UpsertConfidenceCalibration :exec
INSERT INTO confidence_calibrations (id, org_id, approach_label, accept_rate, sample_size, curve_slope, curve_intercept, last_computed_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, now())
ON CONFLICT (org_id, approach_label) DO UPDATE SET
  accept_rate = EXCLUDED.accept_rate, sample_size = EXCLUDED.sample_size,
  curve_slope = EXCLUDED.curve_slope, curve_intercept = EXCLUDED.curve_intercept,
  last_computed_at = now();

-- name: ListConfidenceCalibrations :many
SELECT * FROM confidence_calibrations WHERE org_id = $1 ORDER BY approach_label;

-- name: ListOrgsWithFeedback :many
SELECT DISTINCT org_id FROM recovery_feedback
WHERE created_at >= now() - make_interval(days => sqlc.arg(window_days)::int)
LIMIT 500;

-- name: ListRecoveryItems :many
SELECT * FROM recovery_items WHERE org_id = $1
ORDER BY created_at DESC, id DESC LIMIT 100;

-- name: GetRecoveryItemByID :one
SELECT * FROM recovery_items WHERE org_id = $1 AND id = $2;

-- name: TransitionRecoveryItem :execrows
UPDATE recovery_items
SET status = sqlc.arg(to_status),
    owner = COALESCE(sqlc.narg(new_owner), owner),
    severity = COALESCE(sqlc.narg(new_severity), severity),
    resolution_reason = CASE WHEN sqlc.arg(to_status) = 'resolved' THEN sqlc.narg(resolution_reason) ELSE resolution_reason END,
    resolved_by = CASE WHEN sqlc.arg(to_status) = 'resolved' THEN sqlc.narg(actor) ELSE resolved_by END,
    resolved_at = CASE WHEN sqlc.arg(to_status) = 'resolved' THEN now() ELSE resolved_at END,
    first_action_at = COALESCE(first_action_at, now()),
    updated_at = now()
WHERE org_id = $1 AND id = $2 AND status = ANY(sqlc.arg(from_statuses)::text[]);

-- name: AppendRecoveryItemComment :execrows
UPDATE recovery_items
SET comments = comments || sqlc.arg(comment)::jsonb, updated_at = now()
WHERE org_id = $1 AND id = $2 AND jsonb_array_length(comments) < 200;

-- name: UpsertRecoveryItemHandoff :one
INSERT INTO recovery_item_handoffs (id, org_id, recovery_item_id, destination, credential_name,
  idempotency_key, last_outcome, last_error, created_by)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
ON CONFLICT (org_id, recovery_item_id, destination) DO UPDATE SET
  dispatch_count = recovery_item_handoffs.dispatch_count + 1,
  last_outcome = EXCLUDED.last_outcome, last_error = EXCLUDED.last_error,
  last_dispatched_at = now()
RETURNING *;

-- name: ListRecoveryItemHandoffs :many
SELECT * FROM recovery_item_handoffs
WHERE org_id = $1 AND recovery_item_id = $2
ORDER BY first_dispatched_at DESC LIMIT 50;

-- name: ListOpenDeadLetterClusterMembers :many
SELECT dl.id, dl.run_id, dl.node_id, dl.error_json, dl.created_at, r.input_json
FROM dead_letters dl
JOIN runs r ON r.id = dl.run_id
WHERE dl.org_id = $1 AND dl.created_at >= $2 AND dl.status = 'open'
ORDER BY dl.created_at DESC
LIMIT 500;

-- name: MarkDeadLetterResolved :execrows
UPDATE dead_letters SET status = 'resolved' WHERE org_id = $1 AND id = $2;

-- name: GetRecoveryItemForDeadLetter :one
SELECT id, status FROM recovery_items WHERE org_id = $1 AND dead_letter_id = $2;

-- name: UpdateRunWorkflowSnapshot :exec
UPDATE runs SET input_json = jsonb_set(input_json, '{workflow}', sqlc.arg(workflow)::jsonb)
WHERE id = $1;

-- name: QueryRecurredClusterSignatures :many
WITH recovered_items AS (
  SELECT item.id AS item_id, item.error_signature, min(impact.recovered_at) AS recovered_at
  FROM recovery_impact_events impact
  JOIN runs impact_run ON impact_run.id = impact.run_id AND impact_run.org_id = impact.org_id
  JOIN recovery_items item ON item.org_id = impact.org_id AND item.dead_letter_id = impact.dead_letter_id
  WHERE impact.org_id = $1 AND impact.recovered_at >= $2 AND impact_run.replay_mode IS NULL
    AND item.error_signature IS NOT NULL
  GROUP BY item.id, item.error_signature
)
SELECT DISTINCT recovered.error_signature::text AS signature
FROM recovered_items recovered
WHERE EXISTS (
  SELECT 1 FROM recovery_items later_item
  JOIN dead_letters later_dlq ON later_dlq.org_id = later_item.org_id AND later_dlq.id = later_item.dead_letter_id
  JOIN runs later_run ON later_run.id = later_dlq.run_id AND later_run.org_id = later_item.org_id
  WHERE later_item.org_id = $1 AND later_item.id <> recovered.item_id
    AND later_item.error_signature = recovered.error_signature
    AND later_item.first_occurred_at > recovered.recovered_at
    AND later_item.first_occurred_at <= recovered.recovered_at + interval '7 days'
    AND later_run.replay_mode IS NULL
);

-- name: QueryRecoveryHeatmap :many
SELECT to_char(date_trunc('day', dl.created_at), 'YYYY-MM-DD')::text AS day,
       count(*)::int AS failures,
       count(impact.dead_letter_id)::int AS recovered,
       (coalesce(percentile_cont(0.5) WITHIN GROUP (ORDER BY impact.downtime_ended_ms), 0) / 1000)::float8 AS mttr_seconds
FROM dead_letters dl
JOIN runs r ON r.id = dl.run_id AND r.org_id = dl.org_id
LEFT JOIN recovery_impact_events impact ON impact.dead_letter_id = dl.id AND impact.org_id = dl.org_id
WHERE dl.org_id = $1 AND dl.created_at >= $2 AND r.replay_mode IS NULL
GROUP BY date_trunc('day', dl.created_at)
ORDER BY date_trunc('day', dl.created_at) ASC
LIMIT 90;

-- name: QueryOperatorRecoveryCount :one
SELECT count(*)::int AS recovered
FROM recovery_impact_events impact
JOIN runs r ON r.id = impact.run_id AND r.org_id = impact.org_id
WHERE impact.org_id = $1 AND impact.user_id = $2
  AND impact.recovered_at >= $3 AND r.replay_mode IS NULL;

-- name: ListAlertPolicies :many
SELECT * FROM alert_policies WHERE org_id = $1 ORDER BY created_at DESC, id DESC LIMIT 200;

-- name: ListEnabledAlertPolicies :many
SELECT * FROM alert_policies WHERE org_id = $1 AND trigger = $2 AND enabled ORDER BY created_at ASC LIMIT 100;

-- name: GetAlertPolicy :one
SELECT * FROM alert_policies WHERE org_id = $1 AND id = $2;

-- name: InsertAlertPolicy :exec
INSERT INTO alert_policies (id, org_id, name, trigger, parameters, channels, cooldown_seconds, enabled, created_by)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9);

-- name: UpdateAlertPolicy :execrows
UPDATE alert_policies
SET name = COALESCE(sqlc.narg(new_name), name),
    parameters = COALESCE(sqlc.narg(new_parameters), parameters),
    channels = COALESCE(sqlc.narg(new_channels), channels),
    cooldown_seconds = COALESCE(sqlc.narg(new_cooldown_seconds), cooldown_seconds),
    enabled = COALESCE(sqlc.narg(new_enabled), enabled),
    updated_at = now()
WHERE org_id = $1 AND id = $2;

-- name: DeleteAlertPolicy :execrows
DELETE FROM alert_policies WHERE org_id = $1 AND id = $2;

-- name: CountRecentAlertDispatches :one
SELECT count(*) FROM alert_dispatches
WHERE org_id = $1 AND policy_id = $2 AND dedupe_key = $3 AND dispatched_at >= $4;

-- name: InsertAlertDispatch :exec
INSERT INTO alert_dispatches (id, org_id, policy_id, dedupe_key, outcome, channel_results, trigger_payload)
VALUES ($1, $2, $3, $4, $5, $6, $7);

-- name: ListRecentAlertDispatches :many
SELECT * FROM alert_dispatches
WHERE org_id = $1 AND (sqlc.narg(cursor)::timestamptz IS NULL OR dispatched_at < sqlc.narg(cursor))
ORDER BY dispatched_at DESC, id DESC
LIMIT sqlc.arg(page_limit);

-- name: FindLatestDeadLetterForNode :one
SELECT id, node_id, node_json, error_json FROM dead_letters
WHERE org_id = $1 AND run_id = $2 AND node_id = $3
ORDER BY created_at DESC, id DESC LIMIT 1;

-- name: FindLatestPatchAuditForRun :one
SELECT created_at, metadata FROM audit_logs
WHERE org_id = $1 AND action = 'ai.workflow.patch_suggested'
  AND (metadata ->> 'runId' = sqlc.arg(run_id)::text OR target_id = sqlc.arg(run_id)::text)
ORDER BY created_at DESC LIMIT 1;

-- name: FindLatestValidationRunForParent :one
SELECT id, status, validation_evidence_level, created_at FROM runs
WHERE org_id = $1 AND parent_run_id = $2 AND replay_mode = 'validation'
ORDER BY created_at DESC, id DESC LIMIT 1;

-- name: ListAuditRowsForTargets :many
SELECT id, action, target_type, target_id, user_id, created_at FROM audit_logs
WHERE org_id = $1 AND target_id = ANY(sqlc.arg(target_ids)::text[])
ORDER BY created_at DESC, id DESC LIMIT 50;

-- name: QueryTimeToFirstAction :one
WITH samples AS (
  SELECT extract(epoch FROM (item.first_action_at - item.created_at))::float8 AS seconds
  FROM recovery_items item
  JOIN dead_letters item_dlq ON item_dlq.org_id = item.org_id AND item_dlq.id = item.dead_letter_id
  JOIN runs item_run ON item_run.org_id = item.org_id AND item_run.id = item_dlq.run_id
  WHERE item.org_id = $1 AND item.created_at >= $2
    AND item.first_action_at IS NOT NULL AND item_run.replay_mode IS NULL
  UNION ALL
  SELECT extract(epoch FROM (coalesce(dlq.replay_claimed_at, dlq.replayed_at) - dlq.created_at))::float8 AS seconds
  FROM dead_letters dlq
  JOIN runs fallback_run ON fallback_run.org_id = dlq.org_id AND fallback_run.id = dlq.run_id
  WHERE dlq.org_id = $1 AND dlq.created_at >= $2
    AND coalesce(dlq.replay_claimed_at, dlq.replayed_at) IS NOT NULL
    AND fallback_run.replay_mode IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM recovery_items item WHERE item.org_id = $1 AND item.dead_letter_id = dlq.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM recovery_item_children child WHERE child.org_id = $1 AND child.dead_letter_id = dlq.id
    )
)
SELECT count(*) FILTER (WHERE seconds >= 0)::int AS sample_size,
       coalesce(avg(seconds) FILTER (WHERE seconds >= 0), -1)::float8 AS avg_seconds,
       coalesce(percentile_disc(0.95) WITHIN GROUP (ORDER BY seconds)
         FILTER (WHERE seconds >= 0), -1)::float8 AS p95_seconds
FROM samples;

-- name: QueryRecoveryRecurrence :one
WITH recovered_items AS (
  SELECT item.id AS item_id, item.error_signature, min(impact.recovered_at) AS recovered_at
  FROM recovery_impact_events impact
  JOIN runs impact_run ON impact_run.id = impact.run_id AND impact_run.org_id = impact.org_id
  JOIN recovery_items item ON item.org_id = impact.org_id AND item.dead_letter_id = impact.dead_letter_id
  WHERE impact.org_id = $1 AND impact.recovered_at >= $2 AND impact_run.replay_mode IS NULL
    AND item.error_signature IS NOT NULL
  GROUP BY item.id, item.error_signature
), evaluated AS (
  SELECT recovered.item_id,
    (EXISTS (
      SELECT 1 FROM recovery_items later_item
      JOIN dead_letters later_dlq ON later_dlq.org_id = later_item.org_id AND later_dlq.id = later_item.dead_letter_id
      JOIN runs later_run ON later_run.id = later_dlq.run_id AND later_run.org_id = later_item.org_id
      WHERE later_item.org_id = $1 AND later_item.id <> recovered.item_id
        AND later_item.error_signature = recovered.error_signature
        AND later_item.first_occurred_at > recovered.recovered_at
        AND later_item.first_occurred_at <= recovered.recovered_at + interval '7 days'
        AND later_run.replay_mode IS NULL
    ) OR EXISTS (
      SELECT 1 FROM recovery_item_children later_child
      JOIN dead_letters later_dlq ON later_dlq.org_id = later_child.org_id AND later_dlq.id = later_child.dead_letter_id
      JOIN runs later_run ON later_run.id = later_dlq.run_id AND later_run.org_id = later_child.org_id
      WHERE later_child.org_id = $1 AND later_child.recovery_item_id = recovered.item_id
        AND later_child.occurred_at > recovered.recovered_at
        AND later_child.occurred_at <= recovered.recovered_at + interval '7 days'
        AND later_run.replay_mode IS NULL
    )) AS recurred
  FROM recovered_items recovered
)
SELECT count(*)::int AS resolved, count(*) FILTER (WHERE recurred)::int AS recurred FROM evaluated;

-- name: LockWorkflowForRollout :one
SELECT id FROM workflows WHERE org_id = $1 AND id = $2 AND deleted_at IS NULL FOR UPDATE;

-- name: ListWorkflowVersionsForRollout :many
SELECT id, version, dag_json FROM workflow_versions
WHERE org_id = $1 AND workflow_id = $2 ORDER BY version DESC LIMIT 200;

-- name: FindActiveWorkflowRollout :one
SELECT id FROM workflow_rollouts WHERE org_id = $1 AND workflow_id = $2 AND status = 'active' LIMIT 1;

-- name: InsertWorkflowRollout :one
INSERT INTO workflow_rollouts (id, org_id, workflow_id, baseline_version_id, canary_version_id,
  traffic_percent, minimum_sample_size, minimum_success_rate_percent, created_by)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
RETURNING *;

-- name: GetLatestWorkflowRolloutRow :one
SELECT wr.* FROM workflow_rollouts wr
JOIN workflows w ON w.id = wr.workflow_id AND w.org_id = wr.org_id
WHERE wr.org_id = $1 AND wr.workflow_id = $2 AND w.deleted_at IS NULL
ORDER BY CASE WHEN wr.status = 'active' THEN 0 ELSE 1 END, wr.created_at DESC, wr.id DESC
LIMIT 1;

-- name: GetWorkflowRolloutRow :one
SELECT * FROM workflow_rollouts WHERE id = $1 AND org_id = $2 AND workflow_id = $3;

-- name: FinishWorkflowRolloutCAS :one
UPDATE workflow_rollouts
SET status = sqlc.arg(new_status),
    rolled_back_reason = CASE WHEN sqlc.arg(new_status) = 'rolled_back' THEN sqlc.narg(reason) ELSE NULL END,
    ended_at = now(), updated_at = now()
WHERE id = $1 AND org_id = $2 AND workflow_id = $3 AND status = 'active'
RETURNING *;

-- name: FindPassedRecoveryQualification :one
SELECT id FROM workflow_recovery_qualifications
WHERE org_id = $1 AND workflow_id = $2 AND baseline_version_id = $3
  AND candidate_version_id = $4 AND dataset_version = $5 AND status = 'passed'
LIMIT 1;

-- name: CancelActiveWorkflowRollout :execrows
UPDATE workflow_rollouts
SET status = 'cancelled', rolled_back_reason = sqlc.arg(reason),
    ended_at = now(), updated_at = now()
WHERE org_id = $1 AND workflow_id = $2 AND status = 'active';

-- name: UpsertWorkflowRecoveryQualification :one
INSERT INTO workflow_recovery_qualifications (id, org_id, workflow_id, baseline_version_id,
  candidate_version_id, dataset_version, dataset_digest, mode, status, summary_json, created_by)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
ON CONFLICT (org_id, workflow_id, baseline_version_id, candidate_version_id, dataset_version, dataset_digest)
DO UPDATE SET mode = EXCLUDED.mode, status = EXCLUDED.status,
  summary_json = EXCLUDED.summary_json, created_at = now()
RETURNING *;

-- name: FindWorkflowRecoveryQualification :one
SELECT * FROM workflow_recovery_qualifications
WHERE org_id = $1 AND workflow_id = $2 AND baseline_version_id = $3
  AND candidate_version_id = $4 AND dataset_version = $5
ORDER BY created_at DESC, id DESC LIMIT 1;

-- name: GetRunForRolloutOutcome :one
SELECT org_id, status, replay_mode, workflow_rollout_id, workflow_rollout_variant, workflow_version_id
FROM runs WHERE id = $1;

-- name: GetActiveRolloutForOutcome :one
SELECT * FROM workflow_rollouts WHERE id = $1 AND org_id = $2 AND status = 'active';

-- name: InsertWorkflowRolloutOutcome :execrows
INSERT INTO workflow_rollout_outcomes (run_id, org_id, rollout_id, workflow_id, variant, status)
VALUES ($1, $2, $3, $4, $5, $6)
ON CONFLICT (run_id) DO NOTHING;

-- name: IncrementRolloutCounters :one
UPDATE workflow_rollouts SET
  baseline_succeeded = baseline_succeeded + sqlc.arg(baseline_succeeded_inc),
  baseline_failed = baseline_failed + sqlc.arg(baseline_failed_inc),
  canary_succeeded = canary_succeeded + sqlc.arg(canary_succeeded_inc),
  canary_failed = canary_failed + sqlc.arg(canary_failed_inc),
  last_outcome_at = now(), updated_at = now()
WHERE id = $1 AND status = 'active'
RETURNING *;

-- name: AutoRollbackRollout :one
UPDATE workflow_rollouts
SET status = 'rolled_back', rolled_back_reason = sqlc.arg(reason), ended_at = now(), updated_at = now()
WHERE id = $1 AND status = 'active'
RETURNING *;

-- name: ListUnrecordedRolloutOutcomes :many
SELECT r.id AS run_id, r.status FROM runs r
JOIN workflow_rollouts wr ON wr.id = r.workflow_rollout_id AND wr.org_id = r.org_id AND wr.status = 'active'
LEFT JOIN workflow_rollout_outcomes o ON o.run_id = r.id
WHERE r.workflow_rollout_id IS NOT NULL AND r.replay_mode IS NULL
  AND r.status IN ('succeeded','failed','cancelled') AND o.run_id IS NULL
ORDER BY r.created_at ASC, r.id ASC
LIMIT sqlc.arg(page_limit);

-- name: NextCredentialSecretVersion :one
SELECT (coalesce(max(version), 0) + 1)::int AS next_version
FROM credential_secret_versions
WHERE org_id = $1 AND credential_id = $2;

-- name: InsertCredentialSecretVersion :exec
INSERT INTO credential_secret_versions (id, org_id, credential_id, version, ciphertext,
  data_nonce, data_tag, wrapped_key, wrap_nonce, wrap_tag, key_version, created_by)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12);

-- name: GetCredentialSecretVersion :one
SELECT id, org_id, credential_id, version, ciphertext, data_nonce, data_tag,
       wrapped_key, wrap_nonce, wrap_tag, key_version
FROM credential_secret_versions
WHERE id = $1 AND org_id = $2 AND revoked_at IS NULL;

-- name: RevokeCredentialSecretVersion :exec
UPDATE credential_secret_versions SET revoked_at = now()
WHERE id = $1 AND org_id = $2 AND revoked_at IS NULL;

-- name: GetCredentialByName :one
SELECT * FROM credentials WHERE org_id = $1 AND kind = $2 AND name = $3;

-- name: InsertCredential :exec
INSERT INTO credentials (id, org_id, name, kind, secret_ref, created_by)
VALUES ($1, $2, $3, $4, $5, $6);

-- name: UpdateCredentialSecretRef :exec
UPDATE credentials SET secret_ref = sqlc.arg(secret_ref), updated_at = now()
WHERE org_id = $1 AND id = $2;

-- name: ListCredentials :many
SELECT id, org_id, name, kind, secret_ref, metadata, created_by, created_at, updated_at, expires_at
FROM credentials WHERE org_id = $1 ORDER BY name LIMIT 500;

-- name: GetCredentialByOrgName :one
SELECT id, org_id, name, kind, secret_ref, updated_at, expires_at
FROM credentials WHERE org_id = $1 AND name = $2;

-- name: LockCredentialByName :one
SELECT id, kind, secret_ref, updated_at FROM credentials
WHERE org_id = $1 AND name = $2 FOR UPDATE;

-- name: RotateCredentialSecretRefCAS :one
UPDATE credentials SET secret_ref = sqlc.arg(new_secret_ref), updated_at = now()
WHERE org_id = $1 AND name = $2 AND updated_at = sqlc.arg(if_match)
RETURNING updated_at;

-- name: DeleteCredential :execrows
DELETE FROM credentials WHERE org_id = $1 AND id = $2;

-- name: SetCredentialExpiry :one
UPDATE credentials SET expires_at = sqlc.narg(expires_at), updated_at = now()
WHERE org_id = $1 AND name = $2
  AND (sqlc.narg(if_match)::timestamptz IS NULL OR updated_at = sqlc.narg(if_match))
RETURNING updated_at;

-- name: ListLatestWorkflowVersionDags :many
SELECT DISTINCT ON (wv.workflow_id) wv.workflow_id, wv.dag_json
FROM workflow_versions wv
JOIN workflows w ON w.id = wv.workflow_id AND w.org_id = wv.org_id
WHERE wv.org_id = $1 AND w.deleted_at IS NULL
ORDER BY wv.workflow_id, wv.version DESC
LIMIT 1000;

-- name: ListCredentialUsageRows :many
SELECT metadata ->> 'credentialName' AS credential_name, created_at,
       coalesce((metadata ->> 'ok')::bool, true) AS ok, metadata ->> 'error' AS error_message
FROM usage_events
WHERE org_id = $1 AND created_at >= $2
  AND metric LIKE 'tool.%' AND metadata ? 'credentialName'
ORDER BY created_at DESC
LIMIT 10000;

-- name: ListMcpConnectionsForHealth :many
SELECT id, alias, transport, env_refs, enabled, status FROM mcp_connections
WHERE org_id = $1 ORDER BY alias LIMIT 200;

-- name: InsertCredentialFull :exec
INSERT INTO credentials (id, org_id, name, kind, secret_ref, metadata, expires_at, created_by)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8);

-- name: InsertSlackInteractionConnection :exec
INSERT INTO slack_interaction_connections (id, org_id, name, team_id, signing_credential_name,
  user_mappings, enabled, created_by)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8);

-- name: ListSlackInteractionConnections :many
SELECT * FROM slack_interaction_connections WHERE org_id = $1 ORDER BY name LIMIT 100;

-- name: GetSlackInteractionConnection :one
SELECT * FROM slack_interaction_connections WHERE org_id = $1 AND id = $2;

-- name: GetSlackInteractionConnectionForCallback :one
SELECT * FROM slack_interaction_connections WHERE id = $1;

-- name: UpdateSlackInteractionConnection :execrows
UPDATE slack_interaction_connections
SET name = $3, team_id = $4, signing_credential_name = $5, user_mappings = $6,
    enabled = $7, updated_at = now()
WHERE org_id = $1 AND id = $2;

-- name: DeleteSlackInteractionConnection :execrows
DELETE FROM slack_interaction_connections WHERE org_id = $1 AND id = $2;

-- name: PurgeExpiredSlackReceipts :exec
DELETE FROM slack_interaction_receipts
WHERE org_id = $1 AND connection_id = $2 AND created_at < $3;

-- name: InsertSlackInteractionReceipt :execrows
INSERT INTO slack_interaction_receipts (id, org_id, connection_id)
VALUES ($1, $2, $3)
ON CONFLICT (id) DO NOTHING;

-- name: InsertExternalRuntimeConnection :one
INSERT INTO external_runtime_connections (id, org_id, name, runtime_key,
                                          signing_credential_name, enabled, created_by)
VALUES ($1, $2, $3, $4, $5, $6, $7)
RETURNING *;

-- name: ListExternalRuntimeConnections :many
SELECT * FROM external_runtime_connections
WHERE org_id = $1
ORDER BY name ASC
LIMIT 100;

-- name: GetExternalRuntimeConnection :one
SELECT * FROM external_runtime_connections
WHERE org_id = $1 AND id = $2;

-- name: GetExternalRuntimeConnectionForCallback :one
SELECT * FROM external_runtime_connections
WHERE id = $1;

-- name: UpdateExternalRuntimeConnection :one
UPDATE external_runtime_connections
SET name = $3, runtime_key = $4, signing_credential_name = $5, enabled = $6,
    updated_at = now()
WHERE org_id = $1 AND id = $2
RETURNING *;

-- name: DeleteExternalRuntimeConnection :one
DELETE FROM external_runtime_connections
WHERE org_id = $1 AND id = $2
RETURNING *;

-- name: GetActiveExternalRuntimeConnection :one
SELECT id FROM external_runtime_connections
WHERE id = $1 AND org_id = $2 AND enabled = true;

-- name: InsertExternalRuntimeEventReceipt :execrows
INSERT INTO external_runtime_events (id, org_id, connection_id, event_id, source,
                                     event_type, subject, event_time, sequence,
                                     payload_json, projection_state, received_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', $11)
ON CONFLICT (connection_id, source, event_id) DO NOTHING;

-- name: GetExternalRuntimeEventReceipt :one
SELECT * FROM external_runtime_events
WHERE connection_id = $1 AND source = $2 AND event_id = $3;

-- name: SetExternalRuntimeEventProjectionState :exec
UPDATE external_runtime_events SET projection_state = $2 WHERE id = $1;

-- name: UpsertExternalWorkflowPlaceholder :exec
INSERT INTO external_workflows (id, org_id, connection_id, external_workflow_id,
                                name, evidence_json, last_sequence)
VALUES ($1, $2, $3, $4, $4, '[]'::jsonb, -1)
ON CONFLICT (connection_id, external_workflow_id) DO NOTHING;

-- name: UpsertExternalRunPlaceholder :exec
INSERT INTO external_runs (id, org_id, connection_id, external_workflow_id,
                           external_run_id, status, evidence_json, last_sequence)
VALUES ($1, $2, $3, $4, $5, 'unknown', '[]'::jsonb, -1)
ON CONFLICT (connection_id, external_run_id) DO NOTHING;

-- name: UpsertExternalWorkflowObservation :execrows
INSERT INTO external_workflows (id, org_id, connection_id, external_workflow_id,
                                name, version, snapshot_json, evidence_json,
                                last_sequence, last_event_id, last_observed_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
ON CONFLICT (connection_id, external_workflow_id) DO UPDATE SET
  name = excluded.name, version = excluded.version,
  snapshot_json = excluded.snapshot_json, evidence_json = excluded.evidence_json,
  last_sequence = excluded.last_sequence, last_event_id = excluded.last_event_id,
  last_observed_at = excluded.last_observed_at, updated_at = now()
WHERE external_workflows.last_sequence < excluded.last_sequence;

-- name: UpsertExternalRunObservation :execrows
INSERT INTO external_runs (id, org_id, connection_id, external_workflow_id,
                           external_run_id, status, started_at, completed_at,
                           snapshot_json, evidence_json, last_sequence,
                           last_event_id, last_observed_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
ON CONFLICT (connection_id, external_run_id) DO UPDATE SET
  external_workflow_id = excluded.external_workflow_id, status = excluded.status,
  started_at = excluded.started_at, completed_at = excluded.completed_at,
  snapshot_json = excluded.snapshot_json, evidence_json = excluded.evidence_json,
  last_sequence = excluded.last_sequence, last_event_id = excluded.last_event_id,
  last_observed_at = excluded.last_observed_at, updated_at = now()
WHERE external_runs.last_sequence < excluded.last_sequence;

-- name: UpsertExternalStepObservation :execrows
INSERT INTO external_run_steps (id, org_id, connection_id, external_workflow_id,
                                external_run_id, external_step_id, name, status,
                                attempt, started_at, completed_at, snapshot_json,
                                evidence_json, last_sequence, last_event_id,
                                last_observed_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
ON CONFLICT (connection_id, external_run_id, external_step_id) DO UPDATE SET
  external_workflow_id = excluded.external_workflow_id, name = excluded.name,
  status = excluded.status, attempt = excluded.attempt,
  started_at = excluded.started_at, completed_at = excluded.completed_at,
  snapshot_json = excluded.snapshot_json, evidence_json = excluded.evidence_json,
  last_sequence = excluded.last_sequence, last_event_id = excluded.last_event_id,
  last_observed_at = excluded.last_observed_at, updated_at = now()
WHERE external_run_steps.last_sequence < excluded.last_sequence;

-- name: UpsertExternalRecoveryCaseDetected :exec
INSERT INTO external_recovery_cases (id, org_id, connection_id, subject_key,
                                     subject_kind, external_workflow_id,
                                     external_run_id, external_step_id, state,
                                     failure_snapshot_json, evidence_json,
                                     first_detected_at, last_observed_at,
                                     observed_recovered_at, last_sequence,
                                     last_event_id)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'detected', $9, $10, $11, $11, NULL, $12, $13)
ON CONFLICT (connection_id, subject_key) DO UPDATE SET
  state = 'detected', failure_snapshot_json = excluded.failure_snapshot_json,
  evidence_json = excluded.evidence_json, last_observed_at = excluded.last_observed_at,
  observed_recovered_at = NULL, last_sequence = excluded.last_sequence,
  last_event_id = excluded.last_event_id, updated_at = now()
WHERE external_recovery_cases.last_sequence < excluded.last_sequence;

-- name: MarkExternalRecoveryCaseRecovered :exec
UPDATE external_recovery_cases
SET state = 'observed_recovered', evidence_json = $5, last_observed_at = $6,
    observed_recovered_at = $6, last_sequence = $4, last_event_id = $7,
    updated_at = now()
WHERE org_id = $1 AND connection_id = $2 AND subject_key = $3 AND last_sequence < $4;

-- name: ListExternalWorkflows :many
SELECT * FROM external_workflows
WHERE org_id = $1
ORDER BY last_observed_at DESC NULLS LAST, external_workflow_id ASC
LIMIT 100;

-- name: ListExternalRuns :many
SELECT * FROM external_runs
WHERE org_id = $1
ORDER BY last_observed_at DESC NULLS LAST, created_at DESC
LIMIT 100;

-- name: ListExternalRunSteps :many
SELECT * FROM external_run_steps
WHERE org_id = $1
ORDER BY last_observed_at DESC NULLS LAST, created_at DESC
LIMIT 200;

-- name: ListExternalRecoveryCases :many
SELECT * FROM external_recovery_cases
WHERE org_id = $1
ORDER BY CASE WHEN state = 'detected' THEN 0 ELSE 1 END, last_observed_at DESC
LIMIT 200;

-- name: InsertUpstreamHealthSource :one
INSERT INTO upstream_health_sources (id, org_id, name, kind, url,
                                     expected_components, check_interval_seconds,
                                     enabled, created_by)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
RETURNING *;

-- name: ListUpstreamHealthSources :many
SELECT * FROM upstream_health_sources
WHERE org_id = $1
ORDER BY lower(name);

-- name: GetUpstreamHealthSource :one
SELECT * FROM upstream_health_sources
WHERE org_id = $1 AND id = $2;

-- name: ListEnabledUpstreamHealthSources :many
SELECT * FROM upstream_health_sources
WHERE enabled = true;

-- name: UpdateUpstreamHealthSource :one
UPDATE upstream_health_sources
SET name = $3, kind = $4, url = $5, expected_components = $6,
    check_interval_seconds = $7, enabled = $8, updated_at = now()
WHERE org_id = $1 AND id = $2
RETURNING *;

-- name: DeleteUpstreamHealthSource :one
DELETE FROM upstream_health_sources
WHERE org_id = $1 AND id = $2
RETURNING *;

-- name: RecordUpstreamStatus :exec
UPDATE upstream_health_sources
SET last_status = $3, last_degraded = $4, last_checked_at = now(),
    last_error_reason = NULL, updated_at = now()
WHERE org_id = $1 AND id = $2;

-- name: RecordUpstreamPollError :exec
UPDATE upstream_health_sources
SET last_checked_at = now(), last_error_reason = $3, updated_at = now()
WHERE org_id = $1 AND id = $2;

-- name: ListLatestWorkflowVersionUpstreamTags :many
SELECT DISTINCT ON (wv.workflow_id) wv.workflow_id, wv.upstream_health_sources
FROM workflow_versions wv
JOIN workflows w ON w.id = wv.workflow_id AND w.org_id = wv.org_id
WHERE wv.org_id = $1 AND w.deleted_at IS NULL
ORDER BY wv.workflow_id, wv.version DESC
LIMIT 1000;

-- name: PauseWorkflowsForUpstream :many
UPDATE workflows
SET status = 'paused_upstream_degraded', paused_reason = $3
WHERE org_id = $1 AND id = ANY($2::text[]) AND status = 'active'
RETURNING id;

-- name: ResumeWorkflowsForUpstream :many
UPDATE workflows
SET status = 'active', paused_reason = NULL
WHERE org_id = $1 AND id = ANY($2::text[]) AND status = 'paused_upstream_degraded'
RETURNING id;

-- name: GetWorkflowVersionByNumber :one
SELECT wv.id, wv.dag_json, wv.version
FROM workflow_versions wv
JOIN workflows w ON w.id = wv.workflow_id AND w.org_id = wv.org_id
WHERE wv.workflow_id = $1 AND wv.org_id = $2 AND wv.version = $3
  AND w.deleted_at IS NULL;

-- name: GetRunParentLink :one
SELECT id, org_id, status, parent_run_id, parent_node_id, parent_link_kind,
       replay_mode, output_json, parent_notification_after
FROM runs WHERE id = $1;

-- name: MarkWaitingSubworkflowSucceeded :execrows
UPDATE run_nodes
SET status = 'succeeded', state_json = sqlc.arg(state_json),
    finished_at = sqlc.arg(finished_at)
WHERE run_id = sqlc.arg(run_id) AND node_id = sqlc.arg(node_id)
  AND status = 'waiting'
  AND state_json -> 'waiting' ->> 'childRunId' = sqlc.arg(child_run_id)::text;

-- name: MarkWaitingSubworkflowFailed :execrows
UPDATE run_nodes
SET status = 'failed', error_json = sqlc.arg(error_json),
    finished_at = sqlc.arg(finished_at)
WHERE run_id = sqlc.arg(run_id) AND node_id = sqlc.arg(node_id)
  AND status = 'waiting'
  AND state_json -> 'waiting' ->> 'childRunId' = sqlc.arg(child_run_id)::text;

-- name: GetRunNodeSnapshot :one
SELECT status, state_json, error_json
FROM run_nodes
WHERE run_id = $1 AND node_id = $2;

-- name: GetFirstFailedRunNode :one
SELECT node_id, error_json
FROM run_nodes
WHERE run_id = $1 AND status = 'failed'
ORDER BY finished_at ASC NULLS LAST, node_id ASC
LIMIT 1;

-- name: ClaimDueParentNotifications :many
UPDATE runs SET parent_notification_after = sqlc.arg(lease_until)
WHERE id IN (
  SELECT due.id FROM runs AS due
  WHERE due.parent_notification_after <= sqlc.arg(now)
    AND due.status IN ('succeeded', 'failed', 'cancelled', 'timed_out')
  ORDER BY due.parent_notification_after
  LIMIT sqlc.arg(row_limit)
  FOR UPDATE SKIP LOCKED
)
RETURNING id, status;

-- name: ClearParentNotification :exec
UPDATE runs SET parent_notification_after = NULL
WHERE id = $1 AND status = $2;

-- name: UpsertScheduleEntry :exec
INSERT INTO schedule_entries (id, org_id, workflow_id, workflow_version_id, node_id,
                              cron_expression, enabled, next_fire_at, created_by)
VALUES ($1, $2, $3, $4, $5, $6, true, $7, $8)
ON CONFLICT (org_id, workflow_version_id, node_id) DO UPDATE SET
  cron_expression = excluded.cron_expression, next_fire_at = excluded.next_fire_at,
  enabled = true, updated_at = now();

-- name: DeleteScheduleEntriesForWorkflow :exec
DELETE FROM schedule_entries WHERE org_id = $1 AND workflow_id = $2;

-- name: DeleteScheduleEntry :exec
DELETE FROM schedule_entries WHERE id = $1;

-- name: ListScheduleEntriesForWorkflow :many
SELECT * FROM schedule_entries WHERE org_id = $1 AND workflow_id = $2 ORDER BY node_id;

-- name: ClaimDueScheduleEntries :many
UPDATE schedule_entries SET next_fire_at = sqlc.arg(lease_until)
WHERE id IN (
  SELECT due.id FROM schedule_entries AS due
  WHERE due.enabled = true AND due.next_fire_at <= sqlc.arg(now)
  ORDER BY due.next_fire_at
  LIMIT sqlc.arg(row_limit)
  FOR UPDATE SKIP LOCKED
)
RETURNING *;

-- name: AdvanceScheduleEntry :exec
UPDATE schedule_entries
SET next_fire_at = $2, last_run_at = $3,
    last_run_id = CASE WHEN sqlc.arg(last_run_id)::text = '' THEN last_run_id ELSE sqlc.arg(last_run_id)::text END,
    updated_at = now()
WHERE id = $1;

-- name: DisableScheduleEntry :exec
UPDATE schedule_entries SET enabled = false, updated_at = now() WHERE id = $1;

-- name: ListOpenDeadLettersForHealing :many
SELECT dl.id, dl.org_id, dl.run_id, dl.node_id, dl.error_json, dl.workflow_json,
       dl.node_json, dl.created_at
FROM dead_letters dl
WHERE dl.org_id = $1 AND dl.status = 'open' AND dl.created_at >= $2
  AND NOT EXISTS (SELECT 1 FROM auto_healing_runs ahr WHERE ahr.dead_letter_id = dl.id)
ORDER BY dl.created_at DESC
LIMIT 200;

-- name: ListHealingCandidateOrgs :many
SELECT DISTINCT org_id FROM dead_letters
WHERE status = 'open' AND created_at >= $1
LIMIT 100;

-- name: CountAutoHealingAttempts :one
SELECT count(*) FROM auto_healing_runs
WHERE org_id = $1 AND signature = $2 AND created_at >= $3;

-- name: InsertAutoHealingRun :exec
INSERT INTO auto_healing_runs (id, org_id, dead_letter_id, signature, status,
                               proposed_patch_json, approach_label, confidence,
                               loop_attempt_count, metadata)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10);

-- name: SetAutoHealingValidating :execrows
UPDATE auto_healing_runs
SET status = 'validating', validation_run_id = $3, updated_at = now()
WHERE org_id = $1 AND id = $2 AND status = 'proposed';

-- name: ListValidatingAutoHealingRuns :many
SELECT ahr.id, ahr.org_id, ahr.validation_run_id, r.status AS run_status,
       r.validation_evidence_level
FROM auto_healing_runs ahr
JOIN runs r ON r.id = ahr.validation_run_id
WHERE ahr.status = 'validating'
  AND r.status IN ('succeeded', 'failed', 'cancelled', 'timed_out')
LIMIT 200;

-- name: SetAutoHealingValidationOutcome :execrows
UPDATE auto_healing_runs
SET status = $3, validation_evidence_level = $4, updated_at = now()
WHERE org_id = $1 AND id = $2 AND status = 'validating';

-- name: ListPendingAutoHealingRuns :many
SELECT * FROM auto_healing_runs
WHERE org_id = $1 AND status = 'validated'
ORDER BY created_at DESC
LIMIT $2;

-- name: GetAutoHealingRun :one
SELECT * FROM auto_healing_runs WHERE org_id = $1 AND id = $2;

-- name: DecideAutoHealingRun :execrows
UPDATE auto_healing_runs
SET status = $3, decision_actor = $4, decline_reason = $5, updated_at = now()
WHERE org_id = $1 AND id = $2 AND status = 'validated';

-- name: ListMemoryConsentRevokedOrgs :many
SELECT org_id, updated_at FROM org_configs
WHERE key = 'memory.enabled' AND value_json = 'false'::jsonb AND updated_at <= $1;

-- name: PurgeMemoryEntriesForOrg :execrows
DELETE FROM memory_entries WHERE org_id = $1;

-- name: ListScheduleFireHistory :many
SELECT r.created_at, r.status
FROM runs r
JOIN workflow_versions wv ON wv.id = r.workflow_version_id
WHERE wv.workflow_id = $1 AND wv.org_id = $2
  AND r.org_id = $2
  AND r.input_json -> 'input' ->> 'triggeredBy' = 'schedule'
  AND r.created_at >= $3
ORDER BY r.created_at DESC
LIMIT 5000;

-- name: ListSnippets :many
SELECT * FROM snippets WHERE org_id = $1 ORDER BY lower(name) LIMIT 200;

-- name: GetSnippet :one
SELECT * FROM snippets WHERE org_id = $1 AND id = $2;

-- name: FindSnippetByName :one
SELECT * FROM snippets WHERE org_id = $1 AND lower(name) = lower($2);

-- name: InsertSnippet :one
INSERT INTO snippets (id, org_id, name, description, category, tags, builtin,
                      nodes_json, edges_json, entry_node_id, created_by)
VALUES ($1, $2, $3, $4, $5, $6, false, $7, $8, $9, $10)
RETURNING *;

-- name: UpdateSnippet :one
UPDATE snippets
SET name = $3, description = $4, category = $5, tags = $6,
    nodes_json = $7, edges_json = $8, entry_node_id = $9, updated_at = now()
WHERE org_id = $1 AND id = $2 AND builtin = false
RETURNING *;

-- name: DeleteSnippet :one
DELETE FROM snippets WHERE org_id = $1 AND id = $2 AND builtin = false
RETURNING *;

-- name: GetOnboardingProgress :one
SELECT * FROM onboarding_progress WHERE org_id = $1 AND user_id = $2;

-- name: EnsureOnboardingRow :exec
INSERT INTO onboarding_progress (id, org_id, user_id, step, status)
VALUES ($1, $2, $3, 'org_created', 'active')
ON CONFLICT (org_id, user_id) DO NOTHING;

-- name: SetOnboardingStep :exec
UPDATE onboarding_progress SET step = $3, updated_at = now()
WHERE org_id = $1 AND user_id = $2;

-- name: SetOnboardingStatus :execrows
UPDATE onboarding_progress
SET status = sqlc.arg(status),
    skipped_at = CASE WHEN sqlc.arg(status)::text = 'skipped' THEN now() ELSE NULL END,
    updated_at = now()
WHERE org_id = $1 AND user_id = $2 AND status != 'completed'
  AND status != sqlc.arg(status)::text;

-- name: CompleteOnboardingCas :execrows
UPDATE onboarding_progress
SET status = 'completed', step = 'completed', completed_at = now(), updated_at = now()
WHERE org_id = $1 AND user_id = $2 AND status != 'completed';

-- name: RestartOnboarding :execrows
UPDATE onboarding_progress
SET status = 'active', step = 'org_created', skipped_at = NULL,
    completed_at = NULL, restarted_at = now(), updated_at = now()
WHERE org_id = $1 AND user_id = $2;

-- name: ResolveOnboardingSignals :one
SELECT
  EXISTS(SELECT 1 FROM credentials c WHERE c.org_id = sqlc.arg(org_id)
         AND (sqlc.narg(since)::timestamptz IS NULL OR c.created_at >= sqlc.narg(since)::timestamptz)) AS credential_configured,
  EXISTS(SELECT 1 FROM audit_logs a WHERE a.org_id = sqlc.arg(org_id) AND a.action = 'workflow.pack_imported'
         AND (sqlc.narg(since)::timestamptz IS NULL OR a.created_at >= sqlc.narg(since)::timestamptz)) AS pack_installed,
  EXISTS(SELECT 1 FROM runs r WHERE r.org_id = sqlc.arg(org_id) AND r.status = 'succeeded'
         AND (sqlc.narg(since)::timestamptz IS NULL OR r.created_at >= sqlc.narg(since)::timestamptz)) AS first_run_succeeded,
  EXISTS(SELECT 1 FROM dead_letters d WHERE d.org_id = sqlc.arg(org_id)
         AND (sqlc.narg(since)::timestamptz IS NULL OR d.created_at >= sqlc.narg(since)::timestamptz)) AS failure_injected,
  (EXISTS(SELECT 1 FROM dead_letters d2 WHERE d2.org_id = sqlc.arg(org_id) AND d2.status IN ('replayed','resolved')
          AND (sqlc.narg(since)::timestamptz IS NULL OR d2.created_at >= sqlc.narg(since)::timestamptz))
   OR EXISTS(SELECT 1 FROM recovery_items ri WHERE ri.org_id = sqlc.arg(org_id) AND ri.status = 'resolved'
          AND (sqlc.narg(since)::timestamptz IS NULL OR ri.created_at >= sqlc.narg(since)::timestamptz))) AS recovery_applied;


-- name: GetLatestWorkflowSlo :one
SELECT slo_json FROM workflow_versions
WHERE org_id = $1 AND workflow_id = $2
ORDER BY version DESC
LIMIT 1;

-- name: QueryWorkflowHealthSignals :one
WITH candidate_runs AS (
  -- A saved workflow's plain runs carry workflow_version_id = the WORKFLOW
  -- id (the pilot's no-rollout convention); pinned/rollout runs carry a
  -- real version-row id. The effective version for un-pinned runs is the
  -- number of versions saved at run time.
  SELECT r.id, r.status, r.created_at,
         coalesce(
           (SELECT wv.version FROM workflow_versions wv
            WHERE wv.id = r.workflow_version_id AND wv.org_id = sqlc.arg(org_id)),
           (SELECT count(*) FROM workflow_versions v2
            WHERE v2.workflow_id = sqlc.arg(workflow_id) AND v2.org_id = sqlc.arg(org_id)
              AND v2.created_at <= r.created_at)
         )::int AS effective_version
  FROM runs r
  WHERE r.org_id = sqlc.arg(org_id)
    AND r.created_at >= sqlc.arg(since)
    AND r.replay_mode IS NULL
    AND (r.workflow_version_id = sqlc.arg(workflow_id)
         OR r.workflow_version_id IN (SELECT v3.id FROM workflow_versions v3
              WHERE v3.workflow_id = sqlc.arg(workflow_id) AND v3.org_id = sqlc.arg(org_id)))
), window_runs AS (
  SELECT id, status, created_at FROM candidate_runs
  WHERE (sqlc.narg(before_version)::int IS NULL OR effective_version < sqlc.narg(before_version)::int)
    AND (sqlc.narg(from_version)::int IS NULL OR effective_version >= sqlc.narg(from_version)::int)
), terminal AS (
  SELECT wr.id, wr.status, wr.created_at,
         (SELECT min(e.created_at) FROM run_events e
          WHERE e.run_id = wr.id AND e.type IN ('run.succeeded','run.failed','run.cancelled','run.timed_out')) AS terminal_at
  FROM window_runs wr
  WHERE wr.status IN ('succeeded','failed','cancelled','timed_out')
)
SELECT
  (SELECT count(*) FROM terminal)::int AS total_runs,
  (SELECT count(*) FROM terminal WHERE status = 'succeeded')::int AS success_count,
  (SELECT count(*) FROM terminal WHERE status = 'failed')::int AS failure_count,
  (SELECT count(*) FROM run_events e JOIN window_runs wr ON wr.id = e.run_id
   WHERE e.type = 'node.retry')::int AS retry_count,
  (SELECT count(*) FROM dead_letters d JOIN window_runs wr ON wr.id = d.run_id
   WHERE d.status = 'open')::int AS dlq_open_count,
  coalesce((SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM (t.terminal_at - t.created_at)) * 1000)
   FROM terminal t WHERE t.terminal_at IS NOT NULL), -1)::float8 AS p95_latency_ms,
  coalesce((SELECT sum((u.metadata ->> 'costUsd')::float8) FROM usage_events u
   JOIN window_runs wr ON wr.id = u.run_id
   WHERE u.metadata ? 'costUsd' AND u.metadata ->> 'costUsd' != '<nil>'), 0)::float8 AS total_cost_usd,
  coalesce((SELECT sum(u.quantity) FROM usage_events u
   JOIN window_runs wr ON wr.id = u.run_id), 0)::float8 AS total_tokens,
  (SELECT count(*) FROM workflow_versions v2
   WHERE v2.workflow_id = sqlc.arg(workflow_id) AND v2.org_id = sqlc.arg(org_id))::int AS version_count,
  (SELECT count(*) FROM window_runs WHERE status = 'running')::int AS running_count;

-- name: ListRecentDeadLetterErrorsForWorkflow :many
SELECT d.error_json
FROM dead_letters d
JOIN runs r ON r.id = d.run_id
WHERE r.org_id = sqlc.arg(org_id)
  AND d.created_at >= sqlc.arg(created_at)
  AND (r.workflow_version_id = sqlc.arg(workflow_id)
       OR r.workflow_version_id IN (SELECT v3.id FROM workflow_versions v3
            WHERE v3.workflow_id = sqlc.arg(workflow_id) AND v3.org_id = sqlc.arg(org_id)))
  AND (sqlc.narg(from_version)::int IS NULL OR coalesce(
        (SELECT wv.version FROM workflow_versions wv
         WHERE wv.id = r.workflow_version_id AND wv.org_id = sqlc.arg(org_id)),
        (SELECT count(*) FROM workflow_versions v2
         WHERE v2.workflow_id = sqlc.arg(workflow_id) AND v2.org_id = sqlc.arg(org_id)
           AND v2.created_at <= r.created_at))::int >= sqlc.narg(from_version)::int)
ORDER BY d.created_at DESC
LIMIT 100;

-- name: GetWorkflowMetadata :one
SELECT * FROM workflow_metadata WHERE org_id = $1 AND workflow_id = $2;

-- name: UpsertWorkflowMetadata :one
INSERT INTO workflow_metadata (id, org_id, workflow_id, owners, tags, description,
                               slack_channel, linear_project, severity_default,
                               folder, runbook_markdown, ai_guidance_markdown, created_by)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
ON CONFLICT (org_id, workflow_id) DO UPDATE SET
  owners = excluded.owners, tags = excluded.tags, description = excluded.description,
  slack_channel = excluded.slack_channel, linear_project = excluded.linear_project,
  severity_default = excluded.severity_default, folder = excluded.folder,
  runbook_markdown = excluded.runbook_markdown,
  ai_guidance_markdown = excluded.ai_guidance_markdown, updated_at = now()
RETURNING *;

-- name: SetWorkflowFolderOnly :one
INSERT INTO workflow_metadata (id, org_id, workflow_id, folder, created_by)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (org_id, workflow_id) DO UPDATE SET
  folder = excluded.folder, updated_at = now()
RETURNING *;

-- name: SetWorkflowTagsOnly :one
INSERT INTO workflow_metadata (id, org_id, workflow_id, tags, created_by)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (org_id, workflow_id) DO UPDATE SET
  tags = excluded.tags, updated_at = now()
RETURNING *;

-- name: ListDistinctWorkflowTags :many
SELECT DISTINCT jsonb_array_elements_text(m.tags)::text AS tag
FROM workflow_metadata m
JOIN workflows w ON w.id = m.workflow_id AND w.org_id = m.org_id
WHERE m.org_id = $1 AND w.deleted_at IS NULL
ORDER BY tag ASC
LIMIT 200;

-- name: ListDistinctWorkflowFolders :many
SELECT DISTINCT m.folder::text AS folder
FROM workflow_metadata m
JOIN workflows w ON w.id = m.workflow_id AND w.org_id = m.org_id
WHERE m.org_id = $1 AND m.folder IS NOT NULL AND w.deleted_at IS NULL
ORDER BY folder ASC
LIMIT 200;

-- name: RenameWorkflowFolderBulk :execrows
UPDATE workflow_metadata SET folder = sqlc.arg(to_folder), updated_at = now()
WHERE org_id = $1 AND folder = sqlc.arg(from_folder);

-- name: DeleteWorkflowFolderBulk :execrows
UPDATE workflow_metadata SET folder = NULL, updated_at = now()
WHERE org_id = $1 AND folder = sqlc.arg(folder);

-- name: RenameWorkflowTagBulk :execrows
UPDATE workflow_metadata
SET tags = (tags - sqlc.arg(from_tag)::text) || to_jsonb(sqlc.arg(to_tag)::text),
    updated_at = now()
WHERE org_id = $1 AND tags ? sqlc.arg(from_tag)::text;

-- name: DeleteWorkflowTagBulk :execrows
UPDATE workflow_metadata
SET tags = tags - sqlc.arg(tag)::text, updated_at = now()
WHERE org_id = $1 AND tags ? sqlc.arg(tag)::text;

-- name: ListOwnedActiveWorkflowIDs :many
SELECT id FROM workflows
WHERE org_id = $1 AND id = ANY(sqlc.arg(ids)::text[]) AND deleted_at IS NULL;

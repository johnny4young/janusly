-- Dispatch plane: claims, queue publication, wakeups, locks, reaper.

-- Keep Node's existing publication outbox current while Go owns delivery.
-- It is dormant under single-owner Go execution and becomes the rollback
-- source if Node must recreate BullMQ jobs.
-- name: QueueRunNode :execrows
UPDATE run_nodes
SET status = 'queued', attempts = 1,
    queue_publication_repair_after = clock_timestamp(),
    queue_publication_generation = queue_publication_generation + 1
WHERE run_id = $1 AND node_id = $2 AND status = 'pending';

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

-- A successful Go claim consumes this generation's rollback marker.
-- name: MarkLockedNodesRunning :many
UPDATE run_nodes
SET status = 'running', started_at = now(),
    queue_publication_repair_after = NULL
WHERE id = ANY(sqlc.arg(ids)::text[])
  AND status = 'queued'
  AND NOT EXISTS (
    SELECT 1 FROM go_pilot_wakeups w
    WHERE w.run_node_id = run_nodes.id AND w.wake_at > now()
  )
RETURNING id, run_id, node_id, COALESCE(attempts, 1)::int AS attempt;

-- name: AcquireRunCompletionLock :exec
SELECT pg_advisory_xact_lock(hashtextextended(sqlc.arg(run_id)::text, 0));

-- name: FindStalledRunningNodes :many
SELECT rn.id, rn.run_id, rn.node_id, COALESCE(rn.attempts, 1)::int AS attempt
FROM run_nodes rn
JOIN runs r ON r.id = rn.run_id
WHERE rn.status = 'running'
  AND rn.started_at < now() - make_interval(secs => sqlc.arg(threshold_seconds)::float8)
  AND r.status IN ('running', 'failed')
ORDER BY rn.started_at
LIMIT sqlc.arg(batch_size);

-- name: ClaimDeadLetterReplay :execrows
UPDATE dead_letters
SET replay_claimed_at = now(), status = 'replayed', replayed_at = now()
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

-- name: SweepDueWakeups :execrows
DELETE FROM go_pilot_wakeups w
WHERE w.wake_at <= now()
  AND NOT EXISTS (
    SELECT 1 FROM run_nodes rn
    WHERE rn.id = w.run_node_id AND rn.status = 'waiting'
  );

-- name: ListDueWaitingWakeups :many
SELECT run_node_id, run_id, node_id, wake_at, reason
FROM (
  SELECT w.run_node_id, rn.run_id, rn.node_id, w.wake_at, w.reason,
         ROW_NUMBER() OVER (PARTITION BY rn.run_id ORDER BY w.wake_at, w.run_node_id) AS run_rank
  FROM go_pilot_wakeups w
  JOIN run_nodes rn ON rn.id = w.run_node_id
  JOIN runs r ON r.id = rn.run_id
  WHERE w.wake_at <= now() AND rn.status = 'waiting'
    AND r.status = 'running'
    AND w.reason IN ('wait_until', 'approval_timeout')
) ranked
ORDER BY run_rank, run_node_id
LIMIT sqlc.arg(batch_size);

-- name: NotifyRunEvents :exec
SELECT pg_notify('janusly_go_run_events', sqlc.arg(run_id)::text);

-- name: ClaimTriggerEventStart :execrows
-- Accepts 'received' (the ordinary ingest path) AND 'buffered' (the
-- breaker-resume backfill): both are "owed a run" states, and the CAS
-- keeps a concurrent backfill/relay from spawning a second run.
UPDATE trigger_events
SET status = 'started', run_id = $3, skipped_reason = NULL,
    backfill_claim_token = NULL, backfill_claimed_at = NULL
WHERE org_id = $1 AND id = $2 AND status IN ('received', 'buffered') AND run_id IS NULL;

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

-- name: ClaimStartIdempotencyKey :execrows
INSERT INTO go_pilot_start_idempotency (org_id, idempotency_key, run_id)
VALUES ($1, $2, $3)
ON CONFLICT (org_id, idempotency_key) DO NOTHING;

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

-- name: StampRedriveRecoveryClaim :exec
UPDATE run_nodes
SET recovery_dead_letter_id = $3, recovery_requested_by = $4, recovery_claim_token = $5,
    recovery_playbook_id = $6, recovery_validation_run_id = $7
WHERE run_id = $1 AND node_id = $2;

-- name: GetRunNodeRecoveryClaim :one
SELECT recovery_dead_letter_id, recovery_requested_by, recovery_claim_token,
       recovery_playbook_id, recovery_validation_run_id
FROM run_nodes WHERE run_id = $1 AND node_id = $2;

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

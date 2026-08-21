-- Runs, nodes, events, subworkflows: lifecycle reads and writes.

-- name: InsertRun :exec
INSERT INTO runs (id, org_id, workflow_version_id, status, input_json, created_by, replay_mode, validation_evidence_level,
  parent_run_id, parent_node_id, parent_link_kind, workflow_rollout_id, workflow_rollout_variant, trace_id)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14);

-- Recovery drills reproduce a server-authored historical claim and therefore
-- need an explicit creation clock. Ordinary run starts must keep using
-- InsertRun so callers cannot backdate production traffic.
-- name: InsertRecoveryDrillRun :exec
INSERT INTO runs (
  id, org_id, workflow_version_id, status, input_json, created_by,
  replay_mode, validation_evidence_level, created_at
)
VALUES ($1, $2, $3, $4, $5, $6, 'validation', 'static', $7);

-- name: GetRun :one
SELECT id, org_id, workflow_version_id, status, input_json, output_json,
       parent_run_id, parent_node_id, replay_mode, created_by, created_at,
       outcome_status, semantic_violation_count, validation_evidence_level, trace_id
FROM runs
WHERE id = $1 AND org_id = $2;

-- The child of a subworkflow inherits the parent's correlation id so the
-- whole chain stays copyable as one trace (reference start-run posture).
-- name: GetRunTraceID :one
SELECT trace_id FROM runs WHERE id = $1;

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

-- Initial executable roots expose one Node-compatible rollback generation;
-- pending descendants do not become publishable until readiness queues them.
-- name: InsertRunNode :exec
INSERT INTO run_nodes (
  id, run_id, node_id, status, attempts, state_json,
  queue_publication_repair_after, queue_publication_generation
)
VALUES (
  $1, $2, $3, $4, $5, $6,
  CASE WHEN $4 = 'queued' THEN clock_timestamp() ELSE NULL END,
  CASE WHEN $4 = 'queued' THEN 1 ELSE 0 END
);

-- Server-owned sandbox adapters seed only the checkpoints required to enter
-- one exact runtime boundary. This is deliberately not a general mutation API.
-- name: InsertSeededRunNode :exec
INSERT INTO run_nodes (
  id, run_id, node_id, status, attempts, state_json,
  started_at, finished_at,
  queue_publication_repair_after, queue_publication_generation
)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10);

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

-- Aggregate comparison telemetry in Postgres so the read stays exact without
-- materializing an unbounded usage-event slice in the API process. Malformed
-- or unknown costs remain null; token quantities still aggregate independently.
-- name: ListRunComparisonUsage :many
SELECT coalesce(run_id, '')::text AS run_id,
       coalesce(metadata->>'nodeId', '')::text AS node_id,
       coalesce(sum(quantity), 0)::bigint AS tokens,
       count(*) FILTER (WHERE jsonb_typeof(metadata->'costUsd') = 'number') > 0 AS has_cost,
       coalesce(sum((metadata->>'costUsd')::double precision)
         FILTER (WHERE jsonb_typeof(metadata->'costUsd') = 'number'), 0)::double precision AS cost_usd
FROM usage_events
WHERE org_id = sqlc.arg(org_id)
  AND run_id = ANY(sqlc.arg(run_ids)::text[])
  AND metadata->>'nodeId' IS NOT NULL
GROUP BY run_id, metadata->>'nodeId'
ORDER BY run_id, metadata->>'nodeId';

-- The claim is the queue's consume operation, split in TWO statements

-- inside one transaction on purpose. A single UPDATE-with-subquery is

-- vulnerable to an EvalPlanQual race under READ COMMITTED: when the locked

-- row changed since the statement snapshot, the NOT EXISTS wake-up guard

-- re-evaluates against the OLD snapshot — which predates a retry's

-- freshly-committed future wake-up — and a delayed retry gets claimed

-- instantly. Statement one locks candidates (SKIP LOCKED keeps workers

-- disjoint); statement two re-checks every guard under a FRESH snapshot on

-- rows we already hold, where no EPQ re-evaluation can occur.

-- Serializes node-completion transactions per run: the xact lock releases

-- on commit, so a concurrent sibling's readiness scan always observes this

-- completion — the fan-in gate for joins.

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

-- input_json carries the whole workflow snapshot, so the callers that only
-- need to know whether this is a sandbox replay must not pay to transfer
-- it: one node cycle asks that question up to four times.
-- name: GetRunReplayMode :one
SELECT status, org_id, replay_mode FROM runs WHERE id = $1;

-- The Node outbox deadline is the same instant as Go's retry wakeup. Node's
-- reconciler therefore cannot publish the rollback delivery before backoff.
-- name: RequeueRunNodeForRetry :execrows
UPDATE run_nodes
SET status = 'queued', attempts = sqlc.arg(attempt),
    queue_publication_repair_after = sqlc.arg(wake_at),
    queue_publication_generation = queue_publication_generation + 1
WHERE run_id = sqlc.arg(run_id) AND node_id = sqlc.arg(node_id)
  AND status = 'running';

-- name: ListRunNodeStatuses :many
SELECT node_id, status FROM run_nodes WHERE run_id = $1;

-- name: GetRunOwner :one
SELECT org_id, status FROM runs WHERE id = $1;

-- Cancellation is a terminal transition: the CAS keeps it from
-- overwriting a run that reached succeeded/failed/timed_out between the
-- API's status read and this write (the only regression-capable window).
-- Arming parent_notification_after mirrors MarkRunTerminalFromRunning so
-- a cancelled subworkflow child still settles its waiting parent.
-- name: CancelRun :execrows
UPDATE runs SET status = 'cancelled',
    parent_notification_after = CASE
      WHEN parent_run_id IS NOT NULL AND parent_node_id IS NOT NULL
           AND (parent_link_kind = 'subworkflow'
                OR (parent_link_kind IS NULL AND replay_mode IS NULL))
      THEN now() ELSE parent_notification_after END
WHERE id = $1
  AND status NOT IN ('succeeded', 'failed', 'cancelled', 'timed_out');

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

-- Exact approval-deadline generation CAS. Manual resume, cancellation,
-- escalation, or duplicate sweep delivery makes this a no-op.
-- name: FailWaitingApprovalDeadline :execrows
UPDATE run_nodes
SET status = 'failed', error_json = sqlc.arg(error_json),
    finished_at = sqlc.arg(finished_at), waiting_repair_after = NULL
WHERE run_id = sqlc.arg(run_id) AND node_id = sqlc.arg(node_id)
  AND status = 'waiting'
  AND state_json #>> '{waiting,kind}' = 'approval'
  AND state_json #>> '{waiting,deadlineAt}' = sqlc.arg(expected_deadline_at)::text
  AND state_json #>> '{waiting,timeoutState}' IS NULL;

-- name: EscalateWaitingApprovalDeadline :execrows
UPDATE run_nodes
SET state_json = sqlc.arg(state_json), waiting_repair_after = NULL
WHERE run_id = sqlc.arg(run_id) AND node_id = sqlc.arg(node_id)
  AND status = 'waiting'
  AND state_json #>> '{waiting,kind}' = 'approval'
  AND state_json #>> '{waiting,deadlineAt}' = sqlc.arg(expected_deadline_at)::text
  AND state_json #>> '{waiting,timeoutState}' IS NULL;

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

-- One COPY for every event a completion-family transaction appends:
-- same columns and payload bytes as InsertRunEventAt, one
-- round trip instead of one per event.
-- name: InsertRunEvents :copyfrom
INSERT INTO run_events (id, run_id, node_id, type, payload, created_at)
VALUES ($1, $2, $3, $4, $5, $6);

-- Ascending page for the SSE catch-up: everything strictly after the

-- composite cursor, oldest first.

-- The /causal decision explorer: one exact decision.made event,
-- pinned to run + node so a foreign event id cannot leak.
-- name: GetDecisionEvent :one
SELECT id, run_id, node_id, type, payload, created_at
FROM run_events
WHERE id = $1 AND run_id = $2 AND node_id = $3 AND type = 'decision.made';

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
       r.created_at, r.trace_id,
       coalesce(wv.workflow_id, r.workflow_version_id) AS workflow_id,
       coalesce((r.input_json->'workflow'->>'name')::text, '') AS workflow_name,
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

-- Stalled running nodes: the one failure mode the atomic claim cannot

-- self-heal (a worker killed mid-execution). Joined to open runs only.

-- The claim is also the lifecycle flip: one statement takes the causal

-- replay claim AND moves the row open → replayed, so a claimed dead letter

-- can never linger as an eligible "open" member of a second cohort.

-- A Go-created redrive remains recoverable by Node before its Go claim.
-- name: RedriveFailedRunNode :one
UPDATE run_nodes
SET status = 'queued', attempts = 1,
    queue_publication_repair_after = clock_timestamp(),
    queue_publication_generation = queue_publication_generation + 1
WHERE run_id = sqlc.arg(run_id) AND node_id = sqlc.arg(node_id)
  AND status = 'failed'
RETURNING COALESCE(attempts, 1)::int AS attempt;

-- name: ReviveFailedRun :execrows
UPDATE runs SET status = 'running'
WHERE id = sqlc.arg(id) AND status = 'failed';

-- Garbage-collects consumed wake-ups. Correctness never depends on this:

-- the claim's anti-join reads wake_at against now(), so a due retry is

-- claimable the moment its clock passes — this just trims rows and nudges

-- idle workers awake.

-- Due timers attached to still-waiting nodes: the sweeper resumes these —

-- the auto-completion path for wait_until. Fairness under a mass-expiry

-- backlog (a downtime window leaving thousands due): round-robin by run —

-- every run's FIRST due timer sorts before any run's second — so one run

-- with a huge pile cannot starve the rest of the fleet out of a batch.

-- Event-stream signal: fired inside every transaction that appends run

-- events, so SSE subscribers re-query exactly when something committed.

-- The start-claim CAS: runs inside the run-start transaction so "event

-- claimed" and "run exists" commit or roll back together (the contract

-- claims inside startRun's transaction the same way).

-- name: ListFailedRunNodeSamples :many
SELECT rn.run_id, rn.node_id, rn.error_json, rn.finished_at,
       r.input_json
FROM run_nodes rn
JOIN runs r ON r.id = rn.run_id
WHERE r.org_id = $1
  AND rn.status = 'failed'
  AND r.replay_mode IS NULL
  AND COALESCE(rn.finished_at, r.created_at) >= $2
ORDER BY COALESCE(rn.finished_at, r.created_at) DESC
LIMIT 500;

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

-- The pump's dispatch claim: lease one due running campaign and push its

-- clock forward by its own pacing in the same statement, so concurrent

-- pumps can't double-dispatch a step.

-- name: GetStartIdempotencyRun :one
SELECT run_id FROM run_start_idempotency
WHERE org_id = $1 AND idempotency_key = $2;

-- name: FindOpenDeadLetterForNode :one
SELECT id FROM dead_letters
WHERE org_id = $1 AND run_id = $2 AND node_id = $3 AND status = 'open'
ORDER BY created_at DESC
LIMIT 1;

-- Batched per-org data retention (the contract's subquery+LIMIT shape):

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

-- Newest bounded usage slice for one run (the /run/usage read). The

-- explicit NULLS LAST matches the index order — created_at is

-- historically nullable even though new writes default it.

-- name: ListRunUsageSlice :many
SELECT metric, quantity, metadata FROM usage_events
WHERE org_id = $1 AND run_id = $2
ORDER BY created_at DESC NULLS LAST, id DESC NULLS LAST
LIMIT $3;

-- Queue health over the Postgres substrate: waiting = queued nodes of

-- running runs whose wake-up (if any) has passed; active = running nodes.

-- The oldest age starts at ELIGIBILITY — the latest node.queued event or

-- the retry wake-at, whichever is later. A node with neither signal has

-- unknown age and is excluded (the queue eligibility

-- retry/stalled-age caveat).

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

-- name: ResolveRecoveryItemFromTerminal :execrows
UPDATE recovery_items
SET status = 'resolved', resolution_reason = 'sandbox_replay_succeeded',
    resolved_by = sqlc.arg(actor), resolved_at = sqlc.arg(recovered_at),
    first_action_at = COALESCE(first_action_at, sqlc.arg(first_action_at)),
    updated_at = sqlc.arg(recovered_at)
WHERE org_id = $1 AND id = $2 AND status = sqlc.arg(from_status);

-- name: UpdateRunWorkflowSnapshot :exec
UPDATE runs SET input_json = jsonb_set(input_json, '{workflow}', sqlc.arg(workflow)::jsonb)
WHERE id = $1;

-- name: FindLatestDeadLetterForNode :one
SELECT id, node_id, attempt, node_json, error_json FROM dead_letters
WHERE org_id = $1 AND run_id = $2 AND node_id = $3
ORDER BY created_at DESC, id DESC LIMIT 1;

-- name: FindLatestPatchAuditForRun :one
SELECT created_at, metadata FROM audit_logs
WHERE org_id = $1 AND action = 'ai.workflow.patch_suggested'
  AND (metadata ->> 'runId' = sqlc.arg(run_id)::text OR target_id = sqlc.arg(run_id)::text)
ORDER BY created_at DESC LIMIT 1;

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

-- name: UpsertExternalRunPlaceholder :exec
INSERT INTO external_runs (id, org_id, connection_id, external_workflow_id,
                           external_run_id, status, evidence_json, last_sequence)
VALUES ($1, $2, $3, $4, $5, 'unknown', '[]'::jsonb, -1)
ON CONFLICT (connection_id, external_run_id) DO NOTHING;

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

-- Claim BEFORE diagnosing. The sweep runs on every replica and its
-- loop-breaker was a read-then-write, so overlapping ticks proposed the
-- same repair twice and paid for two LLM diagnoses. The unique
-- dead_letter_id index makes this claim the serialization point; the row
-- is settled with the real proposal, or deleted when no patch is found so
-- the candidate stays eligible.
-- name: ClaimAutoHealingCandidate :execrows
INSERT INTO auto_healing_runs (id, org_id, dead_letter_id, signature, status,
                               loop_attempt_count)
VALUES ($1, $2, $3, $4, 'diagnosing', $5)
ON CONFLICT (dead_letter_id) WHERE status = 'diagnosing' DO NOTHING;

-- name: SettleAutoHealingProposal :execrows
UPDATE auto_healing_runs
SET status = 'proposed', proposed_patch_json = sqlc.arg(proposed_patch_json),
    approach_label = sqlc.arg(approach_label), confidence = sqlc.arg(confidence),
    metadata = sqlc.arg(metadata), updated_at = now()
WHERE id = sqlc.arg(id) AND status = 'diagnosing';

-- name: DeleteAutoHealingClaim :exec
DELETE FROM auto_healing_runs WHERE id = $1 AND status = 'diagnosing';

-- A replica that died mid-diagnosis leaves its claim behind; without this
-- the candidate would never be healable again.
-- name: ExpireStaleAutoHealingClaims :execrows
DELETE FROM auto_healing_runs
WHERE status = 'diagnosing' AND updated_at < now() - interval '15 minutes';

-- name: ListValidatingAutoHealingRuns :many
SELECT ahr.id, ahr.org_id, ahr.validation_run_id, r.status AS run_status,
       r.validation_evidence_level
FROM auto_healing_runs ahr
JOIN runs r ON r.id = ahr.validation_run_id
WHERE ahr.status = 'validating'
  AND r.status IN ('succeeded', 'failed', 'cancelled', 'timed_out')
LIMIT 200;

-- name: ListPendingAutoHealingRuns :many
SELECT * FROM auto_healing_runs
WHERE org_id = $1 AND status = 'validated'
ORDER BY created_at DESC
LIMIT $2;

-- name: GetAutoHealingRun :one
SELECT * FROM auto_healing_runs WHERE org_id = $1 AND id = $2;

-- name: ListAutoHealingAutonomyFacts :many
WITH selected AS (
  SELECT id, dead_letter_id, signature
  FROM auto_healing_runs
  WHERE org_id = sqlc.arg(org_id)
    AND id = ANY(sqlc.arg(ids)::text[])
), verified AS (
  SELECT ahr.signature,
         count(DISTINCT rie.dead_letter_id)::bigint AS prior_verified_recoveries
  FROM auto_healing_runs ahr
  JOIN recovery_impact_events rie
    ON rie.org_id = ahr.org_id
   AND rie.dead_letter_id = ahr.dead_letter_id
  WHERE ahr.org_id = sqlc.arg(org_id)
    AND ahr.status = 'applied'
    AND ahr.signature IN (SELECT signature FROM selected)
  GROUP BY ahr.signature
)
SELECT selected.id AS auto_healing_id,
       (dl.id IS NOT NULL)::boolean AS context_found,
       COALESCE(dl.workflow_json, '{}'::jsonb)::jsonb AS workflow_json,
       COALESCE(dl.node_id, '')::text AS node_id,
       COALESCE(dl.error_json, '{}'::jsonb)::jsonb AS error_json,
       COALESCE(verified.prior_verified_recoveries, 0)::bigint AS prior_verified_recoveries
FROM selected
LEFT JOIN dead_letters dl
  ON dl.org_id = sqlc.arg(org_id)
 AND dl.id = selected.dead_letter_id
LEFT JOIN verified ON verified.signature = selected.signature
ORDER BY selected.id
LIMIT 200;

-- name: DecideAutoHealingRun :execrows
UPDATE auto_healing_runs
SET status = $3, decision_actor = $4, decline_reason = $5, updated_at = now()
WHERE org_id = $1 AND id = $2 AND status = 'validated';

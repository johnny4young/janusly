-- DLQ, recovery items/cases, playbooks, campaigns, clustering, healing.

-- Validation-mode rows are dialog/drill evidence, not operator work.
-- name: ListDeadLetterSummaries :many
SELECT dl.id, dl.org_id, dl.run_id, dl.node_id, dl.attempt, dl.error_json,
       dl.status, dl.replayed_at, dl.created_at,
       dl.node_json->>'type' AS node_type,
       coalesce((dl.workflow_json->>'name')::text, '') AS workflow_name,
       ri.id AS recovery_id, ri.owner AS recovery_owner,
       coalesce(ri.severity, '') AS recovery_severity,
       coalesce(ri.status, '') AS recovery_status,
       ri.sla_target_at AS recovery_sla_target_at,
       ri.resolution_reason AS recovery_resolution_reason,
       ri.comments AS recovery_comments,
       ri.workflow_id AS recovery_workflow_id,
       wm.workflow_id AS recovery_metadata_workflow_id,
       coalesce(ri.occurrence_count, 0) AS recovery_occurrence_count,
       ri.last_occurred_at AS recovery_last_occurred_at
FROM dead_letters dl
LEFT JOIN runs r ON r.id = dl.run_id
LEFT JOIN workflow_versions wv ON wv.id = r.workflow_version_id
LEFT JOIN recovery_items ri ON ri.org_id = dl.org_id AND ri.dead_letter_id = dl.id
LEFT JOIN workflow_metadata wm ON wm.org_id = ri.org_id AND wm.workflow_id = ri.workflow_id
WHERE dl.org_id = $1
  AND dl.replay_mode IS NULL
  AND (sqlc.narg(filter_status)::text IS NULL OR dl.status = sqlc.narg(filter_status))
  AND (sqlc.narg(filter_node_id)::text IS NULL OR dl.node_id = sqlc.narg(filter_node_id))
  AND (sqlc.narg(filter_workflow_id)::text IS NULL
       OR wv.workflow_id = sqlc.narg(filter_workflow_id)
       OR (wv.id IS NULL AND coalesce(
             nullif(r.input_json->'workflow'->>'id', ''),
             r.workflow_version_id
           ) = sqlc.narg(filter_workflow_id)))
ORDER BY dl.created_at DESC, dl.id DESC
LIMIT sqlc.arg(page_limit);

-- replay_mode is copied from the failing run: a sandbox validation's
-- failure is evidence for its dialog or drill, never operator work, so
-- the operator listings exclude marked rows while direct-by-id reads
-- (the dialog, drills, replay) still find them.
-- name: InsertDeadLetter :exec
INSERT INTO dead_letters (id, org_id, run_id, node_id, attempt, workflow_json, node_json, error_json, replay_mode)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9);

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
WHERE org_id = $1
  AND replay_mode IS NULL
GROUP BY status;

-- name: ListDeadLetterFailureSamples :many
SELECT dl.id, dl.run_id, dl.node_id, dl.error_json, dl.created_at,
       r.input_json
FROM dead_letters dl
JOIN runs r ON r.id = dl.run_id
WHERE dl.org_id = $1
  AND dl.created_at >= $2
  AND r.replay_mode IS NULL
ORDER BY dl.created_at DESC
LIMIT 500;

-- Verified-recovery north star over REAL redrives: a dead letter whose

-- replay was claimed and whose run then reached succeeded. Duration is

-- detection (dead letter row) → the run's terminal success event, the

-- runtime's equivalent of the contract's detectedAt → verifiedRecoveredAt.

-- percentile_cont matches the contract's percentile semantics exactly.

-- name: QueryVerifiedRecoveryStats :one
-- The durable generation-bound facts are the only reconciliation source:
-- a row exists only when a claimed replay
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
       COALESCE(avg(duration_ms), -1)::float8 AS mttr_avg_ms,
       COALESCE(sum(duration_ms), 0)::float8 AS downtime_ended_ms
FROM recovered;

-- name: QueryRecoveryDashboardSignals :one
-- Bounded production-only signals for the UI-friendly recovery metrics
-- projection. The current approval count is intentionally not windowed.
WITH recent_runs AS MATERIALIZED (
  SELECT id, status
  FROM runs
  WHERE org_id = sqlc.arg(target_org)
    AND created_at >= sqlc.arg(since_at)
    AND replay_mode IS NULL
  ORDER BY created_at DESC, id DESC
  LIMIT 10000
), event_durations AS MATERIALIZED (
  SELECT e.run_id,
         extract(epoch FROM (max(e.created_at) - min(e.created_at)))::float8 * 1000 AS duration_ms
  FROM run_events e
  JOIN recent_runs r ON r.id = e.run_id
  GROUP BY e.run_id
  ORDER BY max(e.created_at) DESC, e.run_id DESC
  LIMIT 5000
), attempts AS MATERIALIZED (
  SELECT dlq.id, dlq.org_id, dlq.run_id, dlq.node_id,
         coalesce(dlq.replay_claimed_at, dlq.replayed_at) AS replay_boundary
  FROM dead_letters dlq
  JOIN runs attempt_run ON attempt_run.id = dlq.run_id AND attempt_run.org_id = dlq.org_id
  WHERE dlq.org_id = sqlc.arg(target_org)
    AND coalesce(dlq.replay_claimed_at, dlq.replayed_at) >= sqlc.arg(since_at)
    AND attempt_run.replay_mode IS NULL
), outcomes AS MATERIALIZED (
  SELECT attempts.id,
         bool_or(impact.dead_letter_id IS NOT NULL) AS succeeded,
         bool_or(later_run.id IS NOT NULL) AS reopened
  FROM attempts
  LEFT JOIN recovery_impact_events impact ON impact.dead_letter_id = attempts.id
  LEFT JOIN dead_letters later
    ON later.org_id = attempts.org_id
   AND later.run_id = attempts.run_id
   AND later.node_id = attempts.node_id
   AND later.id <> attempts.id
   AND later.created_at > attempts.replay_boundary
  LEFT JOIN runs later_run
    ON later_run.id = later.run_id
   AND later_run.org_id = later.org_id
   AND later_run.replay_mode IS NULL
  GROUP BY attempts.id
)
SELECT
  (SELECT count(*) FILTER (WHERE status = 'succeeded') FROM recent_runs)::int AS succeeded,
  (SELECT count(*) FILTER (WHERE status = 'failed') FROM recent_runs)::int AS failed,
  (SELECT count(*) FILTER (WHERE status = 'cancelled') FROM recent_runs)::int AS cancelled,
  (SELECT count(*) FILTER (WHERE status = 'running') FROM recent_runs)::int AS running,
  (SELECT count(*) FILTER (WHERE status = 'queued') FROM recent_runs)::int AS queued,
  (SELECT count(*) FROM recent_runs)::int AS total,
  (SELECT count(*)
     FROM run_nodes node
     JOIN runs run ON run.id = node.run_id
    WHERE run.org_id = sqlc.arg(target_org)
      AND run.replay_mode IS NULL
      AND node.status = 'waiting'
      AND node.state_json #>> '{waiting,reason}' = 'Waiting for human approval')::int AS approvals_pending,
  CASE WHEN (SELECT count(*) FROM event_durations WHERE duration_ms > 0) >= 5
    THEN (SELECT percentile_disc(0.95) WITHIN GROUP (ORDER BY duration_ms)
            FROM event_durations WHERE duration_ms > 0)
    ELSE -1
  END::float8 AS p95_latency_ms,
  (SELECT count(*) FROM attempts)::int AS replay_total_entries,
  (SELECT count(*) FILTER (WHERE succeeded) FROM outcomes)::int AS replayed_success,
  (SELECT count(*) FILTER (WHERE NOT succeeded AND reopened) FROM outcomes)::int AS replayed_and_reopened,
  (SELECT count(*)
     FROM recovery_items item
     JOIN dead_letters dlq ON dlq.org_id = item.org_id AND dlq.id = item.dead_letter_id
     JOIN runs run ON run.org_id = item.org_id AND run.id = dlq.run_id
    WHERE item.org_id = sqlc.arg(target_org)
      AND item.status = 'resolved'
      AND item.resolved_at >= sqlc.arg(since_at)
      AND run.replay_mode IS NULL)::int AS sla_resolved,
  (SELECT count(*)
     FROM recovery_items item
     JOIN dead_letters dlq ON dlq.org_id = item.org_id AND dlq.id = item.dead_letter_id
     JOIN runs run ON run.org_id = item.org_id AND run.id = dlq.run_id
    WHERE item.org_id = sqlc.arg(target_org)
      AND item.status = 'resolved'
      AND item.resolved_at >= sqlc.arg(since_at)
      AND item.resolved_at <= item.sla_target_at
      AND run.replay_mode IS NULL)::int AS sla_met;

-- name: QueryRecoveryMttrTrend :many
SELECT to_char(date_trunc('day', impact.recovered_at), 'YYYY-MM-DD') AS day,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY impact.downtime_ended_ms))::bigint AS median_ms
FROM recovery_impact_events impact
JOIN runs run ON run.id = impact.run_id AND run.org_id = impact.org_id
WHERE impact.org_id = $1 AND impact.recovered_at >= $2 AND run.replay_mode IS NULL
GROUP BY date_trunc('day', impact.recovered_at)
ORDER BY date_trunc('day', impact.recovered_at) DESC
LIMIT 14;

-- name: ListResolvedRecoveryFailureRows :many
SELECT dlq.node_id, dlq.node_json, dlq.error_json
FROM recovery_impact_events impact
JOIN dead_letters dlq ON dlq.id = impact.dead_letter_id
JOIN runs run ON run.id = impact.run_id AND run.org_id = impact.org_id
WHERE impact.org_id = $1 AND impact.recovered_at >= $2 AND run.replay_mode IS NULL
ORDER BY impact.recovered_at DESC, impact.dead_letter_id DESC
LIMIT 10001;

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
  AND source = 'semantic_violation'
  AND (sqlc.narg(run_id)::text IS NULL OR run_id = sqlc.narg(run_id))
  AND (NOT sqlc.arg(open_only)::boolean OR state NOT IN ('verified_recovered','recurred','accepted_loss','abandoned'))
ORDER BY created_at DESC, id DESC
LIMIT sqlc.arg(page_limit);

-- The shared Operator Brief must rank before it bounds. Reusing the general
-- newest-first recovery list can hide an old approval behind newer terminal
-- history, so this source query selects only actionable rows and applies the
-- same category/severity/age order as internal/operations before LIMIT.
-- name: ListOperatorBriefRecoveryCases :many
SELECT * FROM recovery_cases
WHERE org_id = sqlc.arg(org_id)
  AND source = 'semantic_violation'
  AND (
    state = 'awaiting_approval'
    OR state IN ('detected','contained','diagnosed','candidates_ready','validating')
    OR (state = 'recurred' AND updated_at >= sqlc.arg(recurrence_since))
  )
ORDER BY
  CASE
    WHEN state = 'awaiting_approval' THEN 1
    WHEN state IN ('detected','contained','diagnosed','candidates_ready','validating') THEN 2
    ELSE 4
  END ASC,
  CASE
    WHEN state IN ('detected','contained','diagnosed','candidates_ready','validating')
      AND action = 'quarantine' THEN 4
    ELSE 3
  END DESC,
  created_at ASC,
  id ASC
LIMIT sqlc.arg(page_limit);

-- name: TransitionRecoveryCaseState :execrows
UPDATE recovery_cases
SET state = sqlc.arg(to_state), revision = revision + 1, updated_at = now(),
    resolved_at = CASE WHEN sqlc.arg(terminal)::boolean THEN now() ELSE resolved_at END
WHERE org_id = $1 AND id = $2 AND state = sqlc.arg(from_state);

-- Governed recovery mutations carry both the state and monotonic revision so
-- a stale browser or MCP caller cannot approve or apply a different artifact.
-- name: AdvanceRecoveryCaseStateAtRevision :one
UPDATE recovery_cases
SET state = sqlc.arg(to_state), revision = revision + 1,
    updated_at = sqlc.arg(occurred_at),
    resolved_at = CASE WHEN sqlc.arg(terminal)::boolean THEN sqlc.arg(occurred_at) ELSE resolved_at END
WHERE org_id = sqlc.arg(org_id) AND id = sqlc.arg(id)
  AND state = sqlc.arg(from_state) AND revision = sqlc.arg(expected_revision)
RETURNING *;

-- name: InsertRecoveryCaseTransition :execrows
INSERT INTO recovery_case_transitions (id, org_id, case_id, from_state, to_state, actor_kind, actor_id, evidence_json, reason, occurred_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
ON CONFLICT (id) DO NOTHING;

-- name: ListRecoveryCaseTransitions :many
WITH bounded AS (
  SELECT * FROM recovery_case_transitions
  WHERE org_id = $1 AND case_id = $2
  ORDER BY occurred_at DESC, id DESC
  LIMIT 100
)
SELECT * FROM bounded
ORDER BY occurred_at, id;

-- name: GetRecoveryCaseForUpdate :one
SELECT * FROM recovery_cases WHERE org_id = $1 AND id = $2 FOR UPDATE;

-- Artifacts are content-addressed and append-only. Retrying an identical
-- operation returns the original immutable row rather than duplicating it.
-- name: InsertRecoveryCaseArtifact :one
INSERT INTO recovery_case_artifacts
  (id, org_id, case_id, kind, payload_json, payload_sha256, actor_kind, actor_id, created_at)
VALUES
  ($1, $2, $3, $4, $5, $6, $7, $8, sqlc.arg(created_at))
ON CONFLICT (org_id, case_id, kind, payload_sha256)
DO UPDATE SET id = recovery_case_artifacts.id
RETURNING *;

-- name: GetRecoveryCaseArtifact :one
SELECT * FROM recovery_case_artifacts
WHERE org_id = $1 AND case_id = $2 AND id = $3;

-- name: ListRecoveryCaseArtifacts :many
-- Candidate and diagnosis artifacts define the actions still visible in the
-- current case UI. Preserve those foundations, then fill the bounded response
-- with the most recent lifecycle evidence before restoring chronological order.
WITH bounded AS (
  SELECT * FROM recovery_case_artifacts
  WHERE org_id = $1 AND case_id = $2
  ORDER BY
    CASE WHEN kind IN ('diagnosis', 'candidate') THEN 0 ELSE 1 END,
    CASE WHEN kind IN ('diagnosis', 'candidate') THEN created_at END ASC,
    CASE WHEN kind NOT IN ('diagnosis', 'candidate') THEN created_at END DESC,
    id DESC
  LIMIT 100
)
SELECT * FROM bounded
ORDER BY created_at, id;

-- name: InsertRecoveryApprovalGrant :one
INSERT INTO recovery_approval_grants
  (id, org_id, case_id, candidate_artifact_id, validation_artifact_id,
   case_revision, granted_by, expires_at, created_at)
VALUES
  ($1, $2, $3, $4, $5, $6, $7, sqlc.arg(expires_at), sqlc.arg(created_at))
RETURNING *;

-- name: FindActiveRecoveryApprovalGrant :one
SELECT grant_row.*
FROM recovery_approval_grants grant_row
JOIN recovery_cases case_row
  ON case_row.org_id = grant_row.org_id AND case_row.id = grant_row.case_id
WHERE grant_row.org_id = sqlc.arg(org_id)
  AND grant_row.case_id = sqlc.arg(case_id)
  AND grant_row.candidate_artifact_id = sqlc.arg(candidate_artifact_id)
  AND grant_row.validation_artifact_id = sqlc.arg(validation_artifact_id)
  AND grant_row.case_revision = sqlc.arg(case_revision)
  AND case_row.revision = grant_row.case_revision
  AND grant_row.consumed_at IS NULL AND grant_row.revoked_at IS NULL
  AND grant_row.expires_at > sqlc.arg(now_at)
ORDER BY grant_row.created_at DESC
LIMIT 1;

-- HTTP case detail may expose a bounded continuity hint without exposing the
-- grant identity or approving actor. The case join keeps the hint bound to the
-- exact current lifecycle revision; apply still performs its own locked CAS.
-- name: FindActiveRecoveryApprovalGrantForCase :one
SELECT grant_row.*
FROM recovery_approval_grants grant_row
JOIN recovery_cases case_row
  ON case_row.org_id = grant_row.org_id AND case_row.id = grant_row.case_id
WHERE grant_row.org_id = sqlc.arg(org_id)
  AND grant_row.case_id = sqlc.arg(case_id)
  AND grant_row.case_revision = sqlc.arg(case_revision)
  AND case_row.revision = sqlc.arg(case_revision)
  AND case_row.state = 'awaiting_approval'
  AND grant_row.consumed_at IS NULL AND grant_row.revoked_at IS NULL
  AND grant_row.expires_at > sqlc.arg(now_at)
ORDER BY grant_row.created_at DESC
LIMIT 1;

-- name: ConsumeRecoveryApprovalGrant :execrows
UPDATE recovery_approval_grants
SET consumed_at = sqlc.arg(consumed_at), consumed_by = sqlc.arg(consumed_by)
WHERE id = sqlc.arg(id) AND org_id = sqlc.arg(org_id)
  AND case_id = sqlc.arg(case_id) AND case_revision = sqlc.arg(case_revision)
  AND consumed_at IS NULL AND revoked_at IS NULL
  AND expires_at > sqlc.arg(consumed_at);

-- name: RevokeRecoveryApprovalGrants :execrows
UPDATE recovery_approval_grants
SET revoked_at = sqlc.arg(revoked_at)
WHERE org_id = sqlc.arg(org_id) AND case_id = sqlc.arg(case_id)
  AND consumed_at IS NULL AND revoked_at IS NULL;

-- Semantic resolution follows the runtime lock hierarchy: node rows first,
-- then the run, then sibling cases. These queries are deliberately explicit.
-- name: LockRunNodesForSemanticResolution :many
SELECT node.id, node.run_id, node.node_id, node.status, node.state_json,
       node.attempts, node.started_at, node.finished_at, node.error_json
FROM run_nodes node
JOIN runs run ON run.id = node.run_id
WHERE node.run_id = sqlc.arg(run_id) AND run.org_id = sqlc.arg(org_id)
ORDER BY node.id
FOR UPDATE OF node;

-- name: LockRunForSemanticResolution :one
SELECT id, org_id, status, input_json, replay_mode, semantic_violation_count
FROM runs
WHERE id = $1 AND org_id = $2
FOR UPDATE;

-- name: LockOpenSemanticRecoveryCases :many
SELECT * FROM recovery_cases
WHERE org_id = $1 AND run_id = $2 AND source_node_id = $3
  AND source = 'semantic_violation'
  AND state NOT IN ('verified_recovered', 'recurred', 'accepted_loss', 'abandoned')
ORDER BY id
FOR UPDATE;

-- Terminal settlement follows the same node → run → case lock hierarchy as
-- governed apply. Only cases already published into monitoring are eligible;
-- an earlier recovery state can never be finalized by a run event.
-- name: LockMonitoringSemanticRecoveryCases :many
SELECT * FROM recovery_cases
WHERE org_id = $1 AND run_id = $2
  AND source = 'semantic_violation' AND state = 'monitoring'
ORDER BY id
FOR UPDATE;

-- name: GetLatestRecoveryCaseArtifactByKind :one
SELECT * FROM recovery_case_artifacts
WHERE org_id = $1 AND case_id = $2 AND kind = $3
ORDER BY created_at DESC, id DESC
LIMIT 1;

-- name: ReplaceSemanticRunNodeOutput :execrows
UPDATE run_nodes AS node
SET state_json = sqlc.arg(state_json)
FROM runs AS run
WHERE node.run_id = sqlc.arg(run_id)
  AND node.node_id = sqlc.arg(node_id)
  AND node.status = 'succeeded'
  AND run.id = node.run_id
  AND run.org_id = sqlc.arg(org_id);

-- Publishing and monitoring cases no longer block the run: their immutable
-- replacement has already passed every deterministic detector and terminal
-- verification is now owned by the resumed generation.
-- name: CountBlockingSemanticRecoveryCases :one
SELECT count(*)::int AS total_open,
       count(*) FILTER (WHERE action = 'quarantine')::int AS open_quarantines
FROM recovery_cases
WHERE org_id = $1 AND run_id = $2
  AND source = 'semantic_violation'
  AND state NOT IN (
    'publishing', 'monitoring',
    'verified_recovered', 'recurred', 'accepted_loss', 'abandoned'
  );

-- Monitoring has its own honest run posture. Only the terminal generation can
-- promote it to recovered; a failed/cancelled generation clears it while the
-- verification artifact remains the durable explanation.
-- name: FinalizeRunSemanticRecoveryOutcome :execrows
UPDATE runs
SET outcome_status = CASE
  WHEN sqlc.arg(terminal_success)::boolean THEN 'semantic_recovered'
  ELSE NULL
END
WHERE id = $1 AND org_id = $2
  AND status IN ('succeeded', 'failed', 'cancelled', 'timed_out')
  AND outcome_status = 'semantic_recovering';

-- name: UpdateRunSemanticResolution :execrows
UPDATE runs
SET status = CASE WHEN sqlc.arg(resume)::boolean THEN 'running' ELSE status END,
    outcome_status = sqlc.arg(outcome_status)
WHERE id = sqlc.arg(id) AND org_id = sqlc.arg(org_id)
  AND status = sqlc.arg(expected_status);

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

-- Personal momentum (/recovery/my-wins): terminally successful DLQ
-- recoveries attributed to ONE operator, production runs only (the run
-- join drops sandbox lineage exactly like the contract projection).
-- name: CountOperatorRecoveries :one
SELECT count(*)::int
FROM recovery_impact_events e
JOIN runs r ON r.id = e.run_id AND r.org_id = e.org_id
WHERE e.org_id = $1 AND e.user_id = $2
  AND e.recovered_at >= sqlc.arg(since)::timestamptz
  AND r.replay_mode IS NULL;

-- name: InsertRecoveryItem :execrows
INSERT INTO recovery_items (id, org_id, dead_letter_id, workflow_id, severity, status, sla_target_at, error_signature, created_by)
VALUES ($1, $2, $3, $4, $5, 'open', $6, $7, $8)
ON CONFLICT (org_id, dead_letter_id) DO NOTHING;

-- name: FindRecoveryItemForDeadLetter :one
SELECT id, status, resolution_reason FROM recovery_items
WHERE org_id = $1 AND dead_letter_id = $2
FOR UPDATE;

-- Source decision + compact freshness projection are one durable fact. A
-- concurrent older request may commit last, so both clocks advance with
-- GREATEST rather than commit order.
-- name: RecordRecoveryFeedback :exec
WITH recorded AS (
  INSERT INTO recovery_feedback (id, org_id, user_id, dead_letter_id, workflow_id,
    suggestion_mode, approach_label, accepted, raw_confidence, comment, eval_consent)
  VALUES (sqlc.arg(id), sqlc.arg(org_id), sqlc.narg(user_id), sqlc.arg(dead_letter_id),
    sqlc.arg(workflow_id), sqlc.arg(suggestion_mode), sqlc.arg(approach_label),
    sqlc.arg(accepted), sqlc.narg(raw_confidence), sqlc.narg(comment), sqlc.arg(eval_consent))
  RETURNING org_id, workflow_id, approach_label, accepted, created_at
)
INSERT INTO recovery_feedback_health (id, org_id, workflow_id, approach_label,
  feedback_last_seen, accepted_fix_last_seen)
SELECT sqlc.arg(health_id), org_id, workflow_id, approach_label, created_at,
       CASE WHEN accepted THEN created_at ELSE NULL END
FROM recorded
ON CONFLICT (org_id, workflow_id, approach_label) DO UPDATE SET
  feedback_last_seen = GREATEST(
    EXCLUDED.feedback_last_seen,
    recovery_feedback_health.feedback_last_seen
  ),
  accepted_fix_last_seen = CASE
    WHEN EXCLUDED.accepted_fix_last_seen IS NULL
      THEN recovery_feedback_health.accepted_fix_last_seen
    ELSE COALESCE(
      GREATEST(
        EXCLUDED.accepted_fix_last_seen,
        recovery_feedback_health.accepted_fix_last_seen
      ),
      EXCLUDED.accepted_fix_last_seen
    )
  END;

-- name: ListCalibrationSamples :many
SELECT raw_confidence, accepted FROM recovery_feedback
WHERE org_id = $1 AND approach_label = $2 AND raw_confidence IS NOT NULL
  AND created_at >= now() - make_interval(days => sqlc.arg(window_days)::int)
ORDER BY created_at ASC
LIMIT 5000;

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
  AND dl.replay_mode IS NULL
ORDER BY dl.created_at DESC
LIMIT 500;

-- name: MarkDeadLetterResolved :execrows
UPDATE dead_letters SET status = 'resolved' WHERE org_id = $1 AND id = $2;

-- Bulk resolve used to spend one existence read plus one update per id.
-- Resolving the whole selection in one statement and RETURNING the ids it
-- actually touched keeps the per-id error reporting exact: anything the
-- caller listed but the statement did not return is not this org's.
-- name: MarkDeadLettersResolved :many
UPDATE dead_letters SET status = 'resolved'
WHERE org_id = sqlc.arg(org_id) AND id = ANY(sqlc.arg(ids)::text[])
RETURNING id;

-- name: GetRecoveryItemForDeadLetter :one
SELECT id, status FROM recovery_items WHERE org_id = $1 AND dead_letter_id = $2;

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

-- name: FindPassedRecoveryQualification :one
SELECT id FROM workflow_recovery_qualifications
WHERE org_id = $1 AND workflow_id = $2 AND baseline_version_id = $3
  AND candidate_version_id = $4 AND dataset_version = $5 AND status = 'passed'
LIMIT 1;

-- name: UpsertWorkflowRecoveryQualification :one
INSERT INTO workflow_recovery_qualifications (id, org_id, workflow_id, baseline_version_id,
  candidate_version_id, dataset_version, dataset_digest, mode, status, summary_json, created_by)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
ON CONFLICT (org_id, workflow_id, baseline_version_id, candidate_version_id, dataset_version, dataset_digest)
DO UPDATE SET mode = EXCLUDED.mode, status = EXCLUDED.status,
  summary_json = EXCLUDED.summary_json, created_at = now()
RETURNING *;

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

-- name: ListExternalRecoveryCases :many
SELECT * FROM external_recovery_cases
WHERE org_id = $1
ORDER BY CASE WHEN state = 'detected' THEN 0 ELSE 1 END, last_observed_at DESC
LIMIT 200;

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

-- name: SetAutoHealingValidating :execrows
UPDATE auto_healing_runs
SET status = 'validating', validation_run_id = $3, updated_at = now()
WHERE org_id = $1 AND id = $2 AND status = 'proposed';

-- name: SetAutoHealingValidationOutcome :execrows
UPDATE auto_healing_runs
SET status = $3, validation_evidence_level = $4, updated_at = now()
WHERE org_id = $1 AND id = $2 AND status = 'validating';

-- name: QueryEligibleFeedbackForEval :many
SELECT rf.id AS feedback_id, rf.workflow_id, rf.dead_letter_id,
       rf.approach_label, rf.suggestion_mode, rf.comment,
       dl.error_json
FROM recovery_feedback rf
LEFT JOIN dead_letters dl ON dl.id = rf.dead_letter_id
WHERE rf.org_id = sqlc.arg(org_id)
  AND rf.accepted = true AND rf.eval_consent = true
  AND (sqlc.narg(workflow_id)::text IS NULL OR rf.workflow_id = sqlc.narg(workflow_id)::text)
ORDER BY rf.created_at DESC
LIMIT 500;

-- name: FindOpenRecoveryItemForDebounce :one
SELECT id, dead_letter_id FROM recovery_items
WHERE org_id = $1 AND workflow_id = $2 AND error_signature = $3
  AND status <> 'resolved' AND last_occurred_at >= $4
ORDER BY last_occurred_at DESC
LIMIT 1;

-- name: ListRecoveryItemChildren :many
SELECT id, dead_letter_id, occurred_at
FROM recovery_item_children
WHERE org_id = $1 AND recovery_item_id = $2
ORDER BY occurred_at DESC
LIMIT 200;

-- name: InsertRecoveryItemChild :execrows
INSERT INTO recovery_item_children (id, org_id, recovery_item_id, dead_letter_id, occurred_at)
VALUES ($1, $2, $3, $4, now())
ON CONFLICT (recovery_item_id, dead_letter_id) DO NOTHING;

-- name: BumpRecoveryItemOccurrence :one
UPDATE recovery_items
SET occurrence_count = occurrence_count + 1, last_occurred_at = now(), updated_at = now()
WHERE org_id = $1 AND id = $2
RETURNING occurrence_count;

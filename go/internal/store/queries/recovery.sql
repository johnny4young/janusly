-- DLQ, recovery items/cases, playbooks, campaigns, clustering, healing.

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
  AND (sqlc.narg(filter_status)::text IS NULL OR dl.status = sqlc.narg(filter_status))
  AND (sqlc.narg(filter_node_id)::text IS NULL OR dl.node_id = sqlc.narg(filter_node_id))
  AND (sqlc.narg(filter_workflow_id)::text IS NULL
       OR wv.workflow_id = sqlc.narg(filter_workflow_id)
       OR (wv.id IS NULL AND r.workflow_version_id = sqlc.narg(filter_workflow_id)))
ORDER BY dl.created_at DESC, dl.id DESC
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

-- name: CountDeadLettersByStatus :many
SELECT status, count(*) AS count FROM dead_letters
WHERE org_id = $1 GROUP BY status;

-- name: ListDeadLetterFailureSamples :many
SELECT dl.id, dl.run_id, dl.node_id, dl.error_json, dl.created_at,
       r.input_json
FROM dead_letters dl
JOIN runs r ON r.id = dl.run_id
WHERE dl.org_id = $1 AND dl.created_at >= $2
ORDER BY dl.created_at DESC
LIMIT 2000;

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

-- Personal momentum (T-518 /recovery/my-wins): terminally successful DLQ
-- recoveries attributed to ONE operator, production runs only (the run
-- join drops sandbox lineage exactly like the reference projection).
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

-- name: InsertRecoveryItemChild :execrows
INSERT INTO recovery_item_children (id, org_id, recovery_item_id, dead_letter_id, occurred_at)
VALUES ($1, $2, $3, $4, now())
ON CONFLICT (recovery_item_id, dead_letter_id) DO NOTHING;

-- name: BumpRecoveryItemOccurrence :one
UPDATE recovery_items
SET occurrence_count = occurrence_count + 1, last_occurred_at = now(), updated_at = now()
WHERE org_id = $1 AND id = $2
RETURNING occurrence_count;

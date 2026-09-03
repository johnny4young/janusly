// Measured Recovery Drill outcomes: GET /recovery/drills/outcome reads
// one drill's truthful projection (pure composition over durable facts);
// GET /recovery/validation is the bounded per-org validation dossier.
// The chain CTEs live here as raw SQL — sqlc's analyzer cannot type the
// materialized lateral chains. The dossier still executes as one bounded
// round trip so its 100 samples cannot become an API-level N+1.
package httpapi

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/johnny4young/janusly/internal/recovery"
)

const drillOutcomeFactsSQL = `
WITH root AS (
  SELECT id, org_id, run_id, node_id, status, created_at
  FROM dead_letters WHERE org_id = $1 AND id = $2 LIMIT 1
), chain_scan AS MATERIALIZED (
  SELECT dl.id, dl.status, dl.created_at,
         COALESCE(dl.replay_claimed_at, dl.replayed_at) AS replay_started_at,
         impact.recovered_at
  FROM root
  JOIN dead_letters dl ON dl.org_id = root.org_id
    AND dl.run_id = root.run_id AND dl.node_id = root.node_id
    AND (dl.id = root.id OR (root.created_at IS NOT NULL AND dl.created_at >= root.created_at))
  LEFT JOIN recovery_impact_events impact
    ON impact.org_id = root.org_id AND impact.dead_letter_id = dl.id
  ORDER BY dl.created_at ASC NULLS FIRST, dl.id ASC
  LIMIT 101
), chain AS MATERIALIZED (
  SELECT * FROM chain_scan ORDER BY created_at ASC NULLS FIRST, id ASC LIMIT 100
), latest AS (
  SELECT id, status FROM chain ORDER BY created_at DESC NULLS LAST, id DESC LIMIT 1
), recovered AS (
  SELECT recovered_at FROM chain WHERE recovered_at IS NOT NULL ORDER BY recovered_at ASC LIMIT 1
), accepted_item AS (
  SELECT min(item.resolved_at) AS accepted_at FROM recovery_items item
  WHERE item.org_id = $1 AND item.resolution_reason = 'accepted_loss'
    AND item.resolved_at IS NOT NULL AND (
      item.dead_letter_id IN (SELECT id FROM chain)
      OR EXISTS (
        SELECT 1 FROM recovery_item_children child
        WHERE child.org_id = item.org_id AND child.recovery_item_id = item.id
          AND child.dead_letter_id IN (SELECT id FROM chain)
      )
    )
), accepted_audit AS (
  SELECT min(a.created_at) AS accepted_at FROM audit_logs a
  WHERE a.org_id = $1 AND a.action = 'dlq.resolved' AND a.target_type = 'dlq'
    AND a.target_id IN (SELECT id FROM chain)
), root_item AS (
  SELECT item.id, item.error_signature FROM recovery_items item
  WHERE item.org_id = $1 AND item.error_signature IS NOT NULL
    AND (
      item.dead_letter_id IN (SELECT id FROM chain)
      OR EXISTS (
        SELECT 1 FROM recovery_item_children child
        WHERE child.org_id = item.org_id AND child.recovery_item_id = item.id
          AND child.dead_letter_id IN (SELECT id FROM chain)
      )
    )
  ORDER BY item.created_at ASC NULLS LAST, item.id ASC LIMIT 1
), recurrence AS (
  SELECT min(candidate_at) AS recurred_at FROM (
    SELECT later_item.first_occurred_at AS candidate_at
    FROM root_item CROSS JOIN recovered
    JOIN recovery_items later_item ON later_item.org_id = $1
      AND later_item.id <> root_item.id
      AND later_item.error_signature = root_item.error_signature
    JOIN dead_letters later_dlq ON later_dlq.org_id = later_item.org_id
      AND later_dlq.id = later_item.dead_letter_id
    JOIN runs later_run ON later_run.org_id = later_item.org_id
      AND later_run.id = later_dlq.run_id
    WHERE later_item.first_occurred_at > recovered.recovered_at
      AND later_item.first_occurred_at <= recovered.recovered_at + interval '7 days'
      AND later_run.replay_mode IS NULL

    UNION ALL

    SELECT child.occurred_at AS candidate_at
    FROM root_item CROSS JOIN recovered
    JOIN recovery_item_children child ON child.org_id = $1
      AND child.recovery_item_id = root_item.id
    JOIN dead_letters child_dlq ON child_dlq.org_id = child.org_id
      AND child_dlq.id = child.dead_letter_id
    JOIN runs child_run ON child_run.org_id = child.org_id
      AND child_run.id = child_dlq.run_id
    WHERE child.occurred_at > recovered.recovered_at
      AND child.occurred_at <= recovered.recovered_at + interval '7 days'
      AND child_run.replay_mode IS NULL
  ) candidates
)
SELECT root.created_at, root.status, latest.id, latest.status,
       (SELECT count(*)::int FROM chain),
       (SELECT count(*) > 100 FROM chain_scan),
       (SELECT min(replay_started_at) FROM chain),
       recovered.recovered_at, accepted_item.accepted_at,
       accepted_audit.accepted_at, recurrence.recurred_at
FROM root
LEFT JOIN latest ON true
LEFT JOIN recovered ON true
LEFT JOIN accepted_item ON true
LEFT JOIN accepted_audit ON true
LEFT JOIN recurrence ON true`

func (s *V1Server) queryDrillOutcome(ctx context.Context, orgID, deadLetterID string) (*recovery.DrillOutcome, error) {
	facts := recovery.DrillOutcomeFacts{}
	var latestID, latestStatus *string
	err := s.pool.QueryRow(ctx, drillOutcomeFactsSQL, orgID, deadLetterID).Scan(
		&facts.RootCreatedAt, &facts.RootStatus, &latestID, &latestStatus,
		&facts.AttemptCount, &facts.ChainCapped, &facts.ReplayStartedAt,
		&facts.RecoveredAt, &facts.AcceptedItemAt, &facts.AcceptedAuditAt, &facts.RecurredAt,
	)
	if err != nil {
		return nil, err
	}
	if latestID != nil {
		facts.LatestDeadLetterID = *latestID
	}
	if latestStatus != nil {
		facts.LatestStatus = *latestStatus
	}
	outcome := recovery.BuildRecoveryDrillOutcome(facts, time.Now().UTC())
	return &outcome, nil
}

func (s *V1Server) drillOutcomeCore(r *http.Request, rc v1Request) opResult {
	deadLetterID := r.URL.Query().Get("deadLetterId")
	if deadLetterID == "" {
		return opError(http.StatusBadRequest, "recovery_drill_invalid_body", "deadLetterId is required", nil)
	}
	outcome, err := s.queryDrillOutcome(r.Context(), rc.orgID, deadLetterID)
	if err != nil {
		return opError(http.StatusNotFound, "dlq_not_found", "DLQ entry not found", nil)
	}
	return opOK(map[string]any{"outcome": outcome})
}

const recoveryValidationSQL = `
WITH drill_scan AS MATERIALIZED (
  SELECT
    run.id AS run_id,
    run.created_at AS run_created_at,
    left(run.input_json->'drill'->>'packId', 120) AS pack_id,
    left(run.input_json->'drill'->>'fixtureId', 120) AS fixture_id,
    left(run.input_json->'drill'->>'failureMode', 120) AS failure_mode,
    left(run.input_json->'drill'->>'recoveryPath', 120) AS recovery_path
  FROM runs run
  WHERE run.org_id = $1
    AND run.created_at >= $2
    AND run.input_json->'drill'->>'kind' = 'solution_pack_drill'
    AND nullif(run.input_json->'drill'->>'packId', '') IS NOT NULL
    AND nullif(run.input_json->'drill'->>'fixtureId', '') IS NOT NULL
    AND nullif(run.input_json->'drill'->>'failureMode', '') IS NOT NULL
    AND nullif(run.input_json->'drill'->>'recoveryPath', '') IS NOT NULL
  ORDER BY run.created_at DESC, run.id DESC
  LIMIT 101
), drill_runs AS MATERIALIZED (
  SELECT * FROM drill_scan ORDER BY run_created_at DESC, run_id DESC LIMIT 100
)
SELECT
  drill.run_id,
  drill.run_created_at,
  drill.pack_id,
  drill.fixture_id,
  drill.failure_mode,
  drill.recovery_path,
  (SELECT count(*) > 100 FROM drill_scan) AS sample_capped,
  root.id AS root_dead_letter_id,
  root.created_at AS root_created_at,
  root.status AS root_status,
  facts.latest_dead_letter_id,
  facts.latest_status,
  facts.attempt_count,
  facts.chain_capped,
  facts.replay_started_at,
  facts.recovered_at,
  facts.recovered_by,
  facts.accepted_item_at,
  facts.accepted_item_by,
  facts.accepted_audit_at,
  facts.accepted_audit_by,
  facts.recurred_at
FROM drill_runs drill
LEFT JOIN LATERAL (
  SELECT dl.id, dl.created_at, dl.status, dl.node_id
  FROM dead_letters dl
  WHERE dl.org_id = $1 AND dl.run_id = drill.run_id
  ORDER BY dl.created_at ASC NULLS FIRST, dl.id ASC
  LIMIT 1
) root ON true
LEFT JOIN LATERAL (
  WITH chain_scan AS MATERIALIZED (
    SELECT
      dl.id,
      dl.status,
      dl.created_at,
      coalesce(dl.replay_claimed_at, dl.replayed_at) AS replay_started_at,
      impact.recovered_at,
      impact.user_id AS recovered_by
    FROM dead_letters dl
    LEFT JOIN recovery_impact_events impact
      ON impact.org_id = $1 AND impact.dead_letter_id = dl.id
    WHERE dl.org_id = $1
      AND dl.run_id = drill.run_id
      AND dl.node_id = root.node_id
      AND (
        dl.id = root.id
        OR (root.created_at IS NOT NULL AND dl.created_at >= root.created_at)
      )
    ORDER BY dl.created_at ASC NULLS FIRST, dl.id ASC
    LIMIT 101
  ), chain AS MATERIALIZED (
    SELECT * FROM chain_scan ORDER BY created_at ASC NULLS FIRST, id ASC LIMIT 100
  ), latest AS (
    SELECT id, status FROM chain ORDER BY created_at DESC NULLS LAST, id DESC LIMIT 1
  ), recovered AS (
    SELECT recovered_at, recovered_by FROM chain
    WHERE recovered_at IS NOT NULL ORDER BY recovered_at ASC LIMIT 1
  ), accepted_item AS (
    SELECT item.resolved_at AS accepted_at, item.resolved_by AS accepted_by
    FROM recovery_items item
    WHERE item.org_id = $1
      AND item.resolution_reason = 'accepted_loss'
      AND item.resolved_at IS NOT NULL
      AND (
        item.dead_letter_id IN (SELECT id FROM chain)
        OR EXISTS (
          SELECT 1 FROM recovery_item_children child
          WHERE child.org_id = item.org_id AND child.recovery_item_id = item.id
            AND child.dead_letter_id IN (SELECT id FROM chain)
        )
      )
    ORDER BY item.resolved_at ASC, item.id ASC
    LIMIT 1
  ), accepted_audit AS (
    SELECT audit.created_at AS accepted_at, audit.user_id AS accepted_by
    FROM audit_logs audit
    WHERE audit.org_id = $1
      AND audit.action = 'dlq.resolved'
      AND audit.target_type = 'dlq'
      AND audit.target_id IN (SELECT id FROM chain)
    ORDER BY audit.created_at ASC NULLS LAST, audit.id ASC
    LIMIT 1
  ), root_item AS (
    SELECT item.id, item.error_signature
    FROM recovery_items item
    WHERE item.org_id = $1
      AND item.error_signature IS NOT NULL
      AND (
        item.dead_letter_id IN (SELECT id FROM chain)
        OR EXISTS (
          SELECT 1 FROM recovery_item_children child
          WHERE child.org_id = item.org_id AND child.recovery_item_id = item.id
            AND child.dead_letter_id IN (SELECT id FROM chain)
        )
      )
    ORDER BY item.created_at ASC NULLS LAST, item.id ASC
    LIMIT 1
  ), recurrence AS (
    SELECT min(candidate_at) AS recurred_at FROM (
      SELECT later_item.first_occurred_at AS candidate_at
      FROM root_item CROSS JOIN recovered
      JOIN recovery_items later_item ON later_item.org_id = $1
        AND later_item.id <> root_item.id
        AND later_item.error_signature = root_item.error_signature
      JOIN dead_letters later_dlq ON later_dlq.org_id = later_item.org_id
        AND later_dlq.id = later_item.dead_letter_id
      JOIN runs later_run ON later_run.org_id = later_item.org_id
        AND later_run.id = later_dlq.run_id
      WHERE later_item.first_occurred_at > recovered.recovered_at
        AND later_item.first_occurred_at <= recovered.recovered_at + interval '7 days'
        AND later_run.replay_mode IS NULL

      UNION ALL

      SELECT child.occurred_at AS candidate_at
      FROM root_item CROSS JOIN recovered
      JOIN recovery_item_children child ON child.org_id = $1
        AND child.recovery_item_id = root_item.id
      JOIN dead_letters child_dlq ON child_dlq.org_id = child.org_id
        AND child_dlq.id = child.dead_letter_id
      JOIN runs child_run ON child_run.org_id = child.org_id
        AND child_run.id = child_dlq.run_id
      WHERE child.occurred_at > recovered.recovered_at
        AND child.occurred_at <= recovered.recovered_at + interval '7 days'
        AND child_run.replay_mode IS NULL
    ) candidates
  )
  SELECT
    latest.id AS latest_dead_letter_id,
    latest.status AS latest_status,
    (SELECT count(*)::int FROM chain) AS attempt_count,
    (SELECT count(*) > 100 FROM chain_scan) AS chain_capped,
    (SELECT min(replay_started_at) FROM chain) AS replay_started_at,
    recovered.recovered_at,
    recovered.recovered_by,
    accepted_item.accepted_at AS accepted_item_at,
    accepted_item.accepted_by AS accepted_item_by,
    accepted_audit.accepted_at AS accepted_audit_at,
    accepted_audit.accepted_by AS accepted_audit_by,
    recurrence.recurred_at
  FROM latest
  LEFT JOIN recovered ON true
  LEFT JOIN accepted_item ON true
  LEFT JOIN accepted_audit ON true
  LEFT JOIN recurrence ON true
) facts ON root.id IS NOT NULL
ORDER BY drill.run_created_at DESC, drill.run_id DESC`

type recoveryValidationRow struct {
	RunID, PackID, FixtureID, FailureMode, RecoveryPath string
	RunCreatedAt                                        time.Time
	SampleCapped                                        bool
	RootDeadLetterID, RootStatus                        *string
	RootCreatedAt                                       *time.Time
	LatestDeadLetterID, LatestStatus                    *string
	AttemptCount                                        *int32
	ChainCapped                                         *bool
	ReplayStartedAt, RecoveredAt                        *time.Time
	RecoveredBy                                         *string
	AcceptedItemAt                                      *time.Time
	AcceptedItemBy                                      *string
	AcceptedAuditAt                                     *time.Time
	AcceptedAuditBy                                     *string
	RecurredAt                                          *time.Time
}

func validationResolutionMode(actor *string) recovery.ValidationResolutionMode {
	if actor == nil || *actor == "" {
		return recovery.ValidationResolutionUnknown
	}
	if *actor == "system" || len(*actor) > 7 && (*actor)[:7] == "system:" {
		return recovery.ValidationResolutionAutomated
	}
	return recovery.ValidationResolutionOperator
}

func validationAcceptedActor(row recoveryValidationRow) *string {
	if row.AcceptedItemAt == nil {
		return row.AcceptedAuditBy
	}
	if row.AcceptedAuditAt == nil {
		return row.AcceptedItemBy
	}
	if row.AcceptedItemAt.Before(*row.AcceptedAuditAt) || row.AcceptedItemAt.Equal(*row.AcceptedAuditAt) {
		return row.AcceptedItemBy
	}
	return row.AcceptedAuditBy
}

func (s *V1Server) queryRecoveryValidation(
	ctx context.Context,
	orgID string,
	requestedWindowDays int,
	now time.Time,
) (recovery.RecoveryValidationReport, error) {
	windowDays := min(90, max(1, requestedWindowDays))
	since := now.Add(-time.Duration(windowDays) * 24 * time.Hour)
	rows, err := s.pool.Query(ctx, recoveryValidationSQL, orgID, since)
	if err != nil {
		return recovery.RecoveryValidationReport{}, err
	}
	defer rows.Close()

	samples := make([]recovery.RecoveryValidationSample, 0, recovery.RecoveryValidationSampleLimit)
	sampleCapped := false
	for rows.Next() {
		var row recoveryValidationRow
		if err := rows.Scan(
			&row.RunID, &row.RunCreatedAt, &row.PackID, &row.FixtureID, &row.FailureMode, &row.RecoveryPath,
			&row.SampleCapped, &row.RootDeadLetterID, &row.RootCreatedAt, &row.RootStatus,
			&row.LatestDeadLetterID, &row.LatestStatus, &row.AttemptCount, &row.ChainCapped,
			&row.ReplayStartedAt, &row.RecoveredAt, &row.RecoveredBy,
			&row.AcceptedItemAt, &row.AcceptedItemBy, &row.AcceptedAuditAt, &row.AcceptedAuditBy,
			&row.RecurredAt,
		); err != nil {
			return recovery.RecoveryValidationReport{}, err
		}
		sampleCapped = sampleCapped || row.SampleCapped
		var outcome *recovery.DrillOutcome
		if row.RootDeadLetterID != nil && row.RootStatus != nil && row.LatestDeadLetterID != nil && row.LatestStatus != nil {
			attemptCount := 0
			if row.AttemptCount != nil {
				attemptCount = int(*row.AttemptCount)
			}
			chainCapped := row.ChainCapped != nil && *row.ChainCapped
			value := recovery.BuildRecoveryDrillOutcome(recovery.DrillOutcomeFacts{
				RootCreatedAt: row.RootCreatedAt, RootStatus: *row.RootStatus,
				LatestDeadLetterID: *row.LatestDeadLetterID, LatestStatus: *row.LatestStatus,
				AttemptCount: attemptCount, ChainCapped: chainCapped,
				ReplayStartedAt: row.ReplayStartedAt, RecoveredAt: row.RecoveredAt,
				AcceptedItemAt: row.AcceptedItemAt, AcceptedAuditAt: row.AcceptedAuditAt,
				RecurredAt: row.RecurredAt,
			}, now)
			outcome = &value
		}
		var actor *string
		if outcome != nil {
			switch outcome.Status {
			case "recovered":
				actor = row.RecoveredBy
			case "accepted_loss":
				actor = validationAcceptedActor(row)
			}
		}
		samples = append(samples, recovery.RecoveryValidationSample{
			RunID: row.RunID, RunCreatedAt: row.RunCreatedAt.UTC().Format("2006-01-02T15:04:05.000Z"),
			PackID: row.PackID, FixtureID: row.FixtureID, FailureMode: row.FailureMode,
			RecoveryPath: row.RecoveryPath, ResolutionMode: validationResolutionMode(actor), Outcome: outcome,
		})
	}
	if err := rows.Err(); err != nil {
		return recovery.RecoveryValidationReport{}, err
	}
	return recovery.BuildRecoveryValidationReport(samples, windowDays, now, sampleCapped), nil
}

func recoveryValidationWindow(r *http.Request) int {
	windowDays := 30
	if raw := r.URL.Query().Get("windowDays"); raw != "" {
		var parsed int
		if _, err := fmt.Sscan(raw, &parsed); err == nil {
			windowDays = parsed
		}
	}
	return min(90, max(1, windowDays))
}

func (s *V1Server) recoveryValidationCore(r *http.Request, rc v1Request) opResult {
	report, err := s.queryRecoveryValidation(r.Context(), rc.orgID, recoveryValidationWindow(r), time.Now().UTC())
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	return opOK(report)
}

// drillDossierCore retains the backward-compatible alias while serving the
// same bounded report as the recovery-validation route.
func (s *V1Server) drillDossierCore(r *http.Request, rc v1Request) opResult {
	return s.recoveryValidationCore(r, rc)
}

func (s *V1Server) mountDrillRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /recovery/drills/outcome", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeUnversioned(w, s.drillOutcomeCore(r, rc))
	}))
	mux.HandleFunc("GET /recovery/drills/dossier", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeUnversioned(w, s.drillDossierCore(r, rc))
	}))
	s.route(mux, "GET /recovery/validation", routeGate{role: "viewer", permission: "reports.read"}, func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeUnversioned(w, s.recoveryValidationCore(r, rc))
	})
}

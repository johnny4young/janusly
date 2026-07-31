// Measured Recovery Drill outcomes: GET /recovery/drills/outcome reads
// one drill's truthful projection (pure composition over durable facts);
// GET /recovery/drills/dossier is the bounded per-org validation dossier
// (the JSON payload IS the export). The chain CTE lives here as raw SQL —
// sqlc's analyzer cannot type the materialized chain, and the query is a
// single read (the memory substrate set the raw-read precedent).
package httpapi

import (
	"context"
	"net/http"
	"time"

	"github.com/johnny4young/janusly/go/internal/recovery"
	"github.com/johnny4young/janusly/go/internal/store"
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
    AND item.resolved_at IS NOT NULL AND item.dead_letter_id IN (SELECT id FROM chain)
), accepted_audit AS (
  SELECT min(a.created_at) AS accepted_at FROM audit_logs a
  WHERE a.org_id = $1 AND a.action = 'dlq.resolved' AND a.target_type = 'dlq'
    AND a.target_id IN (SELECT id FROM chain)
), root_item AS (
  SELECT item.id, item.error_signature FROM recovery_items item
  WHERE item.org_id = $1 AND item.error_signature IS NOT NULL
    AND item.dead_letter_id IN (SELECT id FROM chain)
  ORDER BY item.created_at ASC NULLS LAST, item.id ASC LIMIT 1
), recurrence AS (
  SELECT min(later_item.first_occurred_at) AS recurred_at
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

// drillDossierCore lists the org's measured drill outcomes (bounded to
// the 50 most recent roots with replay activity) — the validation
// dossier; this JSON payload doubles as the export.
func (s *V1Server) drillDossierCore(r *http.Request, rc v1Request) opResult {
	roots, err := store.New(s.pool).ListDrillRootDeadLetters(r.Context(), rc.orgID)
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}
	entries := make([]map[string]any, 0, len(roots))
	summary := map[string]int{}
	for _, rootID := range roots {
		outcome, err := s.queryDrillOutcome(r.Context(), rc.orgID, rootID)
		if err != nil {
			continue
		}
		summary[outcome.Status]++
		entries = append(entries, map[string]any{"deadLetterId": rootID, "outcome": outcome})
	}
	return opOK(map[string]any{
		"generatedAt": time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
		"summary":     summary, "drills": entries,
	})
}

func (s *V1Server) mountDrillRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /recovery/drills/outcome", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeLegacy(w, s.drillOutcomeCore(r, rc))
	}))
	mux.HandleFunc("GET /recovery/drills/dossier", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeLegacy(w, s.drillDossierCore(r, rc))
	}))
}

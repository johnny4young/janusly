// Operator routes for the supervised auto-healing decision ledger
// (reference apps/api/src/routes/auto-healing-routes.ts) plus the
// cron-observability schedule-history heatmap. The scanner (engine
// sweep) proposes + validates; every APPLY stays an operator decision —
// CAS on status `validated` so a raced sibling click loses with 409.
package httpapi

import (
	"encoding/json"
	"errors"
	"maps"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/go/internal/audit"
	"github.com/johnny4young/janusly/go/internal/cron"
	"github.com/johnny4young/janusly/go/internal/domain"
	"github.com/johnny4young/janusly/go/internal/engine"
	"github.com/johnny4young/janusly/go/internal/store"
)

func autoHealingRunView(row store.AutoHealingRun, autonomy domain.TechnicalRecoveryAutonomyAssessment) map[string]any {
	var patch any
	_ = json.Unmarshal(row.ProposedPatchJson, &patch)
	var metadata any
	_ = json.Unmarshal(row.Metadata, &metadata)
	return map[string]any{
		"id": row.ID, "deadLetterId": row.DeadLetterID, "signature": row.Signature,
		"status": row.Status, "proposedPatch": patch,
		"approachLabel":           textOrNull(row.ApproachLabel),
		"confidence":              row.Confidence.Int32,
		"validationRunId":         textOrNull(row.ValidationRunID),
		"validationEvidenceLevel": textOrNull(row.ValidationEvidenceLevel),
		"autonomyAssessment":      autonomy,
		"loopAttemptCount":        row.LoopAttemptCount,
		"metadata":                metadata,
		"createdAt":               isoMillis(row.CreatedAt), "updatedAt": isoMillis(row.UpdatedAt),
	}
}

func (s *V1Server) mountAutoHealingRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /auto-healing/pending", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		limit := int32(100)
		if raw := r.URL.Query().Get("limit"); raw != "" {
			if parsed, err := parsePositiveInt(raw, 200); err == nil {
				limit = int32(parsed)
			}
		}
		q := store.New(s.pool)
		rows, err := q.ListPendingAutoHealingRuns(r.Context(), store.ListPendingAutoHealingRunsParams{
			OrgID: rc.orgID, Limit: limit,
		})
		if err != nil {
			writeLegacy(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		assessments, err := assessAutoHealingRows(r.Context(), q, rc.orgID, rows)
		if err != nil {
			writeLegacy(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		views := make([]map[string]any, 0, len(rows))
		for index, row := range rows {
			views = append(views, autoHealingRunView(row, assessments[index]))
		}
		writeLegacy(w, opOK(map[string]any{"rows": views}))
	}))

	mux.HandleFunc("GET /auto-healing/{id}", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		q := store.New(s.pool)
		row, err := q.GetAutoHealingRun(r.Context(), store.GetAutoHealingRunParams{
			OrgID: rc.orgID, ID: r.PathValue("id"),
		})
		if err != nil {
			writeLegacy(w, opError(http.StatusNotFound, "autoheal_not_found", "Not found", nil))
			return
		}
		assessments, err := assessAutoHealingRows(r.Context(), q, rc.orgID, []store.AutoHealingRun{row})
		if err != nil {
			writeLegacy(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		writeLegacy(w, opOK(map[string]any{"row": autoHealingRunView(row, assessments[0])}))
	}))

	mux.HandleFunc("POST /auto-healing/{id}/decide", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		var body struct {
			Accepted                  *bool  `json:"accepted"`
			AcknowledgeValidationRisk bool   `json:"acknowledgeValidationRisk"`
			Comment                   string `json:"comment"`
		}
		if err := decodeBody(r, &body); err != nil || body.Accepted == nil || len(body.Comment) > 2000 {
			writeLegacy(w, opError(http.StatusBadRequest, "autoheal_invalid_body", "invalid body", nil))
			return
		}
		q := store.New(s.pool)
		row, err := q.GetAutoHealingRun(r.Context(), store.GetAutoHealingRunParams{
			OrgID: rc.orgID, ID: r.PathValue("id"),
		})
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				writeLegacy(w, opError(http.StatusNotFound, "autoheal_not_found", "Not found", nil))
				return
			}
			writeLegacy(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		if row.Status != "validated" {
			writeLegacy(w, opError(http.StatusConflict, "autoheal_not_pending",
				"Auto-healing row is not pending a decision", nil))
			return
		}

		if !*body.Accepted {
			declined, err := q.DecideAutoHealingRun(r.Context(), store.DecideAutoHealingRunParams{
				OrgID: rc.orgID, ID: row.ID, Status: "declined",
				DecisionActor: pgtype.Text{String: rc.userID, Valid: true},
				DeclineReason: pgtype.Text{String: "manual_review", Valid: true},
			})
			if err != nil || declined == 0 {
				writeLegacy(w, opError(http.StatusConflict, "autoheal_already_resolved",
					"Auto-healing row was already resolved", nil))
				return
			}
			audit.Write(r.Context(), s.pool, rc.authContext, "auto_healing.decline.manual", audit.Options{
				TargetType: "auto_healing_run", TargetID: row.ID,
				Metadata: map[string]any{"decisionActor": rc.userID},
			})
			writeLegacy(w, opOK(map[string]any{"ok": true, "accepted": false}))
			return
		}

		// Sandbox evidence that never exercised writes needs an explicit
		// risk acknowledgement before production apply — the pilot's
		// validation runs are born "static" (write sides skipped), so both
		// labels demand the ack; only write-proving evidence skips it.
		evidence := textOrNull(row.ValidationEvidenceLevel)
		if (evidence == nil || evidence == "writes_skipped" || evidence == "static") && !body.AcknowledgeValidationRisk {
			writeLegacy(w, opError(http.StatusConflict, "autoheal_validation_risk_ack_required",
				"Validation did not prove external writes; explicit acknowledgement is required", nil))
			return
		}
		accepted, err := q.DecideAutoHealingRun(r.Context(), store.DecideAutoHealingRunParams{
			OrgID: rc.orgID, ID: row.ID, Status: "applied",
			DecisionActor: pgtype.Text{String: rc.userID, Valid: true},
			DeclineReason: pgtype.Text{},
		})
		if err != nil || accepted == 0 {
			writeLegacy(w, opError(http.StatusConflict, "autoheal_already_resolved",
				"Auto-healing row was already resolved", nil))
			return
		}
		// Apply = production redrive of the dead letter with the PATCHED
		// snapshot (the fix-snapshot swap the bulk-recovery path proved).
		var patch map[string]any
		_ = json.Unmarshal(row.ProposedPatchJson, &patch)
		applyError := ""
		if fixed := s.patchedDeadLetterSnapshot(r, rc.orgID, row.DeadLetterID, patch); fixed != nil {
			if err := s.engine.RedriveDeadLetterWithOptions(r.Context(), rc.orgID, row.DeadLetterID,
				redriveFixOptions(fixed, textOrNull(row.ValidationRunID), rc.userID)); err != nil {
				applyError = err.Error()
			}
		} else {
			applyError = "dead letter snapshot unavailable"
		}
		audit.Write(r.Context(), s.pool, rc.authContext, "auto_healing.apply.manual", audit.Options{
			TargetType: "auto_healing_run", TargetID: row.ID,
			Metadata: map[string]any{"decisionActor": rc.userID, "applyError": applyError},
		})
		writeLegacy(w, opOK(map[string]any{
			"ok": applyError == "", "accepted": true, "applyError": applyError,
		}))
	}))

	mux.HandleFunc("POST /auto-healing/scan", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		proposed := s.engine.ScanOrgForHealing(r.Context(), rc.orgID)
		audit.Write(r.Context(), s.pool, rc.authContext, "auto_healing.scan.triggered", audit.Options{
			Metadata: map[string]any{"proposed": proposed},
		})
		writeLegacy(w, opOK(map[string]any{"ok": true, "proposed": proposed}))
	}))

	// Cron-observability heatmap: observed scheduled fires (UTC grid) +
	// the next-fire preview per registered entry.
	mux.HandleFunc("GET /workflows/{workflowId}/schedule-history", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		workflowID := r.PathValue("workflowId")
		q := store.New(s.pool)
		since := time.Now().AddDate(0, 0, -cron.MaxHistoryDays)
		rows, err := q.ListScheduleFireHistory(r.Context(), store.ListScheduleFireHistoryParams{
			WorkflowID: workflowID, OrgID: rc.orgID, CreatedAt: &since,
		})
		if err != nil {
			writeLegacy(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		fires := make([]cron.Fire, 0, len(rows))
		for _, row := range rows {
			at := time.Time{}
			if row.CreatedAt != nil {
				at = *row.CreatedAt
			}
			fires = append(fires, cron.Fire{At: at, Status: row.Status})
		}
		entries, _ := q.ListScheduleEntriesForWorkflow(r.Context(), store.ListScheduleEntriesForWorkflowParams{
			OrgID: rc.orgID, WorkflowID: workflowID,
		})
		previews := make([]map[string]any, 0, len(entries))
		for _, entry := range entries {
			next := cron.NextFires(entry.CronExpression, time.Now(), cron.NextFiresCount)
			fireTimes := make([]string, 0, len(next))
			for _, at := range next {
				fireTimes = append(fireTimes, at.UTC().Format(time.RFC3339))
			}
			previews = append(previews, map[string]any{
				"nodeId": entry.NodeID, "cron": entry.CronExpression,
				"enabled": entry.Enabled, "nextFires": fireTimes,
			})
		}
		writeLegacy(w, opOK(map[string]any{
			"timezone": "UTC", "windowDays": cron.MaxHistoryDays,
			"cells": cron.BuildHeatmap(fires), "totalFires": len(fires),
			"schedules": previews,
		}))
	}))
}

// patchedDeadLetterSnapshot loads the dead letter's workflow snapshot and
// merges the config patch into its failing node.
func (s *V1Server) patchedDeadLetterSnapshot(r *http.Request, orgID, deadLetterID string, patch map[string]any) []byte {
	if len(patch) == 0 {
		return nil
	}
	row, err := store.New(s.pool).GetDeadLetter(r.Context(), store.GetDeadLetterParams{
		OrgID: orgID, ID: deadLetterID,
	})
	if err != nil || len(row.WorkflowJson) == 0 || !strings.Contains(string(row.WorkflowJson), `"nodes"`) {
		return nil
	}
	var document map[string]any
	if err := json.Unmarshal(row.WorkflowJson, &document); err != nil {
		return nil
	}
	nodes, _ := document["nodes"].([]any)
	for _, rawNode := range nodes {
		node, ok := rawNode.(map[string]any)
		if !ok || node["id"] != row.NodeID {
			continue
		}
		config, _ := node["config"].(map[string]any)
		if config == nil {
			config = map[string]any{}
		}
		maps.Copy(config, patch)
		node["config"] = config
		fixed, err := json.Marshal(document)
		if err != nil {
			return nil
		}
		return fixed
	}
	return nil
}

// redriveFixOptions packages the fix-snapshot redrive for an accepted
// auto-healing decision.
func redriveFixOptions(fixed []byte, validationRunID any, requestedBy string) engine.RedriveOptions {
	options := engine.RedriveOptions{FixWorkflowJSON: fixed, RequestedBy: requestedBy}
	if id, ok := validationRunID.(string); ok {
		options.ValidationRunID = id
	}
	return options
}

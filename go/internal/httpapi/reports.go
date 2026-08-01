// Reports — GET /reports/run-explain (the shareable Markdown/JSON
// artefact for one run) and POST /recovery/items/{id}/evidence (the
// downloadable audit-evidence bundle for one incident). Multi-tenant
// gate: the run / item read is org-scoped and a cross-org id returns
// the same 404 as a missing one. Secrets are redacted at write time
// (safe-persist) AND re-scrubbed at render time in the pure builder.
// Delivery (Slack / GitHub / webhook) needs the integrations wave.
package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/go/internal/audit"
	"github.com/johnny4young/janusly/go/internal/engine"
	"github.com/johnny4young/janusly/go/internal/recovery"
	"github.com/johnny4young/janusly/go/internal/signature"
	"github.com/johnny4young/janusly/go/internal/store"
)

// resolveRunExplain loads the org-gated snapshots and builds the report.
func (s *V1Server) resolveRunExplain(ctx context.Context, orgID, runID string) (map[string]any, string, bool) {
	q := store.New(s.pool)
	run, err := q.GetRun(ctx, store.GetRunParams{ID: runID, OrgID: orgID})
	if err != nil {
		return nil, "", false
	}
	nodeRows, err := q.ListRunNodesByRun(ctx, runID)
	if err != nil {
		return nil, "", false
	}
	nodes := make([]recovery.RunExplainNode, 0, len(nodeRows))
	for _, row := range nodeRows {
		node := recovery.RunExplainNode{
			NodeID: row.NodeID, Status: row.Status, Attempts: int(row.Attempts.Int32),
			StartedAt: row.StartedAt, FinishedAt: row.FinishedAt, ErrorJSON: row.ErrorJson,
		}
		var state struct {
			NodeType string `json:"nodeType"`
		}
		_ = json.Unmarshal(row.StateJson, &state)
		node.NodeType = state.NodeType
		nodes = append(nodes, node)
	}
	farFuture := timeFarFuture()
	eventRows, err := q.ListRunEvents(ctx, store.ListRunEventsParams{
		RunID: runID, BeforeCreatedAt: farFuture, BeforeID: "￿", PageLimit: 200,
	})
	if err != nil {
		return nil, "", false
	}
	events := make([]recovery.RunExplainEvent, 0, len(eventRows))
	for _, row := range eventRows {
		events = append(events, recovery.RunExplainEvent{
			NodeID: row.NodeID.String, Type: row.Type, CreatedAt: row.CreatedAt,
		})
	}
	var auditSnapshot *recovery.RunExplainAudit
	if auditRow, err := q.FindLatestPatchAuditForRun(ctx, store.FindLatestPatchAuditForRunParams{
		OrgID: orgID, RunID: runID,
	}); err == nil {
		auditSnapshot = &recovery.RunExplainAudit{CreatedAt: auditRow.CreatedAt, Metadata: auditRow.Metadata}
	}
	report, markdown := recovery.BuildRunExplainReport(recovery.RunExplainRun{
		ID: run.ID, Status: run.Status,
		WorkflowVersionID:       run.WorkflowVersionID,
		ParentRunID:             run.ParentRunID.String,
		ReplayMode:              run.ReplayMode.String,
		ValidationEvidenceLevel: run.ValidationEvidenceLevel.String,
		CreatedAt:               run.CreatedAt,
	}, nodes, events, auditSnapshot, time.Now())
	return report, markdown, true
}

func reportAttachmentName(prefix, id, status, format string) string {
	short := id
	if len(short) > 8 {
		short = short[:8]
	}
	extension := "md"
	if format == "json" {
		extension = "json"
	}
	return fmt.Sprintf("%s-%s-%s.%s", prefix, short, status, extension)
}

func (s *V1Server) runExplainHandler(w http.ResponseWriter, r *http.Request, rc v1Request) {
	runID := r.URL.Query().Get("runId")
	format := strings.ToLower(r.URL.Query().Get("format"))
	if format == "" {
		format = "markdown"
	}
	if runID == "" {
		writeLegacy(w, opError(http.StatusBadRequest, "reports_run_id_required", "runId is required", nil))
		return
	}
	if format != "markdown" && format != "json" {
		writeLegacy(w, opError(http.StatusBadRequest, "reports_unknown_format",
			"Unknown format. Use \"markdown\" or \"json\".", map[string]any{"format": format}))
		return
	}
	report, markdown, ok := s.resolveRunExplain(r.Context(), rc.orgID, runID)
	if !ok {
		writeLegacy(w, opError(http.StatusNotFound, "reports_run_not_found", "Run not found", nil))
		return
	}
	audit.Write(r.Context(), s.pool, rc.authContext, "report.run_explain.exported", audit.Options{
		TargetType: "run", TargetID: runID, Metadata: map[string]any{"format": format},
	})
	status, _ := report["summary"].(map[string]any)["status"].(string)
	filename := reportAttachmentName("run-explain", runID, status, format)
	w.Header().Set("Content-Disposition", "attachment; filename=\""+filename+"\"")
	w.Header().Set("Access-Control-Expose-Headers", "Content-Disposition, X-Request-Id")
	if format == "json" {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(report)
		return
	}
	w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
	_, _ = w.Write([]byte(markdown))
}

// recoveryEvidenceCore assembles the single downloadable audit-evidence
// artefact for one incident: the incident, its dead letter, the original
// run's explain report, the freshest validation replay, and the audit
// trail scoped to (runId, deadLetterId, recoveryItemId).
func (s *V1Server) recoveryEvidenceHandler(w http.ResponseWriter, r *http.Request, rc v1Request) {
	id := r.PathValue("id")
	format := strings.ToLower(r.URL.Query().Get("format"))
	if format == "" {
		format = "json"
	}
	if format != "markdown" && format != "json" {
		writeLegacy(w, opError(http.StatusBadRequest, "recovery_evidence_unknown_format",
			"Unknown format. Use \"markdown\" or \"json\".", map[string]any{"format": format}))
		return
	}
	q := store.New(s.pool)
	item, err := q.GetRecoveryItemByID(r.Context(), store.GetRecoveryItemByIDParams{OrgID: rc.orgID, ID: id})
	if err != nil {
		writeLegacy(w, opError(http.StatusNotFound, "recovery_item_not_found", "not found", nil))
		return
	}
	incident := recoveryItemView(item)
	targets := []string{id, item.DeadLetterID}

	var deadLetterBlock map[string]any
	runID := ""
	if deadLetter, err := q.GetDeadLetter(r.Context(), store.GetDeadLetterParams{
		ID: item.DeadLetterID, OrgID: rc.orgID,
	}); err == nil {
		runID = deadLetter.RunID
		targets = append(targets, deadLetter.RunID)
		var payload struct {
			Message string `json:"message"`
		}
		_ = json.Unmarshal(deadLetter.ErrorJson, &payload)
		deadLetterBlock = map[string]any{
			"id": deadLetter.ID, "runId": deadLetter.RunID, "nodeId": deadLetter.NodeID,
			"attempt": deadLetter.Attempt, "status": deadLetter.Status,
			"errorSummary": signature.ScrubSecretShapes(payload.Message),
			"signature":    engine.DeadLetterSignature(deadLetter),
			"createdAt":    timeOrNull(deadLetter.CreatedAt),
		}
	}

	var runReport any
	if runID != "" {
		if report, _, ok := s.resolveRunExplain(r.Context(), rc.orgID, runID); ok {
			runReport = report
		}
	}
	var validationBlock map[string]any
	if runID != "" {
		if validation, err := q.FindLatestValidationRunForParent(r.Context(), store.FindLatestValidationRunForParentParams{
			OrgID: rc.orgID, ParentRunID: pgtype.Text{String: runID, Valid: true},
		}); err == nil {
			validationBlock = map[string]any{
				"runId": validation.ID, "status": validation.Status,
				"evidenceLevel": validation.ValidationEvidenceLevel.String,
				"createdAt":     timeOrNull(validation.CreatedAt),
			}
		}
	}
	auditRows, _ := q.ListAuditRowsForTargets(r.Context(), store.ListAuditRowsForTargetsParams{
		OrgID: rc.orgID, TargetIds: targets,
	})
	trail := make([]map[string]any, 0, len(auditRows))
	for _, row := range auditRows {
		trail = append(trail, map[string]any{
			"action": row.Action, "targetType": textOrNull(row.TargetType),
			"targetId": textOrNull(row.TargetID), "actor": textOrNull(row.UserID),
			"at": timeOrNull(row.CreatedAt),
		})
	}
	report := map[string]any{
		"generatedAt": time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
		"incident":    incident, "deadLetter": deadLetterBlock,
		"originalRun": runReport, "validationRun": validationBlock,
		"auditTrail": trail,
	}
	audit.Write(r.Context(), s.pool, rc.authContext, "report.evidence.exported", audit.Options{
		TargetType: "recovery-item", TargetID: id,
		Metadata: map[string]any{
			"format": format, "deadLetterId": item.DeadLetterID,
			"runId": runID, "auditRowCount": len(trail),
		},
	})
	filename := reportAttachmentName("evidence", id, "evidence-"+item.Status, format)
	w.Header().Set("Content-Disposition", "attachment; filename=\""+filename+"\"")
	w.Header().Set("Access-Control-Expose-Headers", "Content-Disposition, X-Request-Id")
	if format == "json" {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(report)
		return
	}
	w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
	_, _ = w.Write([]byte(renderEvidenceMarkdown(report)))
}

func renderEvidenceMarkdown(report map[string]any) string {
	incident := report["incident"].(map[string]any)
	var lines []string
	push := func(line string) { lines = append(lines, line) }
	push(fmt.Sprintf("# Incident Evidence — %s", incident["id"]))
	push("")
	push(fmt.Sprintf("> Generated %s", report["generatedAt"]))
	push("")
	push("## Incident")
	push(fmt.Sprintf("- **Status:** %v", incident["status"]))
	push(fmt.Sprintf("- **Severity:** %v", incident["severity"]))
	push(fmt.Sprintf("- **Owner:** %v", incident["owner"]))
	push(fmt.Sprintf("- **Resolution:** %v", incident["resolutionReason"]))
	push("")
	if deadLetter, ok := report["deadLetter"].(map[string]any); ok && deadLetter != nil {
		push("## Dead letter")
		push(fmt.Sprintf("- **Id:** `%v`", deadLetter["id"]))
		push(fmt.Sprintf("- **Run:** `%v` node `%v` attempt %v", deadLetter["runId"], deadLetter["nodeId"], deadLetter["attempt"]))
		push(fmt.Sprintf("- **Status:** %v", deadLetter["status"]))
		push(fmt.Sprintf("- **Signature:** %v", deadLetter["signature"]))
		push("")
	}
	if validation, ok := report["validationRun"].(map[string]any); ok && validation != nil {
		push("## Sandbox validation")
		push(fmt.Sprintf("- **Run:** `%v` — %v (evidence: %v)", validation["runId"], validation["status"], validation["evidenceLevel"]))
		push("")
	}
	if trail, ok := report["auditTrail"].([]map[string]any); ok {
		push("## Audit trail")
		for _, row := range trail {
			push(fmt.Sprintf("- %v — **%v** %v `%v`", row["at"], row["action"], row["targetType"], row["targetId"]))
		}
		push("")
	}
	return strings.Join(lines, "\n")
}

func (s *V1Server) mountReportRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /reports/run-explain", s.auth(s.runExplainHandler))
	mux.HandleFunc("POST /recovery/items/{id}/evidence", s.auth(s.recoveryEvidenceHandler))
}

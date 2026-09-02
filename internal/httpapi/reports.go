// Reports — run explain, controlled-drill validation, and incident evidence.
// Every export is tenant scoped and shares its pure builder with the matching
// in-product projection. Secrets are redacted at write time (safe-persist)
// AND re-scrubbed at render time. Delivery routes Slack / GitHub / webhook
// through the same integration chokepoint as workflow tool nodes.
package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/internal/audit"
	"github.com/johnny4young/janusly/internal/engine"
	"github.com/johnny4young/janusly/internal/ratelimit"
	"github.com/johnny4young/janusly/internal/recovery"
	"github.com/johnny4young/janusly/internal/signature"
	"github.com/johnny4young/janusly/internal/store"
)

const (
	reportsDeliverRateLimitPerMin = 60
	reportSlackTextMax            = 3000
)

type reportDeliveryDestination struct {
	Kind           string   `json:"kind"`
	CredentialName string   `json:"credentialName"`
	Owner          string   `json:"owner"`
	Repo           string   `json:"repo"`
	Labels         []string `json:"labels"`
	URL            string   `json:"url"`
}

type reportDeliveryRequest struct {
	RunID       string                    `json:"runId"`
	Destination reportDeliveryDestination `json:"destination"`
}

func validateReportDeliveryRequest(body reportDeliveryRequest) string {
	if strings.TrimSpace(body.RunID) == "" {
		return "runId is required"
	}
	destination := body.Destination
	if destination.Kind != "slack" && destination.Kind != "github" && destination.Kind != "webhook" {
		return "destination.kind must be slack, github, or webhook"
	}
	if strings.TrimSpace(destination.CredentialName) == "" {
		return "destination.credentialName is required"
	}
	if destination.Kind == "github" {
		if strings.TrimSpace(destination.Owner) == "" {
			return "destination.owner is required for github destination"
		}
		if strings.TrimSpace(destination.Repo) == "" {
			return "destination.repo is required for github destination"
		}
		if len(destination.Labels) > 10 {
			return "destination.labels must contain at most 10 labels"
		}
		for _, label := range destination.Labels {
			if strings.TrimSpace(label) == "" {
				return "destination.labels must not contain empty labels"
			}
		}
	}
	if destination.Kind == "webhook" {
		parsed, err := url.ParseRequestURI(destination.URL)
		if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
			return "destination.url must be an absolute http(s) URL"
		}
	}
	return ""
}

func buildRunExplainSlackText(report map[string]any, workflowName, runID string) string {
	summary, _ := report["summary"].(map[string]any)
	status, _ := summary["status"].(string)
	if workflowName == "" {
		workflowName = "(ad-hoc workflow)"
	}
	shortID := runID
	if len(shortID) > 8 {
		shortID = shortID[:8]
	}
	lines := []string{fmt.Sprintf("*Janusly run explain: %s – %s – %s*", workflowName, status, shortID)}
	if root, ok := report["rootCause"].(map[string]any); ok {
		lines = append(lines, fmt.Sprintf("Root cause: %v (%v)", root["signature"], root["category"]))
	}
	if failed, ok := report["failedNode"].(map[string]any); ok {
		lines = append(lines, fmt.Sprintf("Failed node: %v — %v", failed["nodeId"], failed["errorSummary"]))
	}
	if next, ok := report["nextAction"].(string); ok && next != "" {
		lines = append(lines, "Next action: "+next)
	}
	if publicBase := strings.TrimSpace(os.Getenv("JANUSLY_PUBLIC_APP_URL")); publicBase != "" {
		lines = append(lines, "Full report: "+strings.TrimRight(publicBase, "/")+
			"/reports/run-explain?runId="+url.QueryEscape(runID))
	}
	text := strings.Join(lines, "\n")
	if len(text) > reportSlackTextMax {
		return text[:reportSlackTextMax-3] + "…"
	}
	return text
}

func buildRunExplainGitHubTitle(workflowName, runStatus, runID string) string {
	if workflowName == "" {
		workflowName = "(ad-hoc workflow)"
	}
	shortID := runID
	if len(shortID) > 8 {
		shortID = shortID[:8]
	}
	return fmt.Sprintf("Janusly run explain: %s – %s (%s)", workflowName, runStatus, shortID)
}

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

func recoveryValidationFilename(orgID string, report recovery.RecoveryValidationReport, format string) string {
	shortOrg := orgID
	if len(shortOrg) > 8 {
		shortOrg = shortOrg[:8]
	}
	var slug strings.Builder
	lastDash := false
	for _, char := range strings.ToLower(shortOrg) {
		valid := char >= 'a' && char <= 'z' || char >= '0' && char <= '9'
		if valid {
			slug.WriteRune(char)
			lastDash = false
		} else if slug.Len() > 0 && !lastDash {
			slug.WriteByte('-')
			lastDash = true
		}
	}
	orgSlug := strings.Trim(slug.String(), "-")
	if orgSlug == "" {
		orgSlug = "org"
	}
	date := report.GeneratedAt
	if len(date) > 10 {
		date = date[:10]
	}
	extension := "md"
	if format == "json" {
		extension = "json"
	}
	return fmt.Sprintf("janusly-recovery-validation-%s-%s-%dd.%s", orgSlug, date, report.WindowDays, extension)
}

func (s *V1Server) recoveryValidationReportHandler(w http.ResponseWriter, r *http.Request, rc v1Request) {
	format := strings.ToLower(r.URL.Query().Get("format"))
	if format == "" {
		format = "markdown"
	}
	if format != "markdown" && format != "json" {
		writeUnversioned(w, opError(http.StatusBadRequest, "reports_unknown_format",
			"Unknown format. Use \"markdown\" or \"json\".", map[string]any{"format": format}))
		return
	}
	report, err := s.queryRecoveryValidation(
		r.Context(), rc.orgID, recoveryValidationWindow(r), time.Now().UTC(),
	)
	if err != nil {
		writeUnversioned(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
		return
	}
	audit.Write(r.Context(), s.pool, rc.authContext, "report.recovery_validation.exported", audit.Options{
		TargetType: "org", TargetID: rc.orgID,
		Metadata: map[string]any{
			"format": format, "windowDays": report.WindowDays,
			"drills": report.Totals.Drills, "sampleCapped": report.SampleCapped,
		},
	})
	filename := recoveryValidationFilename(rc.orgID, report, format)
	w.Header().Set("Content-Disposition", "attachment; filename=\""+filename+"\"; filename*=UTF-8''"+url.PathEscape(filename))
	w.Header().Set("Access-Control-Expose-Headers", "Content-Disposition, X-Request-Id")
	if format == "json" {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"scope": map[string]any{
				"orgId": rc.orgID, "evidence": "controlled_recovery_drills",
				"limitations": []string{"external_partner_count", "setup_time", "willingness_to_pay"},
			},
			"report": report,
		})
		return
	}
	w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
	_, _ = w.Write([]byte(recovery.BuildRecoveryValidationMarkdown(rc.orgID, report)))
}

func (s *V1Server) runExplainHandler(w http.ResponseWriter, r *http.Request, rc v1Request) {
	runID := r.URL.Query().Get("runId")
	format := strings.ToLower(r.URL.Query().Get("format"))
	if format == "" {
		format = "markdown"
	}
	if runID == "" {
		writeUnversioned(w, opError(http.StatusBadRequest, "reports_run_id_required", "runId is required", nil))
		return
	}
	if format != "markdown" && format != "json" {
		writeUnversioned(w, opError(http.StatusBadRequest, "reports_unknown_format",
			"Unknown format. Use \"markdown\" or \"json\".", map[string]any{"format": format}))
		return
	}
	report, markdown, ok := s.resolveRunExplain(r.Context(), rc.orgID, runID)
	if !ok {
		writeUnversioned(w, opError(http.StatusNotFound, "reports_run_not_found", "Run not found", nil))
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

func (s *V1Server) runExplainDeliveryHandler(w http.ResponseWriter, r *http.Request, rc v1Request) {
	var body reportDeliveryRequest
	if err := decodeBody(r, &body); err != nil {
		writeUnversioned(w, opError(http.StatusBadRequest, "reports_invalid_request", "Invalid request: body", nil))
		return
	}
	if message := validateReportDeliveryRequest(body); message != "" {
		writeUnversioned(w, opError(http.StatusBadRequest, "reports_invalid_request", "Invalid request: "+message, nil))
		return
	}
	destination := body.Destination
	auditFormat := "markdown"
	if destination.Kind == "webhook" {
		auditFormat = "json"
	}
	writeDeliveryAudit := func(metadata map[string]any) {
		metadata["destination"] = destination.Kind
		metadata["format"] = auditFormat
		metadata["runId"] = body.RunID
		metadata["credentialName"] = destination.CredentialName
		audit.Write(r.Context(), s.pool, rc.authContext, "report.run_explain.delivered", audit.Options{
			TargetType: "run", TargetID: body.RunID, Metadata: metadata,
		})
	}
	if err := s.limiter.Enforce(r.Context(), rc.orgID, ratelimit.Options{
		Name: "reports.deliver", Max: reportsDeliverRateLimitPerMin, Window: time.Minute,
	}); err != nil {
		writeDeliveryAudit(map[string]any{
			"ok": false, "error": "rate_limit_exceeded", "latencyMs": 0,
			"workflowId": nil, "workflowName": nil, "runStatus": nil,
		})
		writeUnversioned(w, opError(http.StatusTooManyRequests, "reports_rate_limit_exceeded", err.Error(), nil))
		return
	}

	q := store.New(s.pool)
	run, err := q.GetRun(r.Context(), store.GetRunParams{ID: body.RunID, OrgID: rc.orgID})
	if err != nil {
		writeUnversioned(w, opError(http.StatusNotFound, "reports_run_not_found", "Run not found", nil))
		return
	}
	report, markdown, ok := s.resolveRunExplain(r.Context(), rc.orgID, body.RunID)
	if !ok {
		writeUnversioned(w, opError(http.StatusNotFound, "reports_run_not_found", "Run not found", nil))
		return
	}
	var snapshot struct {
		Workflow struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"workflow"`
	}
	_ = json.Unmarshal(run.InputJson, &snapshot)

	toolName := "slack.post"
	toolInput := map[string]any{
		"credential": destination.CredentialName,
		"text":       buildRunExplainSlackText(report, snapshot.Workflow.Name, body.RunID),
	}
	switch destination.Kind {
	case "github":
		toolName = "github.create_issue"
		toolInput = map[string]any{
			"credential": destination.CredentialName,
			"owner":      destination.Owner,
			"repo":       destination.Repo,
			"title":      buildRunExplainGitHubTitle(snapshot.Workflow.Name, run.Status, body.RunID),
			"body":       markdown,
		}
		if len(destination.Labels) > 0 {
			toolInput["labels"] = destination.Labels
		}
	case "webhook":
		toolName = "webhook.send"
		toolInput = map[string]any{
			"credential": destination.CredentialName,
			"url":        destination.URL,
			"payload":    report,
		}
	}
	outcome := s.engine.ExecuteIntegrationTool(r.Context(), rc.orgID, body.RunID, toolName, toolInput)
	result := map[string]any{
		"ok": outcome["ok"] == true, "destination": destination.Kind,
		"latencyMs": numberOrZero(outcome["latencyMs"]),
	}
	for _, key := range []string{"statusCode", "error"} {
		if value, present := outcome[key]; present {
			result[key] = value
		}
	}
	if issueURL, ok := outcome["url"].(string); ok && issueURL != "" {
		result["deliveryId"] = issueURL
	}
	auditMetadata := map[string]any{
		"ok": result["ok"], "latencyMs": result["latencyMs"],
		"workflowId": nilIfBlank(snapshot.Workflow.ID), "workflowName": nilIfBlank(snapshot.Workflow.Name),
		"runStatus": run.Status,
	}
	for _, key := range []string{"statusCode", "error"} {
		if value, present := result[key]; present {
			auditMetadata[key] = value
		}
	}
	writeDeliveryAudit(auditMetadata)
	writeUnversioned(w, opOK(result))
}

func numberOrZero(value any) any {
	switch value.(type) {
	case int, int32, int64, float32, float64:
		return value
	default:
		return 0
	}
}

func nilIfBlank(value string) any {
	if value == "" {
		return nil
	}
	return value
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
		writeUnversioned(w, opError(http.StatusBadRequest, "recovery_evidence_unknown_format",
			"Unknown format. Use \"markdown\" or \"json\".", map[string]any{"format": format}))
		return
	}
	q := store.New(s.pool)
	item, err := q.GetRecoveryItemByID(r.Context(), store.GetRecoveryItemByIDParams{OrgID: rc.orgID, ID: id})
	if err != nil {
		writeUnversioned(w, opError(http.StatusNotFound, "recovery_item_not_found", "not found", nil))
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
	mux.HandleFunc("GET /v1/reports/run-explain", s.auth(s.runExplainHandler))
	s.route(mux, "GET /reports/recovery-validation", routeGate{role: "viewer", permission: "reports.read"}, s.recoveryValidationReportHandler)
	mux.HandleFunc("POST /reports/run-explain/deliver", s.auth(s.runExplainDeliveryHandler))
	mux.HandleFunc("POST /recovery/items/{id}/evidence", s.auth(s.recoveryEvidenceHandler))
	mux.HandleFunc("GET /reports/value-dashboard", s.auth(s.valueDashboardReportHandler))
}

func (s *V1Server) valueDashboardReportHandler(w http.ResponseWriter, r *http.Request, rc v1Request) {
	format := strings.ToLower(r.URL.Query().Get("format"))
	if format == "" {
		format = "markdown"
	}
	if format != "markdown" && format != "json" {
		writeUnversioned(w, opError(http.StatusBadRequest, "invalid_format",
			`Unknown format. Use "markdown" or "json".`, map[string]any{"format": format}))
		return
	}
	windowDays := 30
	if raw := r.URL.Query().Get("windowDays"); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil {
			windowDays = min(90, max(1, parsed))
		}
	}
	metrics, err := s.recoveryMetricsValue(r.Context(), rc.orgID, windowDays)
	if err != nil {
		writeUnversioned(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
		return
	}
	audit.Write(r.Context(), s.pool, rc.authContext, "report.value_dashboard.exported", audit.Options{
		TargetType: "org", TargetID: rc.orgID,
		Metadata: map[string]any{"format": format, "windowDays": windowDays},
	})
	filename := reportAttachmentName("value-dashboard", rc.orgID, fmt.Sprintf("%dd", windowDays), format)
	w.Header().Set("Content-Disposition", "attachment; filename=\""+filename+"\"")
	w.Header().Set("Access-Control-Expose-Headers", "Content-Disposition, X-Request-Id")
	if format == "json" {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"windowDays": windowDays, "metrics": metrics})
		return
	}
	w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
	_, _ = w.Write([]byte(renderValueDashboardMarkdown(windowDays, metrics)))
}

func renderValueDashboardMarkdown(windowDays int, metrics map[string]any) string {
	var builder strings.Builder
	fmt.Fprintf(&builder, "# Janusly value dashboard\n\nWindow: last %d days\n\n", windowDays)
	keys := make([]string, 0, len(metrics))
	for key := range metrics {
		keys = append(keys, key)
	}
	slices.Sort(keys)
	fmt.Fprintln(&builder, "| Metric | Value |")
	fmt.Fprintln(&builder, "| --- | --- |")
	for _, key := range keys {
		fmt.Fprintf(&builder, "| %s | %v |\n", key, metrics[key])
	}
	return builder.String()
}

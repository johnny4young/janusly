// Evidence-gated Recovery Playbooks. Every use re-resolves an exact active
// workflow/signature match, returns only the immutable saved source, and still
// requires a fresh sandbox plus an explicit production apply.
package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"reflect"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/internal/audit"
	"github.com/johnny4young/janusly/internal/auth"
	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/engine"
	"github.com/johnny4young/janusly/internal/signature"
	"github.com/johnny4young/janusly/internal/store"
)

const (
	playbookTitleMaxCodeUnits        = 120
	playbookInstructionsMaxCodeUnits = 4_000
)

func playbookView(row store.RecoveryPlaybook) map[string]any {
	return map[string]any{
		"id": row.ID, "workflowId": textOrNull(row.WorkflowID),
		"signature": row.Signature, "version": row.Version,
		"status": row.Status, "title": row.Title,
		"instructionsMarkdown": row.InstructionsMarkdown,
		"approachLabel":        row.ApproachLabel,
		"successfulUses":       row.SuccessfulUses,
		"regressions":          row.Regressions,
		"lastValidatedAt":      timeOrNull(row.LastValidatedAt),
		"activatedAt":          timeOrNull(row.ActivatedAt),
		"retiredAt":            timeOrNull(row.RetiredAt),
		"createdAt":            timeOrNull(row.CreatedAt),
		"updatedAt":            timeOrNull(row.UpdatedAt),
	}
}

func playbookWorkflowID(raw json.RawMessage) string {
	var snapshot struct {
		ID string `json:"id"`
	}
	if json.Unmarshal(raw, &snapshot) != nil {
		return ""
	}
	return snapshot.ID
}

func (s *V1Server) resolvePlaybookMatch(r *http.Request, orgID, deadLetterID string) (store.GetDeadLetterRow, store.RecoveryPlaybook, string, string, string) {
	q := store.New(s.pool)
	item, err := q.GetDeadLetter(r.Context(), store.GetDeadLetterParams{ID: deadLetterID, OrgID: orgID})
	if err != nil {
		kind := "error"
		if errors.Is(err, pgx.ErrNoRows) {
			kind = "not_found"
		}
		return store.GetDeadLetterRow{}, store.RecoveryPlaybook{}, "", "", kind
	}
	workflowID := playbookWorkflowID(item.WorkflowJson)
	if workflowID == "" {
		return item, store.RecoveryPlaybook{}, "", "", "unsaved"
	}
	failureSignature := engine.DeadLetterSignature(item)
	playbook, err := q.FindMatchingActivePlaybook(r.Context(), store.FindMatchingActivePlaybookParams{
		OrgID: orgID, WorkflowID: pgtype.Text{String: workflowID, Valid: true}, Signature: failureSignature,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return item, store.RecoveryPlaybook{}, workflowID, failureSignature, "none"
		}
		return item, store.RecoveryPlaybook{}, workflowID, failureSignature, "error"
	}
	return item, playbook, workflowID, failureSignature, "ok"
}

func (s *V1Server) matchPlaybookCore(r *http.Request, rc v1Request) opResult {
	deadLetterID := r.URL.Query().Get("deadLetterId")
	if deadLetterID == "" {
		return opError(http.StatusBadRequest, "dlq_field_required", "deadLetterId is required",
			map[string]any{"field": "deadLetterId"})
	}
	_, playbook, _, _, kind := s.resolvePlaybookMatch(r, rc.orgID, deadLetterID)
	switch kind {
	case "not_found":
		return opError(http.StatusNotFound, "dlq_not_found", "DLQ entry not found", nil)
	case "error":
		return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	case "unsaved", "none":
		return opOK(map[string]any{"playbook": nil})
	default:
		return opOK(map[string]any{"playbook": playbookView(playbook)})
	}
}

type createPlaybookBody struct {
	DeadLetterID            string `json:"deadLetterId"`
	ValidationRunID         string `json:"validationRunId"`
	SourceWorkflowVersionID string `json:"sourceWorkflowVersionId"`
	Title                   string `json:"title"`
	InstructionsMarkdown    string `json:"instructionsMarkdown"`
}

func validCreatePlaybookBody(body *createPlaybookBody) bool {
	body.Title = strings.TrimSpace(body.Title)
	body.InstructionsMarkdown = strings.TrimSpace(body.InstructionsMarkdown)
	return body.DeadLetterID != "" && jsStringLength(body.DeadLetterID) <= 256 &&
		body.ValidationRunID != "" && jsStringLength(body.ValidationRunID) <= 256 &&
		body.SourceWorkflowVersionID != "" && jsStringLength(body.SourceWorkflowVersionID) <= 256 &&
		body.Title != "" && jsStringLength(body.Title) <= playbookTitleMaxCodeUnits &&
		body.InstructionsMarkdown != "" && jsStringLength(body.InstructionsMarkdown) <= playbookInstructionsMaxCodeUnits
}

func validationWorkflow(raw json.RawMessage) *domain.Workflow {
	var envelope struct {
		Workflow json.RawMessage `json:"workflow"`
	}
	if json.Unmarshal(raw, &envelope) != nil {
		return nil
	}
	workflow, _ := domain.Parse(envelope.Workflow)
	return workflow
}

func workflowChangeCount(before, after *domain.Workflow) int {
	if before == nil || after == nil {
		return 0
	}
	var left, right map[string]any
	leftJSON, _ := json.Marshal(before)
	rightJSON, _ := json.Marshal(after)
	if json.Unmarshal(leftJSON, &left) != nil || json.Unmarshal(rightJSON, &right) != nil {
		return 0
	}
	changes := 0
	for key := range left {
		if key != "nodes" && key != "edges" && !reflect.DeepEqual(left[key], right[key]) {
			changes++
		}
	}
	for key := range right {
		if key != "nodes" && key != "edges" {
			if _, present := left[key]; !present {
				changes++
			}
		}
	}
	index := func(value any, identity func(map[string]any) string) map[string]any {
		result := map[string]any{}
		rows, _ := value.([]any)
		for position, raw := range rows {
			row, _ := raw.(map[string]any)
			key := identity(row)
			if key == "" {
				key = fmt.Sprintf("#%d", position)
			}
			result[key] = row
		}
		return result
	}
	countRows := func(a, b map[string]any) {
		for key, value := range a {
			other, present := b[key]
			if !present || !reflect.DeepEqual(value, other) {
				changes++
			}
		}
		for key := range b {
			if _, present := a[key]; !present {
				changes++
			}
		}
	}
	countRows(index(left["nodes"], func(row map[string]any) string {
		value, _ := row["id"].(string)
		return value
	}), index(right["nodes"], func(row map[string]any) string {
		value, _ := row["id"].(string)
		return value
	}))
	countRows(index(left["edges"], func(row map[string]any) string {
		from, _ := row["from"].(string)
		to, _ := row["to"].(string)
		return from + "\x00" + to
	}), index(right["edges"], func(row map[string]any) string {
		from, _ := row["from"].(string)
		to, _ := row["to"].(string)
		return from + "\x00" + to
	}))
	return changes
}

func (s *V1Server) createPlaybookCore(r *http.Request, rc v1Request) opResult {
	var body createPlaybookBody
	if err := decodeBody(r, &body); err != nil || !validCreatePlaybookBody(&body) {
		return opError(http.StatusBadRequest, "recovery_playbook_invalid_body", "Invalid Recovery Playbook body", nil)
	}
	ctx := r.Context()
	q := store.New(s.pool)
	item, err := q.GetDeadLetter(ctx, store.GetDeadLetterParams{ID: body.DeadLetterID, OrgID: rc.orgID})
	if err != nil {
		return opError(http.StatusNotFound, "dlq_not_found", "DLQ entry not found", nil)
	}
	workflowID := playbookWorkflowID(item.WorkflowJson)
	source, sourceErr := q.GetWorkflowVersionByID(ctx, store.GetWorkflowVersionByIDParams{
		ID: body.SourceWorkflowVersionID, OrgID: rc.orgID, WorkflowID: workflowID,
	})
	if workflowID == "" || sourceErr != nil || source.WorkflowID != workflowID {
		return opError(http.StatusUnprocessableEntity, "recovery_playbook_source_mismatch",
			"The saved workflow version does not match this recovery", nil)
	}
	validation, validationErr := q.GetRun(ctx, store.GetRunParams{ID: body.ValidationRunID, OrgID: rc.orgID})
	if validationErr != nil || !validation.ReplayMode.Valid || validation.ReplayMode.String != "validation" ||
		!validation.ValidationEvidenceLevel.Valid || validation.ValidationEvidenceLevel.String == "writes_skipped" ||
		!validation.ParentRunID.Valid || validation.ParentRunID.String != item.RunID ||
		validation.Status != "succeeded" || validation.CreatedAt == nil {
		return opError(http.StatusUnprocessableEntity, "recovery_playbook_validation_required",
			"A successful sandbox validation is required", nil)
	}
	if source.CreatedAt == nil || source.CreatedAt.Before(*validation.CreatedAt) {
		return opError(http.StatusUnprocessableEntity, "recovery_playbook_source_mismatch",
			"The saved workflow version predates validation", nil)
	}
	if item.Status != "replayed" || item.ReplayedAt == nil || item.ReplayedAt.Before(*source.CreatedAt) {
		return opError(http.StatusUnprocessableEntity, "recovery_playbook_apply_required",
			"The recovery must be applied after validation", nil)
	}
	validatedWorkflow := validationWorkflow(validation.InputJson)
	sourceWorkflow, _ := domain.Parse(source.DagJson)
	if validatedWorkflow == nil || sourceWorkflow == nil || !engine.WorkflowsEqual(validatedWorkflow, sourceWorkflow) {
		return opError(http.StatusUnprocessableEntity, "recovery_playbook_source_mismatch",
			"The saved workflow version is not the validated snapshot", nil)
	}
	feedback, feedbackErr := q.FindLatestAcceptedRecoveryFeedback(ctx, store.FindLatestAcceptedRecoveryFeedbackParams{
		OrgID: rc.orgID, DeadLetterID: body.DeadLetterID,
	})
	if feedbackErr != nil || feedback.WorkflowID != workflowID || feedback.CreatedAt == nil ||
		feedback.CreatedAt.Before(*item.ReplayedAt) {
		return opError(http.StatusUnprocessableEntity, "recovery_playbook_acceptance_required",
			"Accepted recovery feedback is required", nil)
	}
	failedWorkflow, _ := domain.Parse(item.WorkflowJson)
	patchChangeCount := workflowChangeCount(failedWorkflow, sourceWorkflow)
	if patchChangeCount == 0 {
		return opError(http.StatusUnprocessableEntity, "recovery_playbook_evidence_required",
			"Non-empty patch evidence is required", nil)
	}
	failureSignature := engine.DeadLetterSignature(item)
	evidenceRequirements := map[string]any{
		"requiredOnEveryUse": []string{"sandbox_validation", "explicit_production_apply"},
		"sourceEvidence": map[string]any{
			"deadLetterId": item.ID, "validationRunId": validation.ID,
			"sourceWorkflowVersionId": source.ID, "acceptedFeedbackId": feedback.ID,
			"patchChangeCount": patchChangeCount,
		},
	}
	playbook, created, err := s.engine.CreatePlaybookDraft(ctx, engine.PlaybookDraftInput{
		OrgID: rc.orgID, WorkflowID: workflowID, Signature: failureSignature,
		Title:                   signature.ScrubSecretShapes(body.Title),
		InstructionsMarkdown:    signature.ScrubSecretShapes(body.InstructionsMarkdown),
		EvidenceRequirements:    evidenceRequirements,
		SourceWorkflowVersionID: source.ID,
		ApproachLabel:           feedback.ApproachLabel,
		ValidationRunID:         validation.ID,
		Actor:                   rc.userID,
	})
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	if created {
		audit.Write(ctx, s.pool, rc.authContext, "recovery.playbook.created", audit.Options{
			TargetType: "recovery_playbook", TargetID: playbook.ID,
			Metadata: map[string]any{
				"deadLetterId": item.ID, "workflowId": workflowID, "signature": failureSignature,
				"version": playbook.Version, "validationRunId": validation.ID,
				"sourceWorkflowVersionId": source.ID, "patchChangeCount": patchChangeCount,
			},
		})
	}
	status := http.StatusOK
	if created {
		status = http.StatusCreated
	}
	return opResult{status: status, data: map[string]any{"playbook": playbookView(playbook), "created": created}}
}

func (s *V1Server) usePlaybookCore(r *http.Request, rc v1Request, id string) opResult {
	var body struct {
		DeadLetterID string `json:"deadLetterId"`
	}
	if err := decodeBody(r, &body); err != nil || body.DeadLetterID == "" || jsStringLength(body.DeadLetterID) > 256 {
		return opError(http.StatusBadRequest, "recovery_playbook_invalid_body", "Invalid Recovery Playbook body", nil)
	}
	item, playbook, workflowID, failureSignature, kind := s.resolvePlaybookMatch(r, rc.orgID, body.DeadLetterID)
	if kind == "not_found" {
		return opError(http.StatusNotFound, "dlq_not_found", "DLQ entry not found", nil)
	}
	if kind != "ok" || playbook.ID != id {
		return opError(http.StatusConflict, "recovery_playbook_match_changed", "This playbook no longer matches the failure", nil)
	}
	source, err := store.New(s.pool).GetWorkflowVersionByID(r.Context(), store.GetWorkflowVersionByIDParams{
		ID: playbook.SourceWorkflowVersionID, OrgID: rc.orgID, WorkflowID: workflowID,
	})
	if err != nil {
		return opError(http.StatusUnprocessableEntity, "recovery_playbook_source_invalid", "Recovery Playbook source workflow is invalid", nil)
	}
	workflow, _ := domain.Parse(source.DagJson)
	if workflow == nil {
		return opError(http.StatusUnprocessableEntity, "recovery_playbook_source_invalid", "Recovery Playbook source workflow is invalid", nil)
	}
	audit.Write(r.Context(), s.pool, rc.authContext, "recovery.playbook.used", audit.Options{
		TargetType: "recovery_playbook", TargetID: playbook.ID,
		Metadata: map[string]any{
			"deadLetterId": body.DeadLetterID, "workflowId": workflowID,
			"signature": failureSignature, "version": playbook.Version,
		},
	})
	lastValidated := "unknown"
	if playbook.LastValidatedAt != nil {
		lastValidated = isoMillis(*playbook.LastValidatedAt)
	}
	suggestion := map[string]any{
		"mode": "playbook", "suggestedWorkflow": workflow,
		"rationale": playbook.InstructionsMarkdown,
		"suggestions": []any{map[string]any{
			"workflow": workflow, "rationale": playbook.InstructionsMarkdown,
			"approachLabel": playbook.ApproachLabel, "confidence": 100,
			"calibratedConfidence":   100,
			"safety":                 domain.ComputeSuggestionSafety(workflow, item.NodeID),
			"consideredAlternatives": []any{},
		}},
		"evidence": []any{map[string]any{
			"kind": "recovery_playbook", "sourceRef": playbook.ID, "label": playbook.Title,
			"snippet": fmt.Sprintf("Version %d; %d successful uses; last validated %s.",
				playbook.Version, playbook.SuccessfulUses, lastValidated),
			"weight": 1,
		}},
		"recoveryPassport": map[string]any{
			"failureSignature": failureSignature, "priorSameSignatureOutcome": nil,
		},
		"playbook": playbookView(playbook),
	}
	return opOK(map[string]any{"suggestion": suggestion})
}

type playbookOutcomeBody struct {
	DeadLetterID    string `json:"deadLetterId"`
	ValidationRunID string `json:"validationRunId"`
	Phase           string `json:"phase"`
}

func validPlaybookOutcomeBody(body playbookOutcomeBody) bool {
	return body.DeadLetterID != "" && jsStringLength(body.DeadLetterID) <= 256 &&
		body.ValidationRunID != "" && jsStringLength(body.ValidationRunID) <= 256 &&
		(body.Phase == "validation" || body.Phase == "applied")
}

func validationPlaybookID(raw json.RawMessage) string {
	var envelope struct {
		RecoveryPlaybookID string `json:"recoveryPlaybookId"`
	}
	_ = json.Unmarshal(raw, &envelope)
	return envelope.RecoveryPlaybookID
}

func (s *V1Server) playbookOutcomeCore(r *http.Request, rc v1Request, id string) opResult {
	var body playbookOutcomeBody
	if err := decodeBody(r, &body); err != nil || !validPlaybookOutcomeBody(body) {
		return opError(http.StatusBadRequest, "recovery_playbook_invalid_body", "Invalid Recovery Playbook body", nil)
	}
	q := store.New(s.pool)
	if _, err := q.GetRecoveryPlaybook(r.Context(), store.GetRecoveryPlaybookParams{OrgID: rc.orgID, ID: id}); err != nil {
		return opError(http.StatusNotFound, "recovery_playbook_not_found", "Recovery Playbook not found", nil)
	}
	item, itemErr := q.GetDeadLetter(r.Context(), store.GetDeadLetterParams{ID: body.DeadLetterID, OrgID: rc.orgID})
	run, runErr := q.GetRun(r.Context(), store.GetRunParams{ID: body.ValidationRunID, OrgID: rc.orgID})
	terminal := run.Status == "succeeded" || run.Status == "failed" || run.Status == "cancelled"
	if itemErr != nil || runErr != nil || !run.ReplayMode.Valid || run.ReplayMode.String != "validation" ||
		!run.ParentRunID.Valid || run.ParentRunID.String != item.RunID || validationPlaybookID(run.InputJson) != id || !terminal {
		return opError(http.StatusUnprocessableEntity, "recovery_playbook_outcome_invalid",
			"Recovery Playbook outcome cannot be verified", nil)
	}
	succeeded := run.Status == "succeeded"
	if succeeded && (!run.ValidationEvidenceLevel.Valid || run.ValidationEvidenceLevel.String == "writes_skipped") {
		return opError(http.StatusUnprocessableEntity, "recovery_playbook_outcome_invalid",
			"Recovery Playbook outcome cannot be verified", nil)
	}
	playbook, recorded, err := s.engine.RecordPlaybookValidationOutcome(
		r.Context(), rc.orgID, id, run.ID, succeeded, rc.userID,
	)
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	if body.Phase == "validation" {
		return opOK(map[string]any{"playbook": playbookView(playbook), "recorded": recorded})
	}
	hasImpact, impactErr := q.RecoveryImpactExists(r.Context(), store.RecoveryImpactExistsParams{
		OrgID: rc.orgID, DeadLetterID: body.DeadLetterID,
	})
	if !succeeded || impactErr != nil || !hasImpact {
		return opError(http.StatusUnprocessableEntity, "recovery_playbook_apply_required",
			"A passed sandbox and terminally successful recovery are required", nil)
	}
	playbook, recorded, err = s.engine.RecordPlaybookApplied(
		r.Context(), rc.orgID, id, run.ID, item.ID, rc.userID,
	)
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	return opOK(map[string]any{"playbook": playbookView(playbook), "recorded": recorded})
}

func (s *V1Server) playbookLifecycleCore(r *http.Request, rc v1Request, id, action string) opResult {
	switch action {
	case "activate":
		playbook, err := s.engine.ActivatePlaybook(r.Context(), rc.orgID, id, rc.userID)
		if err != nil {
			switch {
			case errors.Is(err, engine.ErrPlaybookNotFound):
				return opError(http.StatusNotFound, "recovery_playbook_not_found", "Recovery Playbook not found", nil)
			case errors.Is(err, engine.ErrPlaybookConflict), errors.Is(err, engine.ErrPlaybookInvalidStatus):
				return opError(http.StatusConflict, "recovery_playbook_invalid_status",
					"Recovery Playbook cannot transition from its current status", nil)
			default:
				return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
			}
		}
		audit.Write(r.Context(), s.pool, rc.authContext, "recovery.playbook.activated", audit.Options{
			TargetType: "recovery_playbook", TargetID: id,
			Metadata: map[string]any{"version": playbook.Version, "signature": playbook.Signature},
		})
		return opOK(map[string]any{"playbook": playbookView(playbook)})
	case "retire":
		q := store.New(s.pool)
		if _, err := q.GetRecoveryPlaybook(r.Context(), store.GetRecoveryPlaybookParams{OrgID: rc.orgID, ID: id}); err != nil {
			return opError(http.StatusNotFound, "recovery_playbook_not_found", "Recovery Playbook not found", nil)
		}
		retired, err := q.RetireRecoveryPlaybook(r.Context(), store.RetireRecoveryPlaybookParams{
			OrgID: rc.orgID, ID: id, Actor: pgtype.Text{String: rc.userID, Valid: rc.userID != ""},
		})
		if err != nil {
			return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
		}
		playbook, err := q.GetRecoveryPlaybook(r.Context(), store.GetRecoveryPlaybookParams{OrgID: rc.orgID, ID: id})
		if err != nil {
			return opError(http.StatusNotFound, "recovery_playbook_not_found", "Recovery Playbook not found", nil)
		}
		if retired > 0 {
			audit.Write(r.Context(), s.pool, rc.authContext, "recovery.playbook.retired", audit.Options{
				TargetType: "recovery_playbook", TargetID: id,
				Metadata: map[string]any{"version": playbook.Version, "signature": playbook.Signature},
			})
		}
		return opOK(map[string]any{"playbook": playbookView(playbook)})
	default:
		return opError(http.StatusNotFound, "recovery_playbook_not_found", "Recovery Playbook not found", nil)
	}
}

func (s *V1Server) mountPlaybookRoutes(mux *http.ServeMux) {
	read := routeGate{auth.RoleViewer, "recovery.read"}
	write := routeGate{auth.RoleEditor, "recovery.write"}
	s.route(mux, "POST /recovery/playbooks", write, func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeUnversioned(w, s.createPlaybookCore(r, rc))
	})
	s.route(mux, "GET /recovery/playbooks/match", read, func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeUnversioned(w, s.matchPlaybookCore(r, rc))
	})
	s.route(mux, "POST /recovery/playbooks/{id}/use", write, func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeUnversioned(w, s.usePlaybookCore(r, rc, r.PathValue("id")))
	})
	s.route(mux, "POST /recovery/playbooks/{id}/activate", write, func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeUnversioned(w, s.playbookLifecycleCore(r, rc, r.PathValue("id"), "activate"))
	})
	s.route(mux, "POST /recovery/playbooks/{id}/retire", write, func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeUnversioned(w, s.playbookLifecycleCore(r, rc, r.PathValue("id"), "retire"))
	})
	s.route(mux, "POST /recovery/playbooks/{id}/outcome", write, func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeUnversioned(w, s.playbookOutcomeCore(r, rc, r.PathValue("id")))
	})
}

// Recovery Playbook lifecycle routes — MANUAL draft/activate/retire (the
// reference's evidence-gated posture: activation is a human decision over
// fresh sandbox evidence; the exact-match lookup is read-only).
package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/go/internal/audit"
	"github.com/johnny4young/janusly/go/internal/engine"
	"github.com/johnny4young/janusly/go/internal/store"
)

func playbookView(row store.RecoveryPlaybook) map[string]any {
	return map[string]any{
		"id": row.ID, "orgId": row.OrgID,
		"workflowId": textOrNull(row.WorkflowID), "signature": row.Signature,
		"version": row.Version, "status": row.Status, "title": row.Title,
		"approachLabel":  row.ApproachLabel,
		"successfulUses": row.SuccessfulUses, "regressions": row.Regressions,
		"sourceWorkflowVersionId": row.SourceWorkflowVersionID,
		"lastValidatedAt":         timeOrNull(row.LastValidatedAt),
		"lastValidationRunId":     textOrNull(row.LastValidationRunID),
		"activatedAt":             timeOrNull(row.ActivatedAt),
		"retiredAt":               timeOrNull(row.RetiredAt),
	}
}

func (s *V1Server) createPlaybookCore(r *http.Request, rc v1Request) opResult {
	var body struct {
		DeadLetterID            string          `json:"deadLetterId"`
		Title                   string          `json:"title"`
		InstructionsMarkdown    string          `json:"instructionsMarkdown"`
		EvidenceRequirements    json.RawMessage `json:"evidenceRequirements"`
		SourceWorkflowVersionID string          `json:"sourceWorkflowVersionId"`
		ApproachLabel           string          `json:"approachLabel"`
		ValidationRunID         string          `json:"validationRunId"`
	}
	if err := decodeBody(r, &body); err != nil || body.DeadLetterID == "" || body.Title == "" ||
		body.SourceWorkflowVersionID == "" || body.ValidationRunID == "" {
		return opError(http.StatusBadRequest, "recovery_playbook_invalid_body",
			"deadLetterId, title, sourceWorkflowVersionId and validationRunId are required", nil)
	}
	item, err := store.New(s.pool).GetDeadLetter(r.Context(), store.GetDeadLetterParams{
		ID: body.DeadLetterID, OrgID: rc.orgID,
	})
	if err != nil {
		return opError(http.StatusNotFound, "dlq_not_found", "DLQ entry not found", nil)
	}
	var wfDoc struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(item.WorkflowJson, &wfDoc)
	approach := body.ApproachLabel
	if approach == "" {
		approach = "other"
	}
	var evidence any
	if len(body.EvidenceRequirements) > 0 {
		_ = json.Unmarshal(body.EvidenceRequirements, &evidence)
	}
	playbook, created, err := s.engine.CreatePlaybookDraft(r.Context(), engine.PlaybookDraftInput{
		OrgID: rc.orgID, WorkflowID: wfDoc.ID,
		Signature: engine.DeadLetterSignature(item),
		Title:     body.Title, InstructionsMarkdown: body.InstructionsMarkdown,
		EvidenceRequirements:    evidence,
		SourceWorkflowVersionID: body.SourceWorkflowVersionID,
		ApproachLabel:           approach, ValidationRunID: body.ValidationRunID,
		Actor: rc.userID,
	})
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}
	if created {
		audit.Write(r.Context(), s.pool, rc.authContext, "recovery.playbook.created", audit.Options{
			TargetType: "recovery_playbook", TargetID: playbook.ID,
			Metadata: map[string]any{"signature": playbook.Signature, "workflowId": wfDoc.ID},
		})
	}
	status := http.StatusOK
	if created {
		status = http.StatusCreated
	}
	return opResult{status: status, data: map[string]any{"playbook": playbookView(playbook), "created": created}}
}

func (s *V1Server) matchPlaybookCore(r *http.Request, rc v1Request) opResult {
	deadLetterID := r.URL.Query().Get("deadLetterId")
	if deadLetterID == "" {
		return opError(http.StatusBadRequest, "recovery_playbook_invalid_body", "deadLetterId is required", nil)
	}
	item, err := store.New(s.pool).GetDeadLetter(r.Context(), store.GetDeadLetterParams{
		ID: deadLetterID, OrgID: rc.orgID,
	})
	if err != nil {
		return opError(http.StatusNotFound, "dlq_not_found", "DLQ entry not found", nil)
	}
	var wfDoc struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(item.WorkflowJson, &wfDoc)
	playbook, err := store.New(s.pool).FindMatchingActivePlaybook(r.Context(), store.FindMatchingActivePlaybookParams{
		OrgID: rc.orgID, WorkflowID: pgtype.Text{String: wfDoc.ID, Valid: wfDoc.ID != ""},
		Signature: engine.DeadLetterSignature(item),
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return opOK(map[string]any{"playbook": nil})
		}
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}
	return opOK(map[string]any{"playbook": playbookView(playbook)})
}

func (s *V1Server) playbookLifecycleCore(r *http.Request, rc v1Request, id, action string) opResult {
	switch action {
	case "activate":
		playbook, err := s.engine.ActivatePlaybook(r.Context(), rc.orgID, id, rc.userID)
		if err != nil {
			switch {
			case errors.Is(err, engine.ErrPlaybookNotFound):
				return opError(http.StatusNotFound, "recovery_playbook_not_found", "Playbook not found", nil)
			case errors.Is(err, engine.ErrPlaybookConflict):
				return opError(http.StatusConflict, "recovery_playbook_conflict", "Another activation won", nil)
			case errors.Is(err, engine.ErrPlaybookInvalidStatus):
				return opError(http.StatusConflict, "recovery_playbook_invalid_status", err.Error(), nil)
			default:
				return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
			}
		}
		audit.Write(r.Context(), s.pool, rc.authContext, "recovery.playbook.activated", audit.Options{
			TargetType: "recovery_playbook", TargetID: id,
		})
		return opOK(map[string]any{"playbook": playbookView(playbook)})
	case "retire":
		retired, err := store.New(s.pool).RetireRecoveryPlaybook(r.Context(), store.RetireRecoveryPlaybookParams{
			OrgID: rc.orgID, ID: id, Actor: pgtype.Text{String: rc.userID, Valid: rc.userID != ""},
		})
		if err != nil {
			return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
		}
		playbook, err := store.New(s.pool).GetRecoveryPlaybook(r.Context(), store.GetRecoveryPlaybookParams{
			OrgID: rc.orgID, ID: id,
		})
		if err != nil {
			return opError(http.StatusNotFound, "recovery_playbook_not_found", "Playbook not found", nil)
		}
		if retired > 0 {
			audit.Write(r.Context(), s.pool, rc.authContext, "recovery.playbook.retired", audit.Options{
				TargetType: "recovery_playbook", TargetID: id,
			})
		}
		return opOK(map[string]any{"playbook": playbookView(playbook)})
	}
	return opError(http.StatusNotFound, "recovery_playbook_not_found", "Unknown action", nil)
}

func (s *V1Server) mountPlaybookRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /recovery/playbooks", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeLegacy(w, s.createPlaybookCore(r, rc))
	}))
	mux.HandleFunc("GET /recovery/playbooks/match", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeLegacy(w, s.matchPlaybookCore(r, rc))
	}))
	mux.HandleFunc("POST /recovery/playbooks/{id}/activate", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeLegacy(w, s.playbookLifecycleCore(r, rc, r.PathValue("id"), "activate"))
	}))
	mux.HandleFunc("POST /recovery/playbooks/{id}/retire", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeLegacy(w, s.playbookLifecycleCore(r, rc, r.PathValue("id"), "retire"))
	}))
}

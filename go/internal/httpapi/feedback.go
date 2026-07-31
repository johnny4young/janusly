// Recovery feedback loop: operators label patch suggestions
// (accept/reject + the model's raw self-rated confidence); the daily
// sweep fits per-approach calibration curves; the read route exposes the
// stored curves for the dialog to apply.
package httpapi

import (
	"net/http"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/go/internal/audit"
	"github.com/johnny4young/janusly/go/internal/store"
)

var feedbackApproachLabels = map[string]bool{
	"add_retry": true, "raise_timeout": true, "swap_secret_ref": true,
	"add_approval": true, "fix_url": true, "other": true,
}

func (s *V1Server) recordFeedbackCore(r *http.Request, rc v1Request) opResult {
	var body struct {
		DeadLetterID   string `json:"deadLetterId"`
		WorkflowID     string `json:"workflowId"`
		SuggestionMode string `json:"suggestionMode"`
		ApproachLabel  string `json:"approachLabel"`
		Accepted       *bool  `json:"accepted"`
		RawConfidence  *int32 `json:"rawConfidence"`
		Comment        string `json:"comment"`
		EvalConsent    bool   `json:"evalConsent"`
	}
	if err := decodeBody(r, &body); err != nil || body.DeadLetterID == "" ||
		body.WorkflowID == "" || body.Accepted == nil {
		return opError(http.StatusBadRequest, "recovery_feedback_invalid_body",
			"deadLetterId, workflowId and accepted are required", nil)
	}
	if !feedbackApproachLabels[body.ApproachLabel] {
		return opError(http.StatusBadRequest, "recovery_feedback_invalid_body",
			"approachLabel must be one of the closed set", nil)
	}
	if body.RawConfidence != nil && (*body.RawConfidence < 0 || *body.RawConfidence > 100) {
		return opError(http.StatusBadRequest, "recovery_feedback_invalid_body",
			"rawConfidence must be 0..100", nil)
	}
	mode := body.SuggestionMode
	if mode == "" {
		mode = "fallback"
	}
	rawConfidence := pgtype.Int4{}
	if body.RawConfidence != nil {
		rawConfidence = pgtype.Int4{Int32: *body.RawConfidence, Valid: true}
	}
	if len(body.Comment) > 2000 {
		body.Comment = body.Comment[:2000]
	}
	if err := store.New(s.pool).InsertRecoveryFeedback(r.Context(), store.InsertRecoveryFeedbackParams{
		ID: s.newID(), OrgID: rc.orgID,
		UserID:       pgtype.Text{String: rc.userID, Valid: rc.userID != ""},
		DeadLetterID: body.DeadLetterID, WorkflowID: body.WorkflowID,
		SuggestionMode: mode, ApproachLabel: body.ApproachLabel,
		Accepted: *body.Accepted, RawConfidence: rawConfidence,
		Comment:     pgtype.Text{String: body.Comment, Valid: body.Comment != ""},
		EvalConsent: body.EvalConsent,
	}); err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}
	audit.Write(r.Context(), s.pool, rc.authContext, "recovery.feedback", audit.Options{
		TargetType: "dlq", TargetID: body.DeadLetterID,
		Metadata: map[string]any{"accepted": *body.Accepted, "approachLabel": body.ApproachLabel},
	})
	return opOK(map[string]any{"ok": true})
}

func (s *V1Server) listCalibrationsCore(r *http.Request, rc v1Request) opResult {
	rows, err := store.New(s.pool).ListConfidenceCalibrations(r.Context(), rc.orgID)
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}
	items := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		items = append(items, map[string]any{
			"approachLabel": row.ApproachLabel,
			"acceptRate":    row.AcceptRate, "sampleSize": row.SampleSize,
			"curveSlope": row.CurveSlope, "curveIntercept": row.CurveIntercept,
			"lastComputedAt": row.LastComputedAt,
		})
	}
	return opOK(map[string]any{"calibrations": items})
}

func (s *V1Server) mountFeedbackRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /recovery/feedback", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeLegacy(w, s.recordFeedbackCore(r, rc))
	}))
	mux.HandleFunc("GET /recovery/calibrations", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeLegacy(w, s.listCalibrationsCore(r, rc))
	}))
}

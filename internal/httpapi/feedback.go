// Recovery feedback loop: operators label patch suggestions
// (accept/reject + the model's raw self-rated confidence); the daily
// sweep fits per-approach calibration curves; the read route exposes the
// stored curves for the dialog to apply.
package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/internal/aiconfig"
	"github.com/johnny4young/janusly/internal/audit"
	"github.com/johnny4young/janusly/internal/memory"
	"github.com/johnny4young/janusly/internal/ratelimit"
	"github.com/johnny4young/janusly/internal/signature"
	"github.com/johnny4young/janusly/internal/store"
)

const (
	feedbackTextMaxCodeUnits        = 2000
	recoveryMemoryCommentMaxRunes   = 60
	recoveryMemorySignatureMaxRunes = 120
	patchMemoryRationaleMaxRunes    = 1200
)

func isFeedbackApproachLabel(value string) bool {
	switch value {
	case "add_retry", "raise_timeout", "swap_secret_ref", "add_approval", "fix_url", "other":
		return true
	default:
		return false
	}
}

func isFeedbackSuggestionMode(value string) bool {
	switch value {
	case "ai", "fallback", "playbook":
		return true
	default:
		return false
	}
}

// optionalJSON distinguishes omission from an explicit null. Zod optional
// fields accept the former and reject the latter, while encoding/json's plain
// pointers collapse both states.
type optionalJSON[T any] struct {
	Value   T
	Present bool
	Null    bool
}

func (value *optionalJSON[T]) UnmarshalJSON(raw []byte) error {
	value.Present = true
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		value.Null = true
		return nil
	}
	return json.Unmarshal(raw, &value.Value)
}

type recoveryFeedbackBody struct {
	DeadLetterID   string                `json:"deadLetterId"`
	SuggestionMode string                `json:"suggestionMode"`
	ApproachLabel  string                `json:"approachLabel"`
	Accepted       optionalJSON[bool]    `json:"accepted"`
	Comment        optionalJSON[string]  `json:"comment"`
	EvalConsent    optionalJSON[bool]    `json:"evalConsent"`
	Rationale      optionalJSON[string]  `json:"rationale"`
	RawConfidence  optionalJSON[float64] `json:"rawConfidence"`
}

func jsStringLength(value string) int {
	length := 0
	for _, r := range value {
		length += utf16.RuneLen(r)
	}
	return length
}

func validRecoveryFeedbackBody(body recoveryFeedbackBody) bool {
	if body.DeadLetterID == "" || jsStringLength(body.DeadLetterID) > 256 ||
		!isFeedbackSuggestionMode(body.SuggestionMode) || !isFeedbackApproachLabel(body.ApproachLabel) ||
		!body.Accepted.Present || body.Accepted.Null {
		return false
	}
	if body.Comment.Null || body.Rationale.Null || body.EvalConsent.Null || body.RawConfidence.Null {
		return false
	}
	if body.Comment.Present && jsStringLength(body.Comment.Value) > feedbackTextMaxCodeUnits {
		return false
	}
	if body.Rationale.Present && jsStringLength(body.Rationale.Value) > feedbackTextMaxCodeUnits {
		return false
	}
	return !body.RawConfidence.Present || (body.RawConfidence.Value >= 0 && body.RawConfidence.Value <= 100 &&
		!math.IsNaN(body.RawConfidence.Value) && !math.IsInf(body.RawConfidence.Value, 0) &&
		math.Trunc(body.RawConfidence.Value) == body.RawConfidence.Value)
}

func workflowIDFromFeedbackSnapshot(raw json.RawMessage) string {
	var snapshot struct {
		ID string `json:"id"`
	}
	if json.Unmarshal(raw, &snapshot) != nil {
		return ""
	}
	return snapshot.ID
}

func truncateMemoryText(value string, maxRunes int) string {
	count, cutoff := 0, len(value)
	for index := range value {
		if count == maxRunes-1 {
			cutoff = index
		}
		if count == maxRunes {
			return strings.TrimRight(value[:cutoff], " \t\r\n") + "…"
		}
		count++
	}
	return value
}

func composeRecoveryMemoryContent(approachLabel, comment, failureSignature string) string {
	safeSignature := truncateMemoryText(signature.ScrubSecretShapes(failureSignature), recoveryMemorySignatureMaxRunes)
	comment = strings.TrimSpace(comment)
	commentSegment := "(none)"
	if comment != "" {
		commentSegment = truncateMemoryText(signature.ScrubSecretShapes(comment), recoveryMemoryCommentMaxRunes)
	}
	return "approachLabel=" + approachLabel + " — operator accepted. Failure signature: " +
		safeSignature + ". Comment: " + commentSegment
}

func composePatchMemoryContent(approachLabel, rationale string) string {
	safe := truncateMemoryText(signature.ScrubSecretShapes(strings.TrimSpace(rationale)), patchMemoryRationaleMaxRunes)
	return "approachLabel=" + approachLabel + ". Rationale: " + safe
}

func feedbackNodeContext(raw json.RawMessage) (nodeType, toolName string) {
	var node struct {
		Type   string `json:"type"`
		Config struct {
			Tool string `json:"tool"`
		} `json:"config"`
	}
	_ = json.Unmarshal(raw, &node)
	return node.Type, node.Config.Tool
}

func (s *V1Server) scheduleFeedbackMemory(
	ctx context.Context,
	rc v1Request,
	dlq store.GetDeadLetterRow,
	body recoveryFeedbackBody,
	workflowID, safeComment string,
) {
	if !body.Accepted.Value || !memory.Enabled(ctx, s.pool, rc.orgID) {
		return
	}
	nodeType, toolName := feedbackNodeContext(dlq.NodeJson)
	failureSignature := signature.NormalizeJSON(dlq.ErrorJson, signature.Context{
		NodeID: dlq.NodeID, NodeType: nodeType, ToolName: toolName,
	}).Signature
	recoveryContent := composeRecoveryMemoryContent(body.ApproachLabel, safeComment, failureSignature)
	patchContent := ""
	if body.Rationale.Present && body.Rationale.Value != "" {
		patchContent = composePatchMemoryContent(body.ApproachLabel, body.Rationale.Value)
	}
	s.runBackground(func(background context.Context) {
		memory.Commit(background, s.pool, memory.CommitInput{
			OrgID: rc.orgID, WorkflowID: workflowID, RunID: dlq.RunID,
			Kind: "recovery_rationale", Content: recoveryContent,
			Metadata: map[string]any{
				"approachLabel": body.ApproachLabel, "accepted": true,
				"suggestionMode": body.SuggestionMode, "deadLetterId": body.DeadLetterID,
			},
		})
		if patchContent == "" {
			return
		}
		memory.Commit(background, s.pool, memory.CommitInput{
			OrgID: rc.orgID, WorkflowID: workflowID, RunID: dlq.RunID,
			Kind: "patch_rationale", Content: patchContent,
			Metadata: map[string]any{
				"approachLabel":  body.ApproachLabel,
				"suggestionMode": body.SuggestionMode, "deadLetterId": body.DeadLetterID,
			},
		})
	})
}

func (s *V1Server) recordFeedbackCore(r *http.Request, rc v1Request) opResult {
	_, settings := aiconfig.Resolve(r.Context(), s.pool, rc.orgID)
	if limitErr := s.limiter.Enforce(r.Context(), rc.orgID, ratelimit.Options{
		Name: "ai", Max: settings.RateLimitPerMin, Window: time.Minute,
	}); limitErr != nil {
		return opError(http.StatusTooManyRequests, "rate_limited", limitErr.Error(), nil)
	}

	var body recoveryFeedbackBody
	if err := decodeBody(r, &body); err != nil || !validRecoveryFeedbackBody(body) {
		return opError(http.StatusBadRequest, "recovery_invalid_feedback_body", "Invalid feedback body", nil)
	}

	ctx := r.Context()
	q := store.New(s.pool)
	dlq, err := q.GetDeadLetter(ctx, store.GetDeadLetterParams{ID: body.DeadLetterID, OrgID: rc.orgID})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return opError(http.StatusNotFound, "dlq_not_found", "DLQ entry not found", nil)
		}
		return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	workflowID := workflowIDFromFeedbackSnapshot(dlq.WorkflowJson)
	if workflowID == "" {
		return opError(http.StatusUnprocessableEntity, "recovery_feedback_saved_only",
			"Feedback is only recorded for saved workflows", nil)
	}

	rawConfidence := pgtype.Int4{}
	if body.RawConfidence.Present {
		rawConfidence = pgtype.Int4{Int32: int32(body.RawConfidence.Value), Valid: true}
	}
	safeComment := ""
	if body.Comment.Present && body.Comment.Value != "" {
		safeComment = signature.ScrubSecretShapes(body.Comment.Value)
	}
	if err := q.RecordRecoveryFeedback(ctx, store.RecordRecoveryFeedbackParams{
		ID: s.newID(), HealthID: s.newID(), OrgID: rc.orgID,
		UserID:       pgtype.Text{String: rc.userID, Valid: rc.userID != ""},
		DeadLetterID: body.DeadLetterID, WorkflowID: workflowID,
		SuggestionMode: body.SuggestionMode, ApproachLabel: body.ApproachLabel,
		Accepted: body.Accepted.Value, RawConfidence: rawConfidence,
		Comment:     pgtype.Text{String: safeComment, Valid: safeComment != ""},
		EvalConsent: body.EvalConsent.Present && body.EvalConsent.Value,
	}); err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}

	evalConsent := body.EvalConsent.Present && body.EvalConsent.Value
	audit.Write(ctx, s.pool, rc.authContext, "recovery.feedback", audit.Options{
		TargetType: "dead_letter", TargetID: body.DeadLetterID,
		Metadata: map[string]any{
			"approachLabel": body.ApproachLabel, "suggestionMode": body.SuggestionMode,
			"accepted": body.Accepted.Value, "evalConsent": evalConsent,
		},
	})
	s.scheduleFeedbackMemory(ctx, rc, dlq, body, workflowID, safeComment)
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
		writeUnversioned(w, s.recordFeedbackCore(r, rc))
	}))
	mux.HandleFunc("GET /recovery/calibrations", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeUnversioned(w, s.listCalibrationsCore(r, rc))
	}))
}

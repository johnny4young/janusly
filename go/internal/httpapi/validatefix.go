// POST /dlq/validate-fix — the Recovery dialog's sandbox gate: validate a
// proposed fix by running it as a fresh validation replay (write sides
// skipped) seeded with the failing entry's exact input. The suggested
// workflow passes the SAME grammar gate as /ai/patch-workflow output
// before any run is seeded. Pilot posture: validationEffectMode supports
// only the default write-skip ("provider_simulation" answers 409 because
// the effect simulator is not part of this backend yet). An optional
// playbook claim is revalidated against the exact failure before seeding.
package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"

	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/johnny4young/janusly/go/internal/aiconfig"
	"github.com/johnny4young/janusly/go/internal/audit"
	"github.com/johnny4young/janusly/go/internal/domain"
	"github.com/johnny4young/janusly/go/internal/engine"
	"github.com/johnny4young/janusly/go/internal/grammar"
	"github.com/johnny4young/janusly/go/internal/ratelimit"
	"github.com/johnny4young/janusly/go/internal/recovery"
	"github.com/johnny4young/janusly/go/internal/store"
)

func (s *V1Server) validateFixCore(r *http.Request, rc v1Request) opResult {
	_, settings := aiconfig.Resolve(r.Context(), s.pool, rc.orgID)
	if limitErr := s.limiter.Enforce(r.Context(), rc.orgID, ratelimit.Options{
		Name: "ai", Max: settings.RateLimitPerMin, Window: time.Minute,
	}); limitErr != nil {
		return opError(http.StatusTooManyRequests, "rate_limited", limitErr.Error(), nil)
	}
	var body struct {
		DeadLetterID         string          `json:"deadLetterId"`
		SuggestedWorkflow    json.RawMessage `json:"suggestedWorkflow"`
		ValidationEffectMode *string         `json:"validationEffectMode"`
		RecoveryPlaybookID   string          `json:"recoveryPlaybookId"`
	}
	if err := decodeBody(r, &body); err != nil {
		return opError(http.StatusBadRequest, "invalid_input", "Invalid request body", nil)
	}
	if body.DeadLetterID == "" {
		return opError(http.StatusBadRequest, "dlq_field_required", "deadLetterId is required",
			map[string]any{"field": "deadLetterId"})
	}
	if len(body.SuggestedWorkflow) == 0 {
		return opError(http.StatusBadRequest, "dlq_field_required", "suggestedWorkflow is required",
			map[string]any{"field": "suggestedWorkflow"})
	}
	if body.ValidationEffectMode != nil {
		if *body.ValidationEffectMode != "provider_simulation" {
			return opError(http.StatusBadRequest, "recovery_validation_effect_mode_invalid",
				"validationEffectMode must be provider_simulation when provided", nil)
		}
		return opError(http.StatusConflict, "recovery_provider_simulation_unavailable",
			"Provider simulation is available only in the explicitly enabled local stack", nil)
	}
	// A playbook claim re-verifies its EXACT match before every sandbox
	// use: active status, same workflow + failure signature, and a source
	// snapshot identical to the suggestion. Anything else is a stale claim.
	playbookID := body.RecoveryPlaybookID

	// The same grammar gate as /ai/patch-workflow output: strict parse +
	// full validation so the sandbox can't be seeded with a malformed DAG.
	wf, parseIssues := domain.Parse(body.SuggestedWorkflow)
	if wf == nil {
		reason := "unknown"
		if len(parseIssues) > 0 {
			reason = parseIssues[0].Message
		}
		return opError(http.StatusBadRequest, "dlq_workflow_schema_invalid",
			"suggestedWorkflow failed schema validation: "+reason, map[string]any{"reason": reason})
	}
	result := domain.ValidateWithSemanticFixtures(wf, grammar.DomainValidator, recovery.FixtureOutcomesForValidation)
	var blocking []domain.Issue
	for _, issue := range result.Issues {
		// Pilot-unsupported node types do not block a sandbox seed when the
		// DAG itself is sound under the save-time validation posture.
		if issue.Code != domain.CodeNodeTypeUnsupportedPilot {
			blocking = append(blocking, issue)
		}
	}
	if len(blocking) > 0 {
		reason := blocking[0].Message
		return opError(http.StatusBadRequest, "dlq_workflow_schema_invalid",
			"suggestedWorkflow failed schema validation: "+reason, map[string]any{"reason": reason})
	}

	if playbookID != "" {
		item, err := store.New(s.pool).GetDeadLetter(r.Context(), store.GetDeadLetterParams{
			ID: body.DeadLetterID, OrgID: rc.orgID,
		})
		if err != nil {
			return opError(http.StatusNotFound, "dlq_not_found", "DLQ entry not found", nil)
		}
		sig := engine.DeadLetterSignature(item)
		playbook, err := store.New(s.pool).FindMatchingActivePlaybook(r.Context(), store.FindMatchingActivePlaybookParams{
			OrgID: rc.orgID, WorkflowID: pgtype.Text{String: wf.ID, Valid: wf.ID != ""}, Signature: sig,
		})
		if err != nil || playbook.ID != playbookID {
			return opError(http.StatusConflict, "recovery_playbook_match_changed",
				"This playbook no longer matches the failure", nil)
		}
		source, err := store.New(s.pool).GetWorkflowVersionAnyWorkflow(r.Context(), store.GetWorkflowVersionAnyWorkflowParams{
			ID: playbook.SourceWorkflowVersionID, OrgID: rc.orgID,
		})
		sourceWf, _ := domain.Parse(source.DagJson)
		if err != nil || sourceWf == nil || !engine.WorkflowsEqual(sourceWf, wf) {
			return opError(http.StatusConflict, "recovery_playbook_match_changed",
				"This playbook no longer matches the failure", nil)
		}
	}

	runID, err := s.engine.ReplayDeadLetterAsValidationWithPlaybook(r.Context(), rc.orgID, body.DeadLetterID, wf, rc.userID, playbookID)
	if err != nil {
		switch {
		case errors.Is(err, engine.ErrDeadLetterNotFound):
			return opError(http.StatusNotFound, "dlq_not_found", "DLQ entry not found", nil)
		case errors.Is(err, engine.ErrValidateFixFailingNodeMissing):
			return opError(http.StatusBadRequest, "dlq_failing_node_missing",
				"suggestedWorkflow does not contain the failing node id", nil)
		default:
			return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
		}
	}
	audit.Write(r.Context(), s.pool, rc.authContext, "recovery.validation_started", audit.Options{
		TargetType: "dlq", TargetID: body.DeadLetterID,
		Metadata: map[string]any{"validationRunId": runID},
	})
	return opOK(map[string]any{"runId": runID})
}

func (s *V1Server) mountValidateFixRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/dlq/validate-fix", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeVersioned(w, rc.id, s.validateFixCore(r, rc))
	}))
	mux.HandleFunc("POST /dlq/validate-fix", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeLegacy(w, s.validateFixCore(r, rc))
	}))
}

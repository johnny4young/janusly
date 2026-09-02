package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/johnny4young/janusly/internal/ai"
	"github.com/johnny4young/janusly/internal/aibudget"
	"github.com/johnny4young/janusly/internal/aiconfig"
	"github.com/johnny4young/janusly/internal/aidiagnosis"
	"github.com/johnny4young/janusly/internal/auth"
	"github.com/johnny4young/janusly/internal/engine"
	"github.com/johnny4young/janusly/internal/ratelimit"
	"github.com/johnny4young/janusly/internal/store"
)

const governedRecoveryBodyMaxBytes = 128_000

func decodeGovernedRecoveryBody(r *http.Request, target any) error {
	decoder := json.NewDecoder(http.MaxBytesReader(nil, r.Body, governedRecoveryBodyMaxBytes))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errors.New("request must contain one JSON object")
	}
	return nil
}

func recoveryArtifactView(row store.RecoveryCaseArtifact) map[string]any {
	return map[string]any{
		"id": row.ID, "caseId": row.CaseID, "kind": row.Kind,
		"payload": rawOrNull(row.PayloadJson), "sha256": row.PayloadSha256,
		"actorKind": row.ActorKind, "actorId": textOrNull(row.ActorID),
		"createdAt": row.CreatedAt,
	}
}

func recoveryMutationError(err error) opResult {
	switch {
	case errors.Is(err, engine.ErrRecoveryCaseNotFound):
		return opError(http.StatusNotFound, "recovery_case_not_found", "Recovery case not found", nil)
	case errors.Is(err, engine.ErrRecoveryCaseConflict), errors.Is(err, engine.ErrRecoveryCaseReceiptGone),
		errors.Is(err, engine.ErrRecoveryApprovalMissing):
		return opError(http.StatusConflict, "recovery_case_conflict",
			"The recovery case changed or its approval is no longer valid", nil)
	case errors.Is(err, engine.ErrRecoveryArtifactTooLarge):
		return opError(http.StatusRequestEntityTooLarge, "recovery_artifact_too_large",
			"Recovery evidence exceeds the 64 KB artifact limit", nil)
	case errors.Is(err, engine.ErrRecoverySemanticInputInvalid):
		return opError(http.StatusBadRequest, "recovery_invalid_request", "Invalid recovery request", nil)
	case errors.Is(err, engine.ErrRecoveryHumanApprovalRequired):
		return opError(http.StatusForbidden, "recovery_human_approval_required",
			"Recovery approval requires a human-authenticated session", nil)
	case errors.Is(err, engine.ErrRecoveryPolicyBlocked):
		return opError(http.StatusForbidden, "recovery_policy_blocked",
			"The workflow recovery contract does not permit this action", nil)
	case errors.Is(err, engine.ErrRecoverySemanticOutputInvalid):
		var outputErr *engine.RecoverySemanticOutputError
		params := map[string]any{}
		if errors.As(err, &outputErr) {
			params["reason"] = outputErr.Reason
			params["violations"] = outputErr.Violations
		}
		return opError(http.StatusUnprocessableEntity, "recovery_candidate_invalid",
			"The replacement output does not satisfy the business outcome contract", params)
	default:
		// Recovery failures can wrap SQL text, provider evidence, or sanitized
		// artifact context. Never reflect those details through either public error
		// envelope.
		return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
}

type recoveryRevisionBody struct {
	ExpectedRevision int64 `json:"expectedRevision"`
}

// optionalRecoveryDiagnosisEnrichment is deliberately fail-soft. Permission,
// provider, rate, budget, evidence-load, transport and parse failures all
// return nil so the engine records its deterministic diagnosis instead. The
// recovery.write route gate remains authoritative for the mutation itself.
func (s *V1Server) optionalRecoveryDiagnosisEnrichment(
	r *http.Request,
	rc v1Request,
	caseID string,
	expectedRevision int64,
	language string,
) *aidiagnosis.Enrichment {
	permissions, rejection := s.effectivePermissions(r, rc)
	if rejection != nil || !permissions["ai.write"] {
		return nil
	}
	client, settings := aiconfig.Resolve(r.Context(), s.pool, rc.orgID)
	if !client.Configured() {
		return nil
	}
	facts, err := s.engine.LoadRecoveryDiagnosisFacts(
		r.Context(), rc.orgID, caseID, expectedRevision, language,
	)
	if err != nil {
		return nil
	}
	if s.limiter != nil {
		if err := s.limiter.Enforce(r.Context(), rc.orgID, ratelimit.Options{
			Name: "ai", Max: settings.RateLimitPerMin, Window: time.Minute,
		}); err != nil {
			return nil
		}
	}
	if gate := aibudget.Gate(r.Context(), s.pool, rc.orgID, rc.userID, "ai.recovery.diagnosed"); !gate.Allowed {
		return nil
	}
	generated, aiErr := aidiagnosis.Generate(r.Context(), client, aidiagnosis.GenerateInput{
		Evidence: facts.AIEvidence(),
		Context:  ai.CallContext{OrgID: rc.orgID, UserID: rc.userID},
	})
	if aiErr != nil {
		return nil
	}
	return &generated.Enrichment
}

func (s *V1Server) diagnoseRecoveryCaseCore(r *http.Request, rc v1Request) opResult {
	var body recoveryRevisionBody
	if decodeGovernedRecoveryBody(r, &body) != nil || body.ExpectedRevision < 1 {
		return opError(http.StatusBadRequest, "recovery_invalid_request", "Invalid recovery request", nil)
	}
	caseID := r.PathValue("caseId")
	language := localeFromRequest(r)
	enrichment := s.optionalRecoveryDiagnosisEnrichment(
		r, rc, caseID, body.ExpectedRevision, language,
	)
	result, err := s.engine.DiagnoseRecoveryCase(r.Context(), engine.DiagnoseRecoveryCaseInput{
		Auth: rc.authContext, CaseID: caseID, ExpectedRevision: body.ExpectedRevision,
		Language: language, Enrichment: enrichment,
	})
	if err != nil {
		return recoveryMutationError(err)
	}
	return opOK(map[string]any{
		"case": recoveryCaseView(result.Case), "diagnosis": recoveryArtifactView(result.Diagnosis),
		"mode": result.Mode,
	})
}

type manualReplacementBody struct {
	Output any    `json:"output"`
	Reason string `json:"reason"`
}

type recoveryCandidatesBody struct {
	ExpectedRevision  int64                  `json:"expectedRevision"`
	ManualReplacement *manualReplacementBody `json:"manualReplacement,omitempty"`
	AcceptLossReason  string                 `json:"acceptLossReason,omitempty"`
}

func decodeRecoveryCandidatesRequest(r *http.Request) (recoveryCandidatesBody, error) {
	var wire struct {
		ExpectedRevision  int64           `json:"expectedRevision"`
		ManualReplacement json.RawMessage `json:"manualReplacement"`
		AcceptLossReason  json.RawMessage `json:"acceptLossReason"`
	}
	if err := decodeGovernedRecoveryBody(r, &wire); err != nil {
		return recoveryCandidatesBody{}, err
	}
	body := recoveryCandidatesBody{ExpectedRevision: wire.ExpectedRevision}
	if len(wire.AcceptLossReason) > 0 {
		if bytes.Equal(bytes.TrimSpace(wire.AcceptLossReason), []byte("null")) ||
			json.Unmarshal(wire.AcceptLossReason, &body.AcceptLossReason) != nil {
			return recoveryCandidatesBody{}, errors.New("acceptLossReason must be a string")
		}
	}
	if len(wire.ManualReplacement) == 0 {
		return body, nil
	}
	if bytes.Equal(bytes.TrimSpace(wire.ManualReplacement), []byte("null")) {
		return recoveryCandidatesBody{}, errors.New("manualReplacement must be an object")
	}
	var manualWire struct {
		Output json.RawMessage `json:"output"`
		Reason json.RawMessage `json:"reason"`
	}
	decoder := json.NewDecoder(bytes.NewReader(wire.ManualReplacement))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&manualWire); err != nil || len(manualWire.Output) == 0 || len(manualWire.Reason) == 0 {
		return recoveryCandidatesBody{}, errors.New("manualReplacement must contain output and reason")
	}
	var output any
	if json.Unmarshal(manualWire.Output, &output) != nil {
		return recoveryCandidatesBody{}, errors.New("manualReplacement output must be JSON")
	}
	var reason string
	if bytes.Equal(bytes.TrimSpace(manualWire.Reason), []byte("null")) || json.Unmarshal(manualWire.Reason, &reason) != nil {
		return recoveryCandidatesBody{}, errors.New("manualReplacement reason must be a string")
	}
	body.ManualReplacement = &manualReplacementBody{Output: output, Reason: reason}
	return body, nil
}

func (s *V1Server) createRecoveryCandidatesCore(r *http.Request, rc v1Request) opResult {
	body, err := decodeRecoveryCandidatesRequest(r)
	if err != nil || body.ExpectedRevision < 1 {
		return opError(http.StatusBadRequest, "recovery_invalid_request", "Invalid recovery request", nil)
	}
	var manual *engine.SemanticManualReplacement
	if body.ManualReplacement != nil {
		manual = &engine.SemanticManualReplacement{
			Output: body.ManualReplacement.Output, Reason: body.ManualReplacement.Reason,
		}
	}
	result, err := s.engine.CreateRecoveryCandidates(r.Context(), engine.CreateRecoveryCandidatesInput{
		Auth: rc.authContext, CaseID: r.PathValue("caseId"), ExpectedRevision: body.ExpectedRevision,
		ManualReplacement: manual, AcceptLossReason: body.AcceptLossReason,
	})
	if err != nil {
		return recoveryMutationError(err)
	}
	views := make([]map[string]any, 0, len(result.Candidates))
	for _, artifact := range result.Candidates {
		views = append(views, recoveryArtifactView(artifact))
	}
	return opOK(map[string]any{"case": recoveryCaseView(result.Case), "candidates": views})
}

type recoveryCandidateBindingBody struct {
	ExpectedRevision    int64  `json:"expectedRevision"`
	CandidateArtifactID string `json:"candidateArtifactId"`
}

func (s *V1Server) validateRecoveryCandidateCore(r *http.Request, rc v1Request) opResult {
	var body recoveryCandidateBindingBody
	if decodeGovernedRecoveryBody(r, &body) != nil || body.ExpectedRevision < 1 || body.CandidateArtifactID == "" {
		return opError(http.StatusBadRequest, "recovery_invalid_request", "Invalid recovery request", nil)
	}
	result, err := s.engine.ValidateRecoveryCaseCandidate(r.Context(), engine.ValidateRecoveryCaseCandidateInput{
		Auth: rc.authContext, CaseID: r.PathValue("caseId"), ExpectedRevision: body.ExpectedRevision,
		CandidateArtifactID: body.CandidateArtifactID,
	})
	if err != nil {
		return recoveryMutationError(err)
	}
	return opOK(map[string]any{
		"case": recoveryCaseView(result.Case), "validation": recoveryArtifactView(result.Validation),
		"passed": result.Passed,
	})
}

type recoveryApprovalBody struct {
	ExpectedRevision     int64  `json:"expectedRevision"`
	CandidateArtifactID  string `json:"candidateArtifactId"`
	ValidationArtifactID string `json:"validationArtifactId"`
}

func (s *V1Server) approveRecoveryCandidateCore(r *http.Request, rc v1Request) opResult {
	var body recoveryApprovalBody
	if decodeGovernedRecoveryBody(r, &body) != nil || body.ExpectedRevision < 1 ||
		body.CandidateArtifactID == "" || body.ValidationArtifactID == "" {
		return opError(http.StatusBadRequest, "recovery_invalid_request", "Invalid recovery request", nil)
	}
	grant, err := s.engine.ApproveRecoveryCandidate(r.Context(), engine.ApproveRecoveryCandidateInput{
		Auth: rc.authContext, CaseID: r.PathValue("caseId"), ExpectedRevision: body.ExpectedRevision,
		CandidateArtifactID: body.CandidateArtifactID, ValidationArtifactID: body.ValidationArtifactID,
	})
	if err != nil {
		return recoveryMutationError(err)
	}
	return opOK(map[string]any{
		"approval": map[string]any{
			"id": grant.ID, "caseId": grant.CaseID, "caseRevision": grant.CaseRevision,
			"candidateArtifactId":  grant.CandidateArtifactID,
			"validationArtifactId": grant.ValidationArtifactID,
			"expiresAt":            grant.ExpiresAt,
		},
	})
}

func (s *V1Server) applyRecoveryCandidateCore(r *http.Request, rc v1Request) opResult {
	var body recoveryApprovalBody
	if decodeGovernedRecoveryBody(r, &body) != nil || body.ExpectedRevision < 1 ||
		body.CandidateArtifactID == "" || body.ValidationArtifactID == "" {
		return opError(http.StatusBadRequest, "recovery_invalid_request", "Invalid recovery request", nil)
	}
	result, err := s.engine.ResolveSemanticOutcomeCase(r.Context(), engine.ResolveSemanticOutcomeInput{
		Auth: rc.authContext, CaseID: r.PathValue("caseId"), ExpectedRevision: body.ExpectedRevision,
		CandidateArtifactID: body.CandidateArtifactID, ValidationArtifactID: body.ValidationArtifactID,
	})
	if err != nil {
		return recoveryMutationError(err)
	}
	return opOK(map[string]any{
		"runId": result.RunID, "sourceNodeId": result.SourceNodeID,
		"decision": result.Decision, "resumed": result.Resumed,
		"resolvedCaseIds": result.ResolvedCaseIDs,
	})
}

func (s *V1Server) mountSemanticRecoveryRoutes(mux *http.ServeMux) {
	gate := routeGate{auth.RoleEditor, "recovery.write"}
	type operation struct {
		suffix string
		core   func(*http.Request, v1Request) opResult
	}
	operations := []operation{
		{"diagnose", s.diagnoseRecoveryCaseCore},
		{"candidates", s.createRecoveryCandidatesCore},
		{"validate", s.validateRecoveryCandidateCore},
		{"approve", s.approveRecoveryCandidateCore},
		{"apply", s.applyRecoveryCandidateCore},
	}
	for _, item := range operations {
		unversioned := "POST /recovery/cases/{caseId}/" + item.suffix
		versioned := "POST /v1/recovery/cases/{caseId}/" + item.suffix
		s.route(mux, unversioned, gate, func(w http.ResponseWriter, r *http.Request, rc v1Request) {
			writeUnversioned(w, item.core(r, rc))
		})
		s.route(mux, versioned, gate, func(w http.ResponseWriter, r *http.Request, rc v1Request) {
			writeVersioned(w, rc.id, item.core(r, rc))
		})
	}
}

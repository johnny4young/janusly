package engine

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"github.com/johnny4young/janusly/internal/auth"
	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/recovery"
	"github.com/johnny4young/janusly/internal/store"
)

var (
	// ErrRecoveryPolicyBlocked is returned when the strictest open detector
	// does not grant apply-with-approval authority.
	ErrRecoveryPolicyBlocked = errors.New("semantic recovery policy blocked")
	// ErrRecoverySemanticOutputInvalid means the proposed replacement cannot
	// become the persisted source output under the immutable run contract.
	ErrRecoverySemanticOutputInvalid = errors.New("semantic recovery output invalid")
	// ErrRecoverySemanticInputInvalid protects the engine boundary even when
	// a caller bypasses the HTTP contract validator.
	ErrRecoverySemanticInputInvalid = errors.New("semantic recovery input invalid")
)

// RecoveryPolicyBlockedError retains the explainable effective profile while
// remaining matchable through errors.Is.
type RecoveryPolicyBlockedError struct {
	Profile domain.RecoveryAutonomyProfile
}

func (e *RecoveryPolicyBlockedError) Error() string { return ErrRecoveryPolicyBlocked.Error() }
func (e *RecoveryPolicyBlockedError) Unwrap() error { return ErrRecoveryPolicyBlocked }

// RecoverySemanticOutputError retains bounded detector evidence for the 422
// response without ever echoing the operator's replacement payload.
type RecoverySemanticOutputError struct {
	Reason     string
	Violations []recovery.SemanticOutcomeViolation
}

func (e *RecoverySemanticOutputError) Error() string { return ErrRecoverySemanticOutputInvalid.Error() }
func (e *RecoverySemanticOutputError) Unwrap() error { return ErrRecoverySemanticOutputInvalid }

// RecoveryCaseDetail is the complete operator projection for one semantic
// case: durable fact, append-only transition history, and policy derived from
// the immutable workflow snapshot.
type RecoveryCaseDetail struct {
	Case        store.RecoveryCase
	Transitions []store.RecoveryCaseTransition
	Artifacts   []store.RecoveryCaseArtifact
	Autonomy    domain.RecoveryAutonomyProfile
}

// GetRecoveryCaseDetail resolves a case exclusively inside one organization.
func (e *Engine) GetRecoveryCaseDetail(ctx context.Context, orgID, caseID string) (RecoveryCaseDetail, error) {
	q := store.New(e.pool)
	item, err := q.GetRecoveryCase(ctx, store.GetRecoveryCaseParams{OrgID: orgID, ID: caseID})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return RecoveryCaseDetail{}, ErrRecoveryCaseNotFound
		}
		return RecoveryCaseDetail{}, fmt.Errorf("read recovery case: %w", err)
	}
	// The governed detail/API/MCP surface is exclusively for semantic outcome
	// cases. Treat every other recovery source as absent so a future or legacy
	// case family cannot accidentally inherit semantic policy projections or
	// mutation affordances merely because it shares the storage table.
	if item.Source != semanticRecoveryCaseSource {
		return RecoveryCaseDetail{}, ErrRecoveryCaseNotFound
	}
	// Cases are durable incident evidence and intentionally outlive the run
	// retention window. A missing run must therefore degrade the derived
	// autonomy profile rather than make an otherwise valid case disappear.
	var contract *domain.RecoveryContract
	run, err := q.GetRun(ctx, store.GetRunParams{ID: item.RunID, OrgID: orgID})
	if err == nil {
		wf, _, parseErr := workflowFromRunInput(run.InputJson)
		if parseErr != nil {
			return RecoveryCaseDetail{}, fmt.Errorf("read recovery case workflow snapshot: %w", parseErr)
		}
		if wf.Recovery != nil {
			contract = wf.Recovery.Contract
		}
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return RecoveryCaseDetail{}, fmt.Errorf("read recovery case run: %w", err)
	}
	transitionRows, err := q.ListRecoveryCaseTransitions(ctx, store.ListRecoveryCaseTransitionsParams{
		OrgID: orgID, CaseID: caseID,
	})
	if err != nil {
		return RecoveryCaseDetail{}, fmt.Errorf("read recovery case transitions: %w", err)
	}
	transitions := make([]store.RecoveryCaseTransition, len(transitionRows))
	for index, row := range transitionRows {
		transitions[index] = store.RecoveryCaseTransition(row)
	}
	artifactRows, err := q.ListRecoveryCaseArtifacts(ctx, store.ListRecoveryCaseArtifactsParams{
		OrgID: orgID, CaseID: caseID,
	})
	if err != nil {
		return RecoveryCaseDetail{}, fmt.Errorf("read recovery case artifacts: %w", err)
	}
	artifacts := make([]store.RecoveryCaseArtifact, len(artifactRows))
	for index, row := range artifactRows {
		artifacts[index] = store.RecoveryCaseArtifact(row)
	}
	return RecoveryCaseDetail{
		Case: item, Transitions: transitions, Artifacts: artifacts,
		Autonomy: domain.ResolveRecoveryAutonomyProfile(contract, domain.RecoveryFailureClass{
			Kind: "semantic", DetectorID: item.DetectorID,
		}),
	}, nil
}

// ResolveSemanticOutcomeInput is one authenticated operator decision. Auth is
// mandatory: its tenant and actor drive every query, receipt, and audit row.
type ResolveSemanticOutcomeInput struct {
	Auth                 *auth.Context
	CaseID               string
	ExpectedRevision     int64
	CandidateArtifactID  string
	ValidationArtifactID string
}

// SemanticRecoveryCandidatePayload is the immutable action consumed by
// apply. Callers provide only an artifact id, so validated bytes cannot be
// swapped between approval and publication.
type SemanticRecoveryCandidatePayload struct {
	Kind                string                           `json:"kind"`
	Decision            string                           `json:"decision"`
	Output              any                              `json:"output,omitempty"`
	Target              *SemanticRecoveryCandidateTarget `json:"target,omitempty"`
	Reason              string                           `json:"reason"`
	Risk                string                           `json:"risk"`
	Evidence            []domain.RecoveryCaseEvidenceRef `json:"evidence"`
	ExpectedResult      string                           `json:"expectedResult"`
	RequiredPermissions []string                         `json:"requiredPermissions"`
}

// SemanticRecoveryCandidateTarget binds recommendation-only candidates to
// immutable identifiers. It intentionally carries no patch or detector JSON.
type SemanticRecoveryCandidateTarget struct {
	WorkflowID        string `json:"workflowId,omitempty"`
	WorkflowVersionID string `json:"workflowVersionId,omitempty"`
	DetectorID        string `json:"detectorId,omitempty"`
}

// SemanticRecoveryValidationPayload binds a validation pass to the exact
// content-addressed candidate and case revision that was inspected.
type SemanticRecoveryValidationPayload struct {
	CandidateArtifactID string `json:"candidateArtifactId"`
	CandidateSha256     string `json:"candidateSha256"`
	CaseRevision        int64  `json:"caseRevision"`
	Passed              bool   `json:"passed"`
	Summary             string `json:"summary"`
}

func isLowerHexSha256(value string) bool {
	if len(value) != 64 {
		return false
	}
	for _, character := range value {
		if (character < '0' || character > '9') && (character < 'a' || character > 'f') {
			return false
		}
	}
	return true
}

// currentRecoveryValidation binds the artifact to the exact lifecycle point
// that produced the present awaiting_approval revision. Validation advances
// candidates_ready -> validating -> awaiting_approval, so any other delta
// proves that the case changed after this artifact was inspected.
func currentRecoveryValidation(validationRevision, caseRevision int64) bool {
	return caseRevision > 2 && validationRevision == caseRevision-2
}

// ParseSemanticRecoveryCandidatePayload is the single immutable-envelope
// decoder used by validation, approval/apply and the MCP permission guard.
// It validates shape and the closed decision/kind pairing without executing
// or returning any authority by itself.
func ParseSemanticRecoveryCandidatePayload(raw json.RawMessage) (SemanticRecoveryCandidatePayload, error) {
	var candidate SemanticRecoveryCandidatePayload
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&candidate) != nil || decoder.Decode(&struct{}{}) != io.EOF ||
		!validSemanticRecoveryCandidateEnvelope(candidate) {
		return SemanticRecoveryCandidatePayload{}, ErrRecoverySemanticInputInvalid
	}
	switch candidate.Decision {
	case "accept_loss":
		if candidate.Kind != "accept_loss" || candidate.Output != nil || candidate.Target != nil {
			return SemanticRecoveryCandidatePayload{}, ErrRecoverySemanticInputInvalid
		}
	case "replace":
		if candidate.Kind != "replace_output" || candidate.Target != nil {
			return SemanticRecoveryCandidatePayload{}, ErrRecoverySemanticInputInvalid
		}
	case "manual_follow_up":
		if candidate.Output != nil || candidate.Target == nil ||
			candidate.Target.WorkflowID == "" || candidate.Target.WorkflowVersionID == "" ||
			utf8.RuneCountInString(candidate.Target.WorkflowID) > 200 ||
			utf8.RuneCountInString(candidate.Target.WorkflowVersionID) > 200 ||
			utf8.RuneCountInString(candidate.Target.DetectorID) > 200 {
			return SemanticRecoveryCandidatePayload{}, ErrRecoverySemanticInputInvalid
		}
		switch candidate.Kind {
		case "repair_workflow":
			if candidate.Target.DetectorID != "" {
				return SemanticRecoveryCandidatePayload{}, ErrRecoverySemanticInputInvalid
			}
		case "adjust_detector":
			if candidate.Target.DetectorID == "" {
				return SemanticRecoveryCandidatePayload{}, ErrRecoverySemanticInputInvalid
			}
		default:
			return SemanticRecoveryCandidatePayload{}, ErrRecoverySemanticInputInvalid
		}
	default:
		return SemanticRecoveryCandidatePayload{}, ErrRecoverySemanticInputInvalid
	}
	return candidate, nil
}

// ParseSemanticRecoveryValidationPayload is the only decoder for the
// content-addressed validation authority consumed by approval, apply, and MCP
// projection. Presence matters because `passed:false` is a legitimate result,
// so typed zero values cannot prove that the wire field existed.
func ParseSemanticRecoveryValidationPayload(raw json.RawMessage) (SemanticRecoveryValidationPayload, error) {
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil || fields == nil || len(fields) != 5 {
		return SemanticRecoveryValidationPayload{}, ErrRecoverySemanticInputInvalid
	}
	for _, field := range []string{
		"candidateArtifactId", "candidateSha256", "caseRevision", "passed", "summary",
	} {
		if _, present := fields[field]; !present {
			return SemanticRecoveryValidationPayload{}, ErrRecoverySemanticInputInvalid
		}
	}
	var validation SemanticRecoveryValidationPayload
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&validation) != nil || decoder.Decode(&struct{}{}) != io.EOF ||
		strings.TrimSpace(validation.CandidateArtifactID) == "" ||
		len(validation.CandidateArtifactID) > 256 ||
		!isLowerHexSha256(validation.CandidateSha256) || validation.CaseRevision < 1 ||
		strings.TrimSpace(validation.Summary) == "" || utf8.RuneCountInString(validation.Summary) > 500 {
		return SemanticRecoveryValidationPayload{}, ErrRecoverySemanticInputInvalid
	}
	return validation, nil
}

// ValidateSemanticRecoveryCandidate evaluates an immutable candidate against
// the run's immutable workflow snapshot without changing run or case state.
// A business-rule rejection is returned as Passed=false; malformed or
// cross-tenant artifacts fail closed with an error.
func (e *Engine) ValidateSemanticRecoveryCandidate(
	ctx context.Context, orgID, caseID, candidateArtifactID string,
) (SemanticRecoveryValidationPayload, error) {
	q := store.New(e.pool)
	caseRow, err := q.GetRecoveryCase(ctx, store.GetRecoveryCaseParams{OrgID: orgID, ID: caseID})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return SemanticRecoveryValidationPayload{}, ErrRecoveryCaseNotFound
		}
		return SemanticRecoveryValidationPayload{}, err
	}
	if caseRow.Source != semanticRecoveryCaseSource {
		return SemanticRecoveryValidationPayload{}, ErrRecoveryCaseConflict
	}
	artifact, err := q.GetRecoveryCaseArtifact(ctx, store.GetRecoveryCaseArtifactParams{
		OrgID: orgID, CaseID: caseID, ID: candidateArtifactID,
	})
	if err != nil || artifact.Kind != "candidate" {
		return SemanticRecoveryValidationPayload{}, ErrRecoveryCaseConflict
	}
	result := SemanticRecoveryValidationPayload{
		CandidateArtifactID: artifact.ID, CandidateSha256: artifact.PayloadSha256,
		CaseRevision: caseRow.Revision,
	}
	candidate, err := ParseSemanticRecoveryCandidatePayload(artifact.PayloadJson)
	if err != nil {
		return SemanticRecoveryValidationPayload{}, ErrRecoverySemanticInputInvalid
	}
	switch candidate.Decision {
	case "accept_loss":
		result.Passed = true
		result.Summary = "Loss acknowledgement is structurally valid and still requires human approval"
		return result, nil
	case "replace":
	case "manual_follow_up":
		if !caseRow.WorkflowID.Valid || candidate.Target.WorkflowID != caseRow.WorkflowID.String ||
			candidate.Target.WorkflowVersionID != caseRow.WorkflowVersionID ||
			(candidate.Kind == "adjust_detector" && candidate.Target.DetectorID != caseRow.DetectorID) {
			return SemanticRecoveryValidationPayload{}, ErrRecoverySemanticInputInvalid
		}
		switch candidate.Kind {
		case "repair_workflow":
			result.Summary = "Workflow repair requires an independently saved and qualified successor version before recovery can be applied"
		case "adjust_detector":
			result.Summary = "Detector adjustment requires an independently saved and qualified successor version and cannot rewrite this immutable run snapshot"
		}
		return result, nil
	default:
		return SemanticRecoveryValidationPayload{}, ErrRecoverySemanticInputInvalid
	}

	run, err := q.GetRun(ctx, store.GetRunParams{ID: caseRow.RunID, OrgID: orgID})
	if err != nil {
		return SemanticRecoveryValidationPayload{}, ErrRecoveryCaseConflict
	}
	wf, _, err := workflowFromRunInput(run.InputJson)
	if err != nil || wf.Recovery == nil || wf.Recovery.Contract == nil || wf.Recovery.Contract.Version != "2" {
		return SemanticRecoveryValidationPayload{}, ErrRecoveryCaseConflict
	}
	profile := domain.ResolveRecoveryAutonomyProfile(wf.Recovery.Contract, domain.RecoveryFailureClass{
		Kind: "semantic", DetectorID: caseRow.DetectorID,
	})
	if !profile.Capabilities.ApplyWithApproval {
		result.Summary = "Recovery contract does not permit replacement output"
		return result, nil
	}
	persistedOutput, _, invalidReason := prepareSemanticReplacement(candidate.Output)
	if invalidReason != "" {
		result.Summary = invalidReason
		return result, nil
	}
	nodes, err := q.ListRunNodesByRun(ctx, caseRow.RunID)
	if err != nil {
		return SemanticRecoveryValidationPayload{}, err
	}
	evaluation := recovery.EvaluateSemanticOutcome(struct {
		Contract     *domain.RecoveryContract
		SourceNodeID string
		Output       any
		Context      map[string]any
	}{
		Contract: wf.Recovery.Contract, SourceNodeID: caseRow.SourceNodeID,
		Output: persistedOutput, Context: runContextFromRows(nodes),
	})
	if evaluation.Evaluated == 0 {
		result.Summary = "No deterministic detector evaluated the replacement output"
		return result, nil
	}
	if len(evaluation.Violations) > 0 {
		result.Summary = "Replacement output still violates the business outcome contract"
		return result, nil
	}
	result.Passed = true
	result.Summary = "Replacement output passed every deterministic detector"
	return result, nil
}

func validSemanticRecoveryCandidateEnvelope(candidate SemanticRecoveryCandidatePayload) bool {
	if strings.TrimSpace(candidate.Reason) == "" || utf8.RuneCountInString(candidate.Reason) > 1_000 ||
		strings.TrimSpace(candidate.ExpectedResult) == "" || utf8.RuneCountInString(candidate.ExpectedResult) > 500 ||
		(candidate.Risk != "low" && candidate.Risk != "medium" && candidate.Risk != "high") ||
		len(candidate.RequiredPermissions) == 0 || len(candidate.RequiredPermissions) > 4 ||
		len(candidate.Evidence) == 0 || len(candidate.Evidence) > 20 {
		return false
	}
	permissions := map[string]bool{}
	for _, permission := range candidate.RequiredPermissions {
		if (permission != "recovery.write" && permission != "workflows.write") || permissions[permission] {
			return false
		}
		permissions[permission] = true
	}
	if !permissions["recovery.write"] {
		return false
	}
	if (candidate.Kind == "repair_workflow" || candidate.Kind == "adjust_detector") && !permissions["workflows.write"] {
		return false
	}
	for _, evidence := range candidate.Evidence {
		if !domain.RecoveryCaseEvidenceKinds[evidence.Kind] || evidence.ID == "" || len(evidence.ID) > 500 ||
			(evidence.Sha256 != "" && !isLowerHexSha256(evidence.Sha256)) {
			return false
		}
	}
	return true
}

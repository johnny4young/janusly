package engine

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/internal/audit"
	"github.com/johnny4young/janusly/internal/auth"
	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/grammar"
	"github.com/johnny4young/janusly/internal/recovery"
	"github.com/johnny4young/janusly/internal/signature"
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
	transitions, err := q.ListRecoveryCaseTransitions(ctx, store.ListRecoveryCaseTransitionsParams{
		OrgID: orgID, CaseID: caseID,
	})
	if err != nil {
		return RecoveryCaseDetail{}, fmt.Errorf("read recovery case transitions: %w", err)
	}
	artifacts, err := q.ListRecoveryCaseArtifacts(ctx, store.ListRecoveryCaseArtifactsParams{
		OrgID: orgID, CaseID: caseID,
	})
	if err != nil {
		return RecoveryCaseDetail{}, fmt.Errorf("read recovery case artifacts: %w", err)
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

// ParseSemanticRecoveryCandidatePayload is the single immutable-envelope
// decoder used by validation, approval/apply and the MCP permission guard.
// It validates shape and the closed decision/kind pairing without executing
// or returning any authority by itself.
func ParseSemanticRecoveryCandidatePayload(raw json.RawMessage) (SemanticRecoveryCandidatePayload, error) {
	var candidate SemanticRecoveryCandidatePayload
	if json.Unmarshal(raw, &candidate) != nil || !validSemanticRecoveryCandidateEnvelope(candidate) {
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
		if !domain.RecoveryCaseEvidenceKinds[evidence.Kind] || evidence.ID == "" || len(evidence.ID) > 500 {
			return false
		}
	}
	return true
}

// ResolveSemanticOutcomeResult is the committed semantic resolution receipt.
type ResolveSemanticOutcomeResult struct {
	RunID           string
	SourceNodeID    string
	Decision        string
	Resumed         bool
	ResolvedCaseIDs []string
}

// ResolveSemanticOutcomeCase resolves every detected/contained sibling for
// the same source node in one transaction. Locks follow node -> run -> cases;
// the replacement is evaluated only after those locks against the immutable
// workflow snapshot and the exact sanitized value that will be persisted.
func (e *Engine) ResolveSemanticOutcomeCase(
	ctx context.Context, input ResolveSemanticOutcomeInput,
) (ResolveSemanticOutcomeResult, error) {
	if input.Auth == nil || input.Auth.OrgID == "" || input.Auth.UserID == "" {
		return ResolveSemanticOutcomeResult{}, fmt.Errorf("%w: authenticated actor required", ErrRecoverySemanticInputInvalid)
	}
	if input.CaseID == "" || utf8.RuneCountInString(input.CaseID) > 256 ||
		input.ExpectedRevision < 1 || input.CandidateArtifactID == "" ||
		input.ValidationArtifactID == "" {
		return ResolveSemanticOutcomeResult{}, ErrRecoverySemanticInputInvalid
	}
	orgID := input.Auth.OrgID
	snapshot, err := store.New(e.pool).GetRecoveryCase(ctx, store.GetRecoveryCaseParams{
		OrgID: orgID, ID: input.CaseID,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ResolveSemanticOutcomeResult{}, ErrRecoveryCaseNotFound
		}
		return ResolveSemanticOutcomeResult{}, fmt.Errorf("read semantic recovery case: %w", err)
	}

	tx, err := e.pool.Begin(ctx)
	if err != nil {
		return ResolveSemanticOutcomeResult{}, fmt.Errorf("begin semantic recovery: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	wrapped := e.wrapTx(tx)
	q := store.New(wrapped)

	lockedNodes, err := q.LockRunNodesForSemanticResolution(ctx, store.LockRunNodesForSemanticResolutionParams{
		RunID: snapshot.RunID, OrgID: orgID,
	})
	if err != nil {
		return ResolveSemanticOutcomeResult{}, fmt.Errorf("lock semantic recovery nodes: %w", err)
	}
	lockedRun, err := q.LockRunForSemanticResolution(ctx, store.LockRunForSemanticResolutionParams{
		ID: snapshot.RunID, OrgID: orgID,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ResolveSemanticOutcomeResult{}, ErrRecoveryCaseConflict
		}
		return ResolveSemanticOutcomeResult{}, fmt.Errorf("lock semantic recovery run: %w", err)
	}
	openCases, err := q.LockOpenSemanticRecoveryCases(ctx, store.LockOpenSemanticRecoveryCasesParams{
		OrgID: orgID, RunID: snapshot.RunID, SourceNodeID: snapshot.SourceNodeID,
	})
	if err != nil {
		return ResolveSemanticOutcomeResult{}, fmt.Errorf("lock semantic recovery cases: %w", err)
	}
	targetIndex := slices.IndexFunc(openCases, func(item store.RecoveryCase) bool {
		return item.ID == input.CaseID
	})
	if targetIndex < 0 {
		return ResolveSemanticOutcomeResult{}, ErrRecoveryCaseConflict
	}
	target := openCases[targetIndex]
	if target.Revision != input.ExpectedRevision {
		return ResolveSemanticOutcomeResult{}, ErrRecoveryCaseConflict
	}
	candidateArtifact, err := q.GetRecoveryCaseArtifact(ctx, store.GetRecoveryCaseArtifactParams{
		OrgID: orgID, CaseID: input.CaseID, ID: input.CandidateArtifactID,
	})
	if err != nil || candidateArtifact.Kind != "candidate" {
		return ResolveSemanticOutcomeResult{}, ErrRecoveryCaseConflict
	}
	validationArtifact, err := q.GetRecoveryCaseArtifact(ctx, store.GetRecoveryCaseArtifactParams{
		OrgID: orgID, CaseID: input.CaseID, ID: input.ValidationArtifactID,
	})
	if err != nil || validationArtifact.Kind != "validation" {
		return ResolveSemanticOutcomeResult{}, ErrRecoveryCaseConflict
	}
	var candidate SemanticRecoveryCandidatePayload
	var validation SemanticRecoveryValidationPayload
	candidate, candidateErr := ParseSemanticRecoveryCandidatePayload(candidateArtifact.PayloadJson)
	if candidateErr != nil || json.Unmarshal(validationArtifact.PayloadJson, &validation) != nil ||
		!validation.Passed || validation.CandidateArtifactID != candidateArtifact.ID ||
		validation.CandidateSha256 != candidateArtifact.PayloadSha256 ||
		validation.CaseRevision >= target.Revision {
		return ResolveSemanticOutcomeResult{}, ErrRecoveryCaseConflict
	}
	candidate.Reason = strings.TrimSpace(candidate.Reason)
	if candidate.Decision != "replace" && candidate.Decision != "accept_loss" {
		return ResolveSemanticOutcomeResult{}, ErrRecoverySemanticInputInvalid
	}
	if candidate.Reason == "" || utf8.RuneCountInString(candidate.Reason) > 1_000 {
		return ResolveSemanticOutcomeResult{}, ErrRecoverySemanticInputInvalid
	}
	now := e.now().UTC().Truncate(time.Millisecond)
	grant, err := q.FindActiveRecoveryApprovalGrant(ctx, store.FindActiveRecoveryApprovalGrantParams{
		OrgID: orgID, CaseID: input.CaseID,
		CandidateArtifactID:  input.CandidateArtifactID,
		ValidationArtifactID: input.ValidationArtifactID,
		CaseRevision:         input.ExpectedRevision, NowAt: now,
	})
	if err != nil {
		return ResolveSemanticOutcomeResult{}, ErrRecoveryCaseConflict
	}
	consumed, err := q.ConsumeRecoveryApprovalGrant(ctx, store.ConsumeRecoveryApprovalGrantParams{
		ConsumedAt: &now, ConsumedBy: pgtype.Text{String: input.Auth.UserID, Valid: true},
		ID: grant.ID, OrgID: orgID, CaseID: input.CaseID, CaseRevision: input.ExpectedRevision,
	})
	if err != nil || consumed != 1 {
		return ResolveSemanticOutcomeResult{}, ErrRecoveryCaseConflict
	}
	decision := candidate.Decision
	resolvesQuarantine := target.Source == "semantic_violation" &&
		target.Action == "quarantine" && target.State == "awaiting_approval" &&
		lockedRun.Status == "waiting"
	acknowledgesObservation := target.Source == "semantic_violation" &&
		target.Action == "observe" && target.State == "awaiting_approval" &&
		decision == "accept_loss"
	if !resolvesQuarantine && !acknowledgesObservation {
		return ResolveSemanticOutcomeResult{}, ErrRecoveryCaseConflict
	}
	if lockedRun.ReplayMode.Valid && lockedRun.ReplayMode.String != "" {
		return ResolveSemanticOutcomeResult{}, ErrRecoveryCaseConflict
	}
	casesToResolve := []store.RecoveryCase{target}
	if decision == "replace" {
		// A replacement is evaluated against the complete immutable recovery
		// contract, so it can close every sibling detector for the same source
		// node. An accepted loss is case-specific and must never implicitly
		// acknowledge a different (especially quarantining) detector.
		casesToResolve = openCases
	}

	wf, _, err := workflowFromRunInput(lockedRun.InputJson)
	if err != nil || wf.Recovery == nil || wf.Recovery.Contract == nil || wf.Recovery.Contract.Version != "2" {
		return ResolveSemanticOutcomeResult{}, ErrRecoveryCaseConflict
	}
	contract := wf.Recovery.Contract

	var replacementState json.RawMessage
	if decision == "replace" {
		profiles := make([]domain.RecoveryAutonomyProfile, 0, len(openCases))
		for _, item := range openCases {
			profiles = append(profiles, domain.ResolveRecoveryAutonomyProfile(contract, domain.RecoveryFailureClass{
				Kind: "semantic", DetectorID: item.DetectorID,
			}))
		}
		autonomy := domain.CombineRecoveryAutonomyProfiles(profiles)
		if !autonomy.Capabilities.ApplyWithApproval {
			return ResolveSemanticOutcomeResult{}, &RecoveryPolicyBlockedError{Profile: autonomy}
		}

		persistedOutput, state, reason := prepareSemanticReplacement(candidate.Output)
		if reason != "" {
			return ResolveSemanticOutcomeResult{}, &RecoverySemanticOutputError{Reason: reason}
		}
		replacementState = state
		contextRows := make([]store.ListRunNodesByRunRow, 0, len(lockedNodes))
		for _, row := range lockedNodes {
			contextRows = append(contextRows, store.ListRunNodesByRunRow(row))
		}
		evaluation := recovery.EvaluateSemanticOutcome(struct {
			Contract     *domain.RecoveryContract
			SourceNodeID string
			Output       any
			Context      map[string]any
		}{
			Contract: contract, SourceNodeID: target.SourceNodeID,
			Output: persistedOutput, Context: runContextFromRows(contextRows),
		})
		if evaluation.Evaluated == 0 || len(evaluation.Violations) > 0 {
			reason := "No deterministic detector evaluated the replacement output"
			if len(evaluation.Violations) > 0 {
				reason = "Replacement output failed deterministic validation"
			}
			return ResolveSemanticOutcomeResult{}, &RecoverySemanticOutputError{
				Reason: reason, Violations: evaluation.Violations,
			}
		}
	}

	resolvedAt := now
	caseIDs := make([]string, 0, len(casesToResolve))
	for _, item := range casesToResolve {
		caseIDs = append(caseIDs, item.ID)
	}
	finalState := "accepted_loss"
	if decision == "replace" {
		finalState = "monitoring"
	}

	if decision == "replace" {
		changed, err := q.ReplaceSemanticRunNodeOutput(ctx, store.ReplaceSemanticRunNodeOutputParams{
			StateJson: replacementState, RunID: snapshot.RunID,
			NodeID: snapshot.SourceNodeID, OrgID: orgID,
		})
		if err != nil {
			return ResolveSemanticOutcomeResult{}, fmt.Errorf("replace semantic recovery output: %w", err)
		}
		if changed != 1 {
			return ResolveSemanticOutcomeResult{}, ErrRecoveryCaseConflict
		}
		if err := e.recordRecoveryImpact(ctx, q, ClaimedNode{
			RunID: snapshot.RunID, NodeID: snapshot.SourceNodeID,
		}, resolvedAt); err != nil {
			return ResolveSemanticOutcomeResult{}, fmt.Errorf("record semantic recovery impact: %w", err)
		}
	}

	eventID := e.newID()
	reason := signature.ScrubSecretShapes(candidate.Reason)
	artifactPairs := make(map[string]semanticResolutionArtifactPair, len(casesToResolve))
	for index, item := range casesToResolve {
		pair, err := e.insertSemanticResolutionArtifacts(ctx, q, item, input.Auth.UserID,
			decision, finalState, eventID, candidateArtifact, validationArtifact,
			resolvedAt.Add(time.Duration(index)*time.Millisecond))
		if err != nil {
			return ResolveSemanticOutcomeResult{}, err
		}
		artifactPairs[item.ID] = pair
		if _, err := q.RevokeRecoveryApprovalGrants(ctx, store.RevokeRecoveryApprovalGrantsParams{
			RevokedAt: &resolvedAt, OrgID: orgID, CaseID: item.ID,
		}); err != nil {
			return ResolveSemanticOutcomeResult{}, fmt.Errorf("revoke resolved recovery approvals: %w", err)
		}
	}
	for index, item := range casesToResolve {
		if err := e.advanceSemanticResolutionCase(ctx, q, item, input.Auth.UserID,
			decision, reason, eventID, resolvedAt.Add(time.Duration(index*16)*time.Millisecond),
			candidateArtifact, validationArtifact, artifactPairs[item.ID]); err != nil {
			return ResolveSemanticOutcomeResult{}, err
		}
	}

	remaining, err := q.CountBlockingSemanticRecoveryCases(ctx, store.CountBlockingSemanticRecoveryCasesParams{
		OrgID: orgID, RunID: snapshot.RunID,
	})
	if err != nil {
		return ResolveSemanticOutcomeResult{}, fmt.Errorf("count remaining semantic cases: %w", err)
	}
	resumed := lockedRun.Status == "waiting" && remaining.OpenQuarantines == 0
	outcomeStatus := "semantic_quarantined"
	if remaining.OpenQuarantines == 0 {
		switch {
		case remaining.TotalOpen > 0:
			outcomeStatus = "semantic_violation"
		case decision == "replace":
			outcomeStatus = "semantic_recovering"
		default:
			outcomeStatus = "semantic_accepted_loss"
		}
	}
	changed, err := q.UpdateRunSemanticResolution(ctx, store.UpdateRunSemanticResolutionParams{
		Resume: resumed, OutcomeStatus: pgtype.Text{String: outcomeStatus, Valid: true},
		ID: snapshot.RunID, OrgID: orgID, ExpectedStatus: lockedRun.Status,
	})
	if err != nil {
		return ResolveSemanticOutcomeResult{}, fmt.Errorf("update semantic recovery run: %w", err)
	}
	if changed != 1 {
		return ResolveSemanticOutcomeResult{}, ErrRecoveryCaseConflict
	}

	events := &runEventBuffer{}
	events.add(eventID, snapshot.RunID, snapshot.SourceNodeID,
		"recovery.semantic_resolved", safePersist(map[string]any{
			"caseIds": caseIDs, "sourceNodeId": snapshot.SourceNodeID,
			"decision": decision, "resumed": resumed,
			"candidateArtifactId":  candidateArtifact.ID,
			"validationArtifactId": validationArtifact.ID,
		}, defaultPersistMaxBytes()), resolvedAt)
	if resumed {
		// Go's durable queue is PostgreSQL itself: the ordinary readiness scan
		// queues every now-ready successor in this same transaction. QueueRunNode
		// stamps the publication-repair generation, while LISTEN/NOTIFY remains
		// only a latency optimization delivered by PostgreSQL after commit.
		if err := e.scheduleDownstream(ctx, q, events, snapshot.RunID, resolvedAt); err != nil {
			return ResolveSemanticOutcomeResult{}, fmt.Errorf("resume semantic recovery downstream: %w", err)
		}
	}

	if err := audit.WriteInTx(ctx, wrapped, input.Auth, audit.Action("recovery.semantic_resolved"), audit.Options{
		TargetType: "recovery_case", TargetID: input.CaseID,
		Metadata: map[string]any{
			"runId": snapshot.RunID, "sourceNodeId": snapshot.SourceNodeID,
			"decision": decision, "resumed": resumed,
			"candidateArtifactId":  candidateArtifact.ID,
			"validationArtifactId": validationArtifact.ID,
			"resolvedCaseIds":      caseIDs,
		},
	}); err != nil {
		return ResolveSemanticOutcomeResult{}, fmt.Errorf("audit semantic recovery: %w", err)
	}
	if err := events.flush(ctx, q); err != nil {
		return ResolveSemanticOutcomeResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return ResolveSemanticOutcomeResult{}, fmt.Errorf("commit semantic recovery: %w", err)
	}

	// Publishing is deliberately post-commit. A lost signal is harmless:
	// stream subscribers poll the durable event table every second.
	if err := store.New(e.pool).NotifyRunEvents(ctx, snapshot.RunID); err != nil {
		slog.Warn("semantic recovery event notification deferred",
			"run_id", snapshot.RunID, "error", err)
	}
	return ResolveSemanticOutcomeResult{
		RunID: snapshot.RunID, SourceNodeID: snapshot.SourceNodeID,
		Decision: decision, Resumed: resumed, ResolvedCaseIDs: caseIDs,
	}, nil
}

func prepareSemanticReplacement(output any) (any, json.RawMessage, string) {
	scrubbed := scrubSemanticReplacementValue(grammar.NormalizeJSON(output))
	state := safePersist(map[string]any{"output": scrubbed}, stateJSONMaxBytes)
	var persisted map[string]any
	if err := json.Unmarshal(state, &persisted); err != nil {
		return nil, nil, "Replacement output could not be persisted safely"
	}
	if truncated, _ := persisted["__truncated"].(bool); truncated {
		return nil, nil, "Replacement output exceeds the durable node-state limit"
	}
	value, present := persisted["output"]
	if !present {
		return nil, nil, "Replacement output could not be persisted safely"
	}
	return value, state, ""
}

func scrubSemanticReplacementValue(value any) any {
	switch typed := value.(type) {
	case string:
		return signature.ScrubSecretShapes(typed)
	case []any:
		out := make([]any, len(typed))
		for i, item := range typed {
			out[i] = scrubSemanticReplacementValue(item)
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(typed))
		for key, item := range typed {
			out[key] = scrubSemanticReplacementValue(item)
		}
		return out
	default:
		return typed
	}
}

var semanticRecoveryReplacementPaths = map[string][]string{
	"detected":          {"contained", "diagnosed", "candidates_ready", "validating", "awaiting_approval", "publishing", "monitoring"},
	"contained":         {"diagnosed", "candidates_ready", "validating", "awaiting_approval", "publishing", "monitoring"},
	"diagnosed":         {"candidates_ready", "validating", "awaiting_approval", "publishing", "monitoring"},
	"candidates_ready":  {"validating", "awaiting_approval", "publishing", "monitoring"},
	"validating":        {"awaiting_approval", "publishing", "monitoring"},
	"awaiting_approval": {"publishing", "monitoring"},
	"publishing":        {"monitoring"},
}

type semanticResolutionArtifactPair struct {
	publication  store.RecoveryCaseArtifact
	verification store.RecoveryCaseArtifact
}

func (e *Engine) insertSemanticResolutionArtifacts(
	ctx context.Context, q *store.Queries, item store.RecoveryCase,
	actorID, decision, finalState, eventID string,
	candidate, validation store.RecoveryCaseArtifact, occurredAt time.Time,
) (semanticResolutionArtifactPair, error) {
	insert := func(kind string, payload any, createdAt time.Time) (store.RecoveryCaseArtifact, error) {
		raw, hash, err := boundedRecoveryArtifact(payload)
		if err != nil {
			return store.RecoveryCaseArtifact{}, err
		}
		row, err := q.InsertRecoveryCaseArtifact(ctx, store.InsertRecoveryCaseArtifactParams{
			ID: StableSemanticID("rca", item.ID, kind, hash), OrgID: item.OrgID,
			CaseID: item.ID, Kind: kind, PayloadJson: raw, PayloadSha256: hash,
			ActorKind: "user", ActorID: pgtype.Text{String: actorID, Valid: true},
			CreatedAt: createdAt,
		})
		if err != nil {
			return store.RecoveryCaseArtifact{}, fmt.Errorf("insert semantic %s artifact: %w", kind, err)
		}
		return row, nil
	}
	publication, err := insert("publication", map[string]any{
		"eventId": eventID, "caseId": item.ID, "caseRevision": item.Revision,
		"runId": item.RunID, "sourceNodeId": item.SourceNodeID, "decision": decision,
		"candidateArtifactId": candidate.ID, "candidateSha256": candidate.PayloadSha256,
		"validationArtifactId": validation.ID, "validationSha256": validation.PayloadSha256,
	}, occurredAt)
	if err != nil {
		return semanticResolutionArtifactPair{}, err
	}
	var verification store.RecoveryCaseArtifact
	if finalState == "accepted_loss" {
		verification, err = insert("verification", map[string]any{
			"eventId": eventID, "caseId": item.ID, "runId": item.RunID,
			"sourceNodeId": item.SourceNodeID, "detectorId": item.DetectorID,
			"decision": decision, "resultState": finalState,
			"deterministicValidationPassed": false,
			"humanLossAcknowledged":         true,
			"candidateArtifactId":           candidate.ID,
			"validationArtifactId":          validation.ID,
			"verifiedAt":                    occurredAt.UTC().Format(time.RFC3339Nano),
		}, occurredAt.Add(time.Millisecond))
		if err != nil {
			return semanticResolutionArtifactPair{}, err
		}
	}
	return semanticResolutionArtifactPair{publication: publication, verification: verification}, nil
}

func (e *Engine) advanceSemanticResolutionCase(
	ctx context.Context, q *store.Queries, item store.RecoveryCase,
	actorID, decision, reason, eventID string, occurredAt time.Time,
	candidate, validation store.RecoveryCaseArtifact, artifacts semanticResolutionArtifactPair,
) error {
	targets := []string{"accepted_loss"}
	if decision == "replace" {
		targets = append([]string(nil), semanticRecoveryReplacementPaths[item.State]...)
		if len(targets) == 0 {
			return ErrRecoveryCaseConflict
		}
	}
	from := item.State
	revision := item.Revision
	for index, to := range targets {
		stepAt := occurredAt.Add(time.Duration(index) * time.Millisecond)
		receiptReason := reason
		if decision == "replace" && index == len(targets)-1 {
			receiptReason = "Replacement output passed every deterministic detector; terminal verification is monitoring"
		}
		receipt := domain.RecoveryCaseTransitionReceipt{
			CaseID: item.ID, From: from, To: to,
			ActorKind: "user", ActorID: actorID, Reason: receiptReason,
			Evidence: []domain.RecoveryCaseEvidenceRef{
				{Kind: "operator_decision", ID: eventID},
				{Kind: "run_node", ID: item.RunID + ":" + item.SourceNodeID},
				{Kind: "case_artifact", ID: candidate.ID, Sha256: candidate.PayloadSha256},
				{Kind: "validation", ID: validation.ID, Sha256: validation.PayloadSha256},
			},
		}
		if decision == "replace" {
			receipt.Evidence = append(receipt.Evidence,
				domain.RecoveryCaseEvidenceRef{Kind: "semantic_detector", ID: item.DetectorID})
		}
		if decision == "accept_loss" || to == "publishing" || from == "publishing" || from == "monitoring" {
			receipt.Evidence = append(receipt.Evidence, domain.RecoveryCaseEvidenceRef{
				Kind: "publication", ID: artifacts.publication.ID, Sha256: artifacts.publication.PayloadSha256,
			})
		}
		if to == "verified_recovered" || to == "accepted_loss" {
			receipt.Evidence = append(receipt.Evidence, domain.RecoveryCaseEvidenceRef{
				Kind: "effect", ID: artifacts.verification.ID, Sha256: artifacts.verification.PayloadSha256,
			})
		}
		if problems := domain.ValidateRecoveryCaseTransitionReceipt(receipt); len(problems) > 0 {
			return fmt.Errorf("validate semantic recovery receipt: %s", strings.Join(problems, "; "))
		}
		moved, err := q.AdvanceRecoveryCaseStateAtRevision(ctx, store.AdvanceRecoveryCaseStateAtRevisionParams{
			ToState: to, OccurredAt: stepAt, Terminal: domain.RecoveryCaseTerminalStates[to],
			OrgID: item.OrgID, ID: item.ID, FromState: from, ExpectedRevision: revision,
		})
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrRecoveryCaseConflict
			}
			return fmt.Errorf("advance semantic recovery case: %w", err)
		}
		evidence, err := json.Marshal(receipt.Evidence)
		if err != nil {
			return fmt.Errorf("marshal semantic recovery evidence: %w", err)
		}
		inserted, err := q.InsertRecoveryCaseTransition(ctx, store.InsertRecoveryCaseTransitionParams{
			ID: StableSemanticID("sct", item.ID, from, to, fmt.Sprint(revision)), OrgID: item.OrgID, CaseID: item.ID,
			FromState: from, ToState: to, ActorKind: "user",
			ActorID: pgtype.Text{String: actorID, Valid: true}, EvidenceJson: evidence,
			Reason:     pgtype.Text{String: receiptReason, Valid: receiptReason != ""},
			OccurredAt: stepAt,
		})
		if err != nil {
			return fmt.Errorf("insert semantic recovery receipt: %w", err)
		}
		if inserted != 1 {
			return ErrRecoveryCaseConflict
		}
		from = to
		revision = moved.Revision
	}
	return nil
}

type semanticPublicationBinding struct {
	CaseID               string `json:"caseId"`
	RunID                string `json:"runId"`
	Decision             string `json:"decision"`
	CandidateArtifactID  string `json:"candidateArtifactId"`
	CandidateSha256      string `json:"candidateSha256"`
	ValidationArtifactID string `json:"validationArtifactId"`
	ValidationSha256     string `json:"validationSha256"`
}

// finalizeSemanticRecoveryMonitoring is the generation-bound verification
// half of governed apply. The approved replacement only reaches monitoring;
// the ordinary terminal run transaction owns the final artifact and CAS so a
// failed downstream effect can never leave a falsely verified recovery case.
func (e *Engine) finalizeSemanticRecoveryMonitoring(
	ctx context.Context,
	q *store.Queries,
	runID, terminalStatus, terminalEventID string,
	terminalAt time.Time,
) error {
	resultState := "recurred"
	terminalSuccess := terminalStatus == "succeeded"
	switch terminalStatus {
	case "succeeded":
		resultState = "verified_recovered"
	case "failed", "cancelled", "timed_out":
	default:
		return fmt.Errorf("unsupported semantic verification terminal status %q", terminalStatus)
	}
	if runID == "" || terminalEventID == "" {
		return fmt.Errorf("semantic verification requires run and terminal event ids")
	}
	run, err := q.GetRunExecution(ctx, runID)
	if err != nil {
		return fmt.Errorf("read semantic verification run: %w", err)
	}
	if run.Status != terminalStatus {
		return fmt.Errorf("semantic verification run status = %s, want %s", run.Status, terminalStatus)
	}
	cases, err := q.LockMonitoringSemanticRecoveryCases(
		ctx,
		store.LockMonitoringSemanticRecoveryCasesParams{
			OrgID: run.OrgID, RunID: runID,
		},
	)
	if err != nil {
		return fmt.Errorf("lock monitoring semantic recovery cases: %w", err)
	}
	if len(cases) == 0 {
		return nil
	}
	if _, err := q.FinalizeRunSemanticRecoveryOutcome(
		ctx,
		store.FinalizeRunSemanticRecoveryOutcomeParams{
			ID: runID, OrgID: run.OrgID, TerminalSuccess: terminalSuccess,
		},
	); err != nil {
		return fmt.Errorf("finalize semantic recovery outcome: %w", err)
	}

	for index, item := range cases {
		publication, err := q.GetLatestRecoveryCaseArtifactByKind(
			ctx,
			store.GetLatestRecoveryCaseArtifactByKindParams{
				OrgID: item.OrgID, CaseID: item.ID, Kind: "publication",
			},
		)
		if err != nil {
			return fmt.Errorf("read semantic publication artifact: %w", err)
		}
		var binding semanticPublicationBinding
		if json.Unmarshal(publication.PayloadJson, &binding) != nil ||
			binding.CaseID != item.ID || binding.RunID != runID ||
			binding.Decision != "replace" || binding.CandidateArtifactID == "" ||
			binding.ValidationArtifactID == "" {
			return fmt.Errorf("invalid semantic publication binding for case %s", item.ID)
		}

		verifiedAt := terminalAt.Add(time.Duration(index*2+1) * time.Millisecond)
		payload := map[string]any{
			"eventId": terminalEventID, "caseId": item.ID, "runId": runID,
			"sourceNodeId": item.SourceNodeID, "detectorId": item.DetectorID,
			"decision": "replace", "resultState": resultState,
			"terminalStatus":                 terminalStatus,
			"generationBoundTerminalSuccess": terminalSuccess,
			"deterministicValidationPassed":  true,
			"publicationArtifactId":          publication.ID,
			"publicationSha256":              publication.PayloadSha256,
			"candidateArtifactId":            binding.CandidateArtifactID,
			"candidateSha256":                binding.CandidateSha256,
			"validationArtifactId":           binding.ValidationArtifactID,
			"validationSha256":               binding.ValidationSha256,
			"verifiedAt":                     verifiedAt.UTC().Format(time.RFC3339Nano),
		}
		raw, hash, err := boundedRecoveryArtifact(payload)
		if err != nil {
			return err
		}
		verification, err := q.InsertRecoveryCaseArtifact(
			ctx,
			store.InsertRecoveryCaseArtifactParams{
				ID:    StableSemanticID("rca", item.ID, "verification", hash),
				OrgID: item.OrgID, CaseID: item.ID, Kind: "verification",
				PayloadJson: raw, PayloadSha256: hash,
				ActorKind: "system", ActorID: pgtype.Text{}, CreatedAt: verifiedAt,
			},
		)
		if err != nil {
			return fmt.Errorf("insert terminal semantic verification: %w", err)
		}
		reason := "Approved replacement reached generation-bound terminal success"
		if !terminalSuccess {
			reason = "Approved replacement did not reach generation-bound terminal success: " + terminalStatus
		}
		receipt := domain.RecoveryCaseTransitionReceipt{
			CaseID: item.ID, From: "monitoring", To: resultState,
			ActorKind: "system", Reason: reason,
			Evidence: []domain.RecoveryCaseEvidenceRef{
				{Kind: "run", ID: runID},
				{Kind: "run_event", ID: terminalEventID},
				{Kind: "publication", ID: publication.ID, Sha256: publication.PayloadSha256},
				{Kind: "effect", ID: verification.ID, Sha256: verification.PayloadSha256},
			},
		}
		if problems := domain.ValidateRecoveryCaseTransitionReceipt(receipt); len(problems) > 0 {
			return fmt.Errorf("validate terminal semantic recovery receipt: %s", strings.Join(problems, "; "))
		}
		transitionAt := verifiedAt.Add(time.Millisecond)
		moved, err := q.AdvanceRecoveryCaseStateAtRevision(
			ctx,
			store.AdvanceRecoveryCaseStateAtRevisionParams{
				ToState: resultState, OccurredAt: transitionAt, Terminal: true,
				OrgID: item.OrgID, ID: item.ID, FromState: "monitoring",
				ExpectedRevision: item.Revision,
			},
		)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrRecoveryCaseConflict
			}
			return fmt.Errorf("finalize semantic recovery case: %w", err)
		}
		evidenceJSON, err := json.Marshal(receipt.Evidence)
		if err != nil {
			return fmt.Errorf("marshal terminal semantic evidence: %w", err)
		}
		inserted, err := q.InsertRecoveryCaseTransition(
			ctx,
			store.InsertRecoveryCaseTransitionParams{
				ID:    StableSemanticID("sct", item.ID, "monitoring", resultState, fmt.Sprint(item.Revision)),
				OrgID: item.OrgID, CaseID: item.ID,
				FromState: "monitoring", ToState: resultState,
				ActorKind: "system", ActorID: pgtype.Text{}, EvidenceJson: evidenceJSON,
				Reason: pgtype.Text{String: reason, Valid: true}, OccurredAt: transitionAt,
			},
		)
		if err != nil {
			return fmt.Errorf("insert terminal semantic transition: %w", err)
		}
		if inserted != 1 || moved.State != resultState {
			return ErrRecoveryCaseConflict
		}
	}
	return nil
}

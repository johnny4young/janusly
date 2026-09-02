package engine

import (
	"context"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/johnny4young/janusly/internal/audit"
	"github.com/johnny4young/janusly/internal/auth"
	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/store"
)

const recoveryReasonMaxRunes = 1_000

type SemanticManualReplacement struct {
	Output any
	Reason string
}

type CreateRecoveryCandidatesInput struct {
	Auth              *auth.Context
	CaseID            string
	ExpectedRevision  int64
	ManualReplacement *SemanticManualReplacement
	AcceptLossReason  string
}

type CreateRecoveryCandidatesResult struct {
	Case       store.RecoveryCase
	Candidates []store.RecoveryCaseArtifact
}

func buildRecoveryCandidateArtifacts(
	caseRow store.RecoveryCase,
	input CreateRecoveryCandidatesInput,
) ([]RecoveryArtifactInput, error) {
	evidence := []domain.RecoveryCaseEvidenceRef{
		{Kind: "run", ID: caseRow.RunID},
		{Kind: "run_node", ID: caseRow.RunID + ":" + caseRow.SourceNodeID},
		{Kind: "semantic_detector", ID: caseRow.DetectorID},
	}
	artifacts := make([]RecoveryArtifactInput, 0, 3)
	if input.ManualReplacement != nil {
		// An observe detector explicitly allowed downstream work to continue.
		// Replacing its completed source output later cannot resume or verify that
		// generation and ResolveSemanticOutcomeCase therefore cannot apply it.
		// Reject the dead-end candidate before optional AI or any lifecycle write.
		if caseRow.Action != "quarantine" {
			return nil, ErrRecoverySemanticInputInvalid
		}
		reason := strings.TrimSpace(input.ManualReplacement.Reason)
		if reason == "" || len([]rune(reason)) > recoveryReasonMaxRunes {
			return nil, ErrRecoverySemanticInputInvalid
		}
		artifacts = append(artifacts, RecoveryArtifactInput{Kind: "candidate", Payload: SemanticRecoveryCandidatePayload{
			Kind: "replace_output", Decision: "replace", Output: input.ManualReplacement.Output,
			Reason: reason, Risk: "medium", Evidence: evidence,
			ExpectedResult:      "The source output satisfies every deterministic semantic detector before downstream work resumes",
			RequiredPermissions: []string{"recovery.write"},
		}})
	}
	if caseRow.WorkflowID.Valid && strings.TrimSpace(caseRow.WorkflowID.String) != "" {
		target := &SemanticRecoveryCandidateTarget{
			WorkflowID: caseRow.WorkflowID.String, WorkflowVersionID: caseRow.WorkflowVersionID,
		}
		artifacts = append(artifacts, RecoveryArtifactInput{Kind: "candidate", Payload: SemanticRecoveryCandidatePayload{
			Kind: "repair_workflow", Decision: "manual_follow_up", Target: target,
			Reason: "Create and qualify a successor from the exact incident workflow version before changing future executions",
			Risk:   "medium", Evidence: evidence,
			ExpectedResult:      "A separately saved and qualified successor workflow addresses the failure without mutating this immutable run snapshot",
			RequiredPermissions: []string{"recovery.write", "workflows.write"},
		}})
		// When a concrete replacement already exists, prefer the broader
		// workflow repair recommendation and keep the total at three. Without
		// one, expose the exact detector follow-up as a distinct alternative.
		if input.ManualReplacement == nil {
			artifacts = append(artifacts, RecoveryArtifactInput{Kind: "candidate", Payload: SemanticRecoveryCandidatePayload{
				Kind: "adjust_detector", Decision: "manual_follow_up",
				Target: &SemanticRecoveryCandidateTarget{
					WorkflowID: caseRow.WorkflowID.String, WorkflowVersionID: caseRow.WorkflowVersionID,
					DetectorID: caseRow.DetectorID,
				},
				Reason: "Review the exact detector against labeled pass and violation fixtures in a successor workflow version",
				Risk:   "high", Evidence: evidence,
				ExpectedResult:      "A qualified detector revision reduces false classification without rewriting incident evidence",
				RequiredPermissions: []string{"recovery.write", "workflows.write"},
			}})
		}
	}
	acceptReason := strings.TrimSpace(input.AcceptLossReason)
	if len([]rune(acceptReason)) > recoveryReasonMaxRunes {
		return nil, ErrRecoverySemanticInputInvalid
	}
	if acceptReason == "" {
		acceptReason = "Explicitly accept the business outcome loss after human review"
	}
	artifacts = append(artifacts, RecoveryArtifactInput{Kind: "candidate", Payload: SemanticRecoveryCandidatePayload{
		Kind: "accept_loss", Decision: "accept_loss",
		Reason: acceptReason, Risk: "high", Evidence: evidence,
		ExpectedResult:      "The case closes as an explicitly accepted loss without changing the source output",
		RequiredPermissions: []string{"recovery.write"},
	}})
	if len(artifacts) < 1 || len(artifacts) > 3 {
		return nil, ErrRecoverySemanticInputInvalid
	}
	return artifacts, nil
}

// PreflightRecoveryCandidates proves that a combined MCP diagnosis request can
// create every engine-owned candidate before optional AI or any case mutation.
// CreateRecoveryCandidates repeats the same checks at its CAS boundary.
func (e *Engine) PreflightRecoveryCandidates(ctx context.Context, input CreateRecoveryCandidatesInput) error {
	if input.Auth == nil || input.Auth.OrgID == "" || input.Auth.UserID == "" ||
		input.CaseID == "" || input.ExpectedRevision < 1 {
		return ErrRecoverySemanticInputInvalid
	}
	caseRow, err := store.New(e.pool).GetRecoveryCase(ctx, store.GetRecoveryCaseParams{
		OrgID: input.Auth.OrgID, ID: input.CaseID,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrRecoveryCaseNotFound
		}
		return err
	}
	if caseRow.Source != semanticRecoveryCaseSource || caseRow.Revision != input.ExpectedRevision ||
		(caseRow.State != "detected" && caseRow.State != "contained" && caseRow.State != "diagnosed") {
		return ErrRecoveryCaseConflict
	}
	artifacts, err := buildRecoveryCandidateArtifacts(caseRow, input)
	if err != nil {
		return err
	}
	for _, artifact := range artifacts {
		if _, _, err := boundedRecoveryArtifact(artifact.Payload); err != nil {
			return err
		}
	}
	return nil
}

// CreateRecoveryCandidates creates only typed immutable envelopes. A caller
// never supplies arbitrary patch JSON or permission metadata.
func (e *Engine) CreateRecoveryCandidates(
	ctx context.Context,
	input CreateRecoveryCandidatesInput,
) (CreateRecoveryCandidatesResult, error) {
	if input.Auth == nil || input.Auth.OrgID == "" || input.Auth.UserID == "" ||
		input.CaseID == "" || input.ExpectedRevision < 1 {
		return CreateRecoveryCandidatesResult{}, ErrRecoverySemanticInputInvalid
	}
	caseRow, err := store.New(e.pool).GetRecoveryCase(ctx, store.GetRecoveryCaseParams{
		OrgID: input.Auth.OrgID, ID: input.CaseID,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return CreateRecoveryCandidatesResult{}, ErrRecoveryCaseNotFound
		}
		return CreateRecoveryCandidatesResult{}, err
	}
	if caseRow.Source != semanticRecoveryCaseSource ||
		caseRow.Revision != input.ExpectedRevision || caseRow.State != "diagnosed" {
		return CreateRecoveryCandidatesResult{}, ErrRecoveryCaseConflict
	}
	artifacts, err := buildRecoveryCandidateArtifacts(caseRow, input)
	if err != nil {
		return CreateRecoveryCandidatesResult{}, err
	}
	advanced, err := e.AdvanceRecoveryCase(ctx, AdvanceRecoveryCaseInput{
		Auth: input.Auth, CaseID: input.CaseID, ExpectedRevision: input.ExpectedRevision,
		Artifacts: artifacts,
		Steps: []RecoveryTransitionStep{{
			From: "diagnosed", To: "candidates_ready", Reason: "Bounded recovery candidates recorded",
		}},
		AuditAction: audit.Action("recovery.case.candidates_created"),
	})
	if err != nil {
		return CreateRecoveryCandidatesResult{}, err
	}
	return CreateRecoveryCandidatesResult{Case: advanced.Case, Candidates: advanced.Artifacts}, nil
}

type ValidateRecoveryCaseCandidateInput struct {
	Auth                *auth.Context
	CaseID              string
	ExpectedRevision    int64
	CandidateArtifactID string
}

type ValidateRecoveryCaseCandidateResult struct {
	Case       store.RecoveryCase
	Validation store.RecoveryCaseArtifact
	Passed     bool
}

func (e *Engine) ValidateRecoveryCaseCandidate(
	ctx context.Context,
	input ValidateRecoveryCaseCandidateInput,
) (ValidateRecoveryCaseCandidateResult, error) {
	if input.Auth == nil || input.Auth.OrgID == "" || input.Auth.UserID == "" ||
		input.CaseID == "" || input.ExpectedRevision < 1 || input.CandidateArtifactID == "" {
		return ValidateRecoveryCaseCandidateResult{}, ErrRecoverySemanticInputInvalid
	}
	validation, err := e.ValidateSemanticRecoveryCandidate(
		ctx, input.Auth.OrgID, input.CaseID, input.CandidateArtifactID,
	)
	if err != nil {
		return ValidateRecoveryCaseCandidateResult{}, err
	}
	if validation.CaseRevision != input.ExpectedRevision {
		return ValidateRecoveryCaseCandidateResult{}, ErrRecoveryCaseConflict
	}
	steps := []RecoveryTransitionStep{{
		From: "candidates_ready", To: "validating", Reason: "Candidate validation started",
	}}
	if validation.Passed {
		steps = append(steps, RecoveryTransitionStep{
			From: "validating", To: "awaiting_approval", Reason: validation.Summary,
		})
	} else {
		steps = append(steps, RecoveryTransitionStep{
			From: "validating", To: "candidates_ready", Reason: validation.Summary,
		})
	}
	advanced, err := e.AdvanceRecoveryCase(ctx, AdvanceRecoveryCaseInput{
		Auth: input.Auth, CaseID: input.CaseID, ExpectedRevision: input.ExpectedRevision,
		Artifacts:   []RecoveryArtifactInput{{Kind: "validation", Payload: validation}},
		Steps:       steps,
		AuditAction: audit.Action("recovery.case.validated"),
	})
	if err != nil {
		return ValidateRecoveryCaseCandidateResult{}, err
	}
	return ValidateRecoveryCaseCandidateResult{
		Case: advanced.Case, Validation: advanced.Artifacts[0], Passed: validation.Passed,
	}, nil
}

// Post-terminal bookkeeping for semantic recovery cases left in monitoring.
package engine

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/store"
)

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
	run, err := q.GetRunHeader(ctx, runID)
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
			binding.Decision != "replace" || binding.AuthorityCaseID == "" ||
			binding.CaseRevision < 1 || binding.CandidateArtifactID == "" ||
			binding.ValidationArtifactID == "" ||
			!isLowerHexSha256(binding.CandidateSha256) ||
			!isLowerHexSha256(binding.ValidationSha256) {
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
			"authorityCaseId":                binding.AuthorityCaseID,
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

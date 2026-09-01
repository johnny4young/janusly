package engine

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/internal/audit"
	"github.com/johnny4young/janusly/internal/auth"
	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/grammar"
	"github.com/johnny4young/janusly/internal/signature"
	"github.com/johnny4young/janusly/internal/store"
)

const recoveryArtifactMaxBytes = 64_000

var recoveryArtifactKinds = map[string]bool{
	"diagnosis": true, "candidate": true, "validation": true,
	"publication": true, "verification": true,
}

var (
	ErrRecoveryArtifactTooLarge = errors.New("recovery case artifact exceeds limit")
	ErrRecoveryApprovalMissing  = errors.New("recovery approval is missing or expired")
)

func recoveryActorKind(actor *auth.Context) string {
	if actor != nil && (actor.Source == auth.SourceMcp || actor.Source == auth.SourceService) {
		return "agent"
	}
	return "user"
}

// RecoveryArtifactInput is one bounded, append-only fact created by a
// governed recovery operation.
type RecoveryArtifactInput struct {
	Kind    string
	Payload any
}

// RecoveryTransitionStep describes one legal, revision-CAS transition. A
// single operation can advance more than one step atomically (validation uses
// candidates_ready -> validating -> awaiting_approval).
type RecoveryTransitionStep struct {
	From   string
	To     string
	Reason string
}

type AdvanceRecoveryCaseInput struct {
	Auth             *auth.Context
	CaseID           string
	ExpectedRevision int64
	Artifacts        []RecoveryArtifactInput
	Steps            []RecoveryTransitionStep
	AuditAction      audit.Action
}

type AdvanceRecoveryCaseResult struct {
	Case      store.RecoveryCase
	Artifacts []store.RecoveryCaseArtifact
}

func boundedRecoveryArtifact(value any) (json.RawMessage, string, error) {
	raw := grammar.SafePersistPayload(sanitizeRecoveryArtifact(value), grammar.PersistOptions{MaxBytes: recoveryArtifactMaxBytes})
	var marker map[string]any
	if json.Unmarshal(raw, &marker) == nil {
		if truncated, _ := marker["__truncated"].(bool); truncated {
			return nil, "", ErrRecoveryArtifactTooLarge
		}
	}
	sum := sha256.Sum256(raw)
	return raw, hex.EncodeToString(sum[:]), nil
}

// sanitizeRecoveryArtifact removes known secret-shaped substrings in every
// free-form string before the shared key redaction and byte cap. Recovery
// evidence is long-lived and can originate in provider/user-controlled
// output, so key-only redaction is insufficient.
func sanitizeRecoveryArtifact(value any) any {
	value = grammar.NormalizeJSON(value)
	switch typed := value.(type) {
	case string:
		return signature.ScrubSecretShapes(typed)
	case []any:
		out := make([]any, len(typed))
		for index, item := range typed {
			out[index] = sanitizeRecoveryArtifact(item)
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(typed))
		for key, item := range typed {
			out[key] = sanitizeRecoveryArtifact(item)
		}
		return out
	default:
		return typed
	}
}

// AdvanceRecoveryCase persists every artifact, transition receipt, case state
// and audit row in one transaction. State and revision are both checked so a
// stale UI or MCP request commits nothing.
func (e *Engine) AdvanceRecoveryCase(ctx context.Context, input AdvanceRecoveryCaseInput) (AdvanceRecoveryCaseResult, error) {
	if input.Auth == nil || input.Auth.OrgID == "" || input.Auth.UserID == "" ||
		input.CaseID == "" || input.ExpectedRevision < 1 || len(input.Steps) == 0 {
		return AdvanceRecoveryCaseResult{}, ErrRecoverySemanticInputInvalid
	}
	for _, step := range input.Steps {
		if !domain.IsLegalRecoveryCaseTransition(step.From, step.To) ||
			strings.TrimSpace(step.Reason) == "" {
			return AdvanceRecoveryCaseResult{}, ErrRecoverySemanticInputInvalid
		}
	}

	type preparedArtifact struct {
		id, kind, hash string
		raw            json.RawMessage
	}
	prepared := make([]preparedArtifact, 0, len(input.Artifacts))
	for _, artifact := range input.Artifacts {
		if !recoveryArtifactKinds[artifact.Kind] {
			return AdvanceRecoveryCaseResult{}, ErrRecoverySemanticInputInvalid
		}
		raw, hash, err := boundedRecoveryArtifact(artifact.Payload)
		if err != nil {
			return AdvanceRecoveryCaseResult{}, err
		}
		prepared = append(prepared, preparedArtifact{
			id:   StableSemanticID("rca", input.CaseID, artifact.Kind, hash),
			kind: artifact.Kind, hash: hash, raw: raw,
		})
	}

	now := e.now().UTC().Truncate(time.Millisecond)
	actorKind := recoveryActorKind(input.Auth)
	tx, err := e.pool.Begin(ctx)
	if err != nil {
		return AdvanceRecoveryCaseResult{}, fmt.Errorf("begin governed recovery: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	wrapped := e.wrapTx(tx)
	q := store.New(wrapped)
	current, err := q.GetRecoveryCaseForUpdate(ctx, store.GetRecoveryCaseForUpdateParams{
		OrgID: input.Auth.OrgID, ID: input.CaseID,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return AdvanceRecoveryCaseResult{}, ErrRecoveryCaseNotFound
		}
		return AdvanceRecoveryCaseResult{}, fmt.Errorf("lock recovery case: %w", err)
	}
	if current.Revision != input.ExpectedRevision || current.State != input.Steps[0].From {
		return AdvanceRecoveryCaseResult{}, ErrRecoveryCaseConflict
	}
	// Every state transition changes the case revision. Revoke any grant bound
	// to the old revision in the same transaction so no later query can mistake
	// it for current authority, even if the case eventually revisits the same
	// lifecycle state.
	if _, err := q.RevokeRecoveryApprovalGrants(ctx, store.RevokeRecoveryApprovalGrantsParams{
		RevokedAt: &now, OrgID: input.Auth.OrgID, CaseID: input.CaseID,
	}); err != nil {
		return AdvanceRecoveryCaseResult{}, fmt.Errorf("revoke stale recovery approvals: %w", err)
	}

	insertedArtifacts := make([]store.RecoveryCaseArtifact, 0, len(prepared))
	for _, artifact := range prepared {
		row, err := q.InsertRecoveryCaseArtifact(ctx, store.InsertRecoveryCaseArtifactParams{
			ID: artifact.id, OrgID: input.Auth.OrgID, CaseID: input.CaseID,
			Kind: artifact.kind, PayloadJson: artifact.raw, PayloadSha256: artifact.hash,
			ActorKind: actorKind, ActorID: pgtype.Text{String: input.Auth.UserID, Valid: true},
			CreatedAt: now,
		})
		if err != nil {
			return AdvanceRecoveryCaseResult{}, fmt.Errorf("insert recovery artifact: %w", err)
		}
		insertedArtifacts = append(insertedArtifacts, row)
	}

	revision := current.Revision
	for index, step := range input.Steps {
		if index > 0 && input.Steps[index-1].To != step.From {
			return AdvanceRecoveryCaseResult{}, ErrRecoverySemanticInputInvalid
		}
		occurredAt := now.Add(time.Duration(index) * time.Millisecond)
		evidence := []domain.RecoveryCaseEvidenceRef{{Kind: "run", ID: current.RunID}}
		for _, artifact := range insertedArtifacts {
			evidence = append(evidence, domain.RecoveryCaseEvidenceRef{
				Kind: "case_artifact", ID: artifact.ID, Sha256: artifact.PayloadSha256,
			})
		}
		receipt := domain.RecoveryCaseTransitionReceipt{
			CaseID: input.CaseID, From: step.From, To: step.To,
			ActorKind: actorKind, ActorID: input.Auth.UserID,
			Evidence: evidence, Reason: strings.TrimSpace(step.Reason),
		}
		if problems := domain.ValidateRecoveryCaseTransitionReceipt(receipt); len(problems) > 0 {
			return AdvanceRecoveryCaseResult{}, fmt.Errorf("invalid governed receipt: %s", strings.Join(problems, "; "))
		}
		moved, err := q.AdvanceRecoveryCaseStateAtRevision(ctx, store.AdvanceRecoveryCaseStateAtRevisionParams{
			ToState: step.To, OccurredAt: occurredAt,
			Terminal: domain.RecoveryCaseTerminalStates[step.To],
			OrgID:    input.Auth.OrgID, ID: input.CaseID,
			FromState: step.From, ExpectedRevision: revision,
		})
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return AdvanceRecoveryCaseResult{}, ErrRecoveryCaseConflict
			}
			return AdvanceRecoveryCaseResult{}, fmt.Errorf("advance recovery case: %w", err)
		}
		evidenceJSON, _ := json.Marshal(evidence)
		inserted, err := q.InsertRecoveryCaseTransition(ctx, store.InsertRecoveryCaseTransitionParams{
			ID:    StableSemanticID("sct", input.CaseID, step.From, step.To, fmt.Sprint(revision)),
			OrgID: input.Auth.OrgID, CaseID: input.CaseID,
			FromState: step.From, ToState: step.To, ActorKind: actorKind,
			ActorID:      pgtype.Text{String: input.Auth.UserID, Valid: true},
			EvidenceJson: evidenceJSON,
			Reason:       pgtype.Text{String: receipt.Reason, Valid: true}, OccurredAt: occurredAt,
		})
		if err != nil || inserted != 1 {
			return AdvanceRecoveryCaseResult{}, ErrRecoveryCaseReceiptGone
		}
		current = moved
		revision = moved.Revision
	}
	if err := audit.WriteInTx(ctx, wrapped, input.Auth, input.AuditAction, audit.Options{
		TargetType: "recovery_case", TargetID: input.CaseID,
		Metadata: map[string]any{
			"from":        input.Steps[0].From,
			"to":          input.Steps[len(input.Steps)-1].To,
			"revision":    revision,
			"artifactIds": artifactIDs(insertedArtifacts),
		},
	}); err != nil {
		return AdvanceRecoveryCaseResult{}, fmt.Errorf("audit governed recovery: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return AdvanceRecoveryCaseResult{}, fmt.Errorf("commit governed recovery: %w", err)
	}
	return AdvanceRecoveryCaseResult{Case: current, Artifacts: insertedArtifacts}, nil
}

func artifactIDs(artifacts []store.RecoveryCaseArtifact) []string {
	ids := make([]string, 0, len(artifacts))
	for _, artifact := range artifacts {
		ids = append(ids, artifact.ID)
	}
	return ids
}

type ApproveRecoveryCandidateInput struct {
	Auth                 *auth.Context
	CaseID               string
	ExpectedRevision     int64
	CandidateArtifactID  string
	ValidationArtifactID string
}

// ApproveRecoveryCandidate creates a 30-minute, one-use approval bound to the
// exact candidate, validation and current case revision. It never changes the
// case revision, so apply can consume the same binding atomically.
func (e *Engine) ApproveRecoveryCandidate(ctx context.Context, input ApproveRecoveryCandidateInput) (store.RecoveryApprovalGrant, error) {
	if input.Auth == nil || input.Auth.OrgID == "" || input.Auth.UserID == "" ||
		input.CaseID == "" || input.ExpectedRevision < 1 ||
		input.CandidateArtifactID == "" || input.ValidationArtifactID == "" {
		return store.RecoveryApprovalGrant{}, ErrRecoverySemanticInputInvalid
	}
	now := e.now().UTC().Truncate(time.Millisecond)
	tx, err := e.pool.Begin(ctx)
	if err != nil {
		return store.RecoveryApprovalGrant{}, fmt.Errorf("begin recovery approval: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	wrapped := e.wrapTx(tx)
	q := store.New(wrapped)
	caseRow, err := q.GetRecoveryCaseForUpdate(ctx, store.GetRecoveryCaseForUpdateParams{
		OrgID: input.Auth.OrgID, ID: input.CaseID,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return store.RecoveryApprovalGrant{}, ErrRecoveryCaseNotFound
		}
		return store.RecoveryApprovalGrant{}, err
	}
	if caseRow.State != "awaiting_approval" || caseRow.Revision != input.ExpectedRevision {
		return store.RecoveryApprovalGrant{}, ErrRecoveryCaseConflict
	}
	candidate, err := q.GetRecoveryCaseArtifact(ctx, store.GetRecoveryCaseArtifactParams{
		OrgID: input.Auth.OrgID, CaseID: input.CaseID, ID: input.CandidateArtifactID,
	})
	if err != nil || candidate.Kind != "candidate" {
		return store.RecoveryApprovalGrant{}, ErrRecoveryCaseConflict
	}
	validation, err := q.GetRecoveryCaseArtifact(ctx, store.GetRecoveryCaseArtifactParams{
		OrgID: input.Auth.OrgID, CaseID: input.CaseID, ID: input.ValidationArtifactID,
	})
	if err != nil || validation.Kind != "validation" {
		return store.RecoveryApprovalGrant{}, ErrRecoveryCaseConflict
	}
	var validationPayload SemanticRecoveryValidationPayload
	if json.Unmarshal(validation.PayloadJson, &validationPayload) != nil ||
		!validationPayload.Passed || validationPayload.CandidateArtifactID != candidate.ID ||
		validationPayload.CandidateSha256 != candidate.PayloadSha256 ||
		!currentRecoveryValidation(validationPayload.CaseRevision, caseRow.Revision) {
		return store.RecoveryApprovalGrant{}, ErrRecoveryCaseConflict
	}
	// A fresh human approval supersedes any unconsumed grant for this case.
	// This also permits an operator to approve again after a prior grant
	// expired; approval rows are events, not an upserted singleton.
	if _, err := q.RevokeRecoveryApprovalGrants(ctx, store.RevokeRecoveryApprovalGrantsParams{
		RevokedAt: &now, OrgID: input.Auth.OrgID, CaseID: input.CaseID,
	}); err != nil {
		return store.RecoveryApprovalGrant{}, fmt.Errorf("revoke prior recovery approval: %w", err)
	}
	expiresAt := now.Add(30 * time.Minute)
	grant, err := q.InsertRecoveryApprovalGrant(ctx, store.InsertRecoveryApprovalGrantParams{
		ID:    e.newID(),
		OrgID: input.Auth.OrgID, CaseID: input.CaseID,
		CandidateArtifactID: candidate.ID, ValidationArtifactID: validation.ID,
		CaseRevision: caseRow.Revision, GrantedBy: input.Auth.UserID,
		ExpiresAt: expiresAt, CreatedAt: now,
	})
	if err != nil {
		return store.RecoveryApprovalGrant{}, fmt.Errorf("insert recovery approval: %w", err)
	}
	if err := audit.WriteInTx(ctx, wrapped, input.Auth, audit.Action("recovery.case.approved"), audit.Options{
		TargetType: "recovery_case", TargetID: input.CaseID,
		Metadata: map[string]any{
			"candidateArtifactId":  candidate.ID,
			"validationArtifactId": validation.ID,
			"caseRevision":         caseRow.Revision,
			"expiresAt":            expiresAt,
		},
	}); err != nil {
		return store.RecoveryApprovalGrant{}, fmt.Errorf("audit recovery approval: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return store.RecoveryApprovalGrant{}, err
	}
	return grant, nil
}

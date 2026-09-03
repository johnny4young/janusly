// Durable Recovery Cases: the atomic case-transition writer, implements
// the contract's persistence-ports/recovery.ts posture. A state change
// and its append-only receipt commit or roll back TOGETHER — a transition
// without a receipt is impossible by construction: the CAS UPDATE
// (state = from) and the receipt INSERT run in one transaction, receipt
// ids are deterministic over case + edge + revision, and the primary key
// makes a retry of the same revision a no-op without forbidding the legal
// validating -> candidates_ready revision loop. The legality of every
// transition is validated by the pure domain ladder BEFORE any write.
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

	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/store"
)

const semanticRecoveryCaseSource = "semantic_violation"

// StableSemanticID mirrors the contract's deterministic id helper: the
// same logical entity always gets the same id, so replayed inserts
// conflict instead of duplicating.
func StableSemanticID(prefix string, parts ...string) string {
	sum := sha256.Sum256([]byte(strings.Join(parts, "\x00")))
	return prefix + "_" + hex.EncodeToString(sum[:])[:32]
}

// Recovery-case sentinel errors the API maps to wire shapes.
var (
	ErrRecoveryCaseNotFound    = errors.New("recovery case not found")
	ErrRecoveryCaseConflict    = errors.New("recovery case transition conflict")
	ErrRecoveryCaseReceiptGone = errors.New("recovery case receipt already recorded")
)

// RecoveryCaseInput creates one durable case (state "detected").
type RecoveryCaseInput struct {
	OrgID             string
	RunID             string
	WorkflowID        string
	WorkflowVersionID string
	Source            string // semanticRecoveryCaseSource for governed semantic recovery
	DetectorID        string
	SourceNodeID      string
	DetectorKind      string // "expression" | "schema"
	Action            string // "observe" | "quarantine"
	Message           string
	Details           map[string]any
	CreatedBy         string
}

// CreateRecoveryCase persists one case idempotently (the unique
// (org, run, detector) index absorbs replays) and returns its
// deterministic id.
func (e *Engine) CreateRecoveryCase(ctx context.Context, input RecoveryCaseInput) (string, error) {
	caseID := StableSemanticID("sem", input.OrgID, input.RunID, input.DetectorID)
	var details []byte
	if input.Details != nil {
		details, _ = json.Marshal(input.Details)
	}
	err := store.New(e.pool).InsertRecoveryCase(ctx, store.InsertRecoveryCaseParams{
		ID: caseID, OrgID: input.OrgID, RunID: input.RunID,
		WorkflowID:        pgtype.Text{String: input.WorkflowID, Valid: input.WorkflowID != ""},
		WorkflowVersionID: input.WorkflowVersionID,
		Source:            input.Source, DetectorID: input.DetectorID,
		SourceNodeID: input.SourceNodeID, DetectorKind: input.DetectorKind,
		Action: input.Action, Message: input.Message, DetailsJson: details,
		State:     "detected",
		CreatedBy: pgtype.Text{String: input.CreatedBy, Valid: input.CreatedBy != ""},
	})
	if err != nil {
		return "", fmt.Errorf("insert recovery case: %w", err)
	}
	return caseID, nil
}

// TransitionRecoveryCase applies one legal state change WITH its receipt,
// atomically. The receipt is validated by the domain contract first; the
// CAS (state = receipt.From) makes concurrent operators race to exactly
// one winner; the loser sees ErrRecoveryCaseConflict and no receipt.
func (e *Engine) TransitionRecoveryCase(
	ctx context.Context, orgID string, receipt domain.RecoveryCaseTransitionReceipt,
) error {
	if problems := domain.ValidateRecoveryCaseTransitionReceipt(receipt); len(problems) > 0 {
		return fmt.Errorf("invalid transition receipt: %s", strings.Join(problems, "; "))
	}
	occurredAt := e.now().UTC().Truncate(time.Millisecond)
	evidenceJSON, err := json.Marshal(receipt.Evidence)
	if err != nil {
		return fmt.Errorf("marshal evidence: %w", err)
	}
	tx, err := e.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := store.New(tx)

	current, err := q.GetRecoveryCase(ctx, store.GetRecoveryCaseParams{
		OrgID: orgID, ID: receipt.CaseID,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrRecoveryCaseNotFound
		}
		return fmt.Errorf("read case: %w", err)
	}
	if _, err := q.RevokeRecoveryApprovalGrants(ctx, store.RevokeRecoveryApprovalGrantsParams{
		RevokedAt: &occurredAt, OrgID: orgID, CaseID: receipt.CaseID,
	}); err != nil {
		return fmt.Errorf("revoke stale recovery approvals: %w", err)
	}
	moved, err := q.TransitionRecoveryCaseState(ctx, store.TransitionRecoveryCaseStateParams{
		OrgID: orgID, ID: receipt.CaseID,
		ToState: receipt.To, FromState: receipt.From,
		Terminal: domain.RecoveryCaseTerminalStates[receipt.To],
	})
	if err != nil {
		return fmt.Errorf("transition case: %w", err)
	}
	if moved == 0 {
		return ErrRecoveryCaseConflict
	}
	inserted, err := q.InsertRecoveryCaseTransition(ctx, store.InsertRecoveryCaseTransitionParams{
		ID:    StableSemanticID("sct", receipt.CaseID, receipt.From, receipt.To, fmt.Sprint(current.Revision)),
		OrgID: orgID, CaseID: receipt.CaseID,
		FromState: receipt.From, ToState: receipt.To,
		ActorKind:    receipt.ActorKind,
		ActorID:      pgtype.Text{String: receipt.ActorID, Valid: receipt.ActorID != ""},
		EvidenceJson: evidenceJSON,
		Reason:       pgtype.Text{String: receipt.Reason, Valid: receipt.Reason != ""},
		OccurredAt:   occurredAt,
	})
	if err != nil {
		return fmt.Errorf("insert receipt: %w", err)
	}
	if inserted == 0 {
		// A retry of the same revision was already recorded. Roll the state
		// change back rather than advance without a distinct receipt.
		return ErrRecoveryCaseReceiptGone
	}
	return tx.Commit(ctx)
}

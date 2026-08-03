// Durable Recovery Cases: the atomic case-transition writer, ported from
// the reference's persistence-ports/recovery.ts posture. A state change
// and its append-only receipt commit or roll back TOGETHER — a transition
// without a receipt is impossible by construction: the CAS UPDATE
// (state = from) and the receipt INSERT run in one transaction, receipt
// ids are deterministic (`sct_<sha256(caseId, toState)>`), and the
// baseline's unique (case_id, to_state) index makes replays no-ops
// instead of duplicates. The legality of every transition is validated by
// the pure domain ladder BEFORE any write.
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

// StableSemanticID mirrors the reference's deterministic id helper: the
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
	Source            string // "semantic_violation"
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
	occurredAt := time.Now().UTC()
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

	if _, err := q.GetRecoveryCase(ctx, store.GetRecoveryCaseParams{
		OrgID: orgID, ID: receipt.CaseID,
	}); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrRecoveryCaseNotFound
		}
		return fmt.Errorf("read case: %w", err)
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
		ID:    StableSemanticID("sct", receipt.CaseID, receipt.To),
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
		// The unique (case_id, to_state) index refused a re-entry: this
		// state was already reached once. The reference's single-visit
		// posture — roll the state change back rather than advance a case
		// without its receipt.
		return ErrRecoveryCaseReceiptGone
	}
	return tx.Commit(ctx)
}

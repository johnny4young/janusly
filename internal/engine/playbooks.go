// Evidence-gated Recovery Playbooks, implements the contract's
// recoveryPlaybooksRepo + the /dlq claim verifier: a playbook is a
// MANUALLY drafted, manually activated, exact-match (workflow + failure
// signature) recipe whose authority is always re-earned — every use runs
// a FRESH sandbox, a failed validation auto-retires with a regression
// mark, and a replay claim verifies the full evidence chain before any
// production mutation credits the playbook.
package engine

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/signature"
	"github.com/johnny4young/janusly/internal/store"
)

const (
	playbookTitleMaxChars        = 120
	playbookInstructionsMaxChars = 4_000
)

// Playbook lifecycle sentinel errors (API maps to wire shapes).
var (
	ErrPlaybookNotFound      = errors.New("recovery playbook not found")
	ErrPlaybookConflict      = errors.New("recovery playbook activation conflict")
	ErrPlaybookInvalidStatus = errors.New("recovery playbook is not in the required status")
)

// PlaybookDraftInput creates one draft (idempotent on source version).
type PlaybookDraftInput struct {
	OrgID                   string
	WorkflowID              string
	Signature               string
	Title                   string
	InstructionsMarkdown    string
	EvidenceRequirements    any
	SourceWorkflowVersionID string
	ApproachLabel           string
	ValidationRunID         string
	Actor                   string
}

// CreatePlaybookDraft: one playbook per exact source version (idempotent),
// version numbers monotonic per (org, signature) under the shared bounded
// unique-violation retry policy.
func (e *Engine) CreatePlaybookDraft(ctx context.Context, input PlaybookDraftInput) (store.RecoveryPlaybook, bool, error) {
	q := store.New(e.pool)
	if existing, err := q.FindPlaybookBySourceVersion(ctx, store.FindPlaybookBySourceVersionParams{
		OrgID: input.OrgID, SourceWorkflowVersionID: input.SourceWorkflowVersionID,
	}); err == nil {
		return existing, false, nil
	}
	title := truncateRunes(input.Title, playbookTitleMaxChars)
	instructions := truncateRunes(input.InstructionsMarkdown, playbookInstructionsMaxChars)
	evidenceJSON, _ := json.Marshal(input.EvidenceRequirements)
	if input.EvidenceRequirements == nil {
		evidenceJSON = []byte(`{}`)
	}
	for range 3 {
		version, err := q.MaxPlaybookVersion(ctx, store.MaxPlaybookVersionParams{
			OrgID: input.OrgID, Signature: input.Signature,
		})
		if err != nil {
			return store.RecoveryPlaybook{}, false, fmt.Errorf("read max version: %w", err)
		}
		id := e.newID()
		err = q.InsertRecoveryPlaybookDraft(ctx, store.InsertRecoveryPlaybookDraftParams{
			ID: id, OrgID: input.OrgID,
			WorkflowID: pgtype.Text{String: input.WorkflowID, Valid: input.WorkflowID != ""},
			Signature:  input.Signature, Version: version + 1,
			Title: title, InstructionsMarkdown: instructions,
			EvidenceRequirementsJson: evidenceJSON,
			SourceWorkflowVersionID:  input.SourceWorkflowVersionID,
			ApproachLabel:            input.ApproachLabel,
			LastValidationRunID:      pgtype.Text{String: input.ValidationRunID, Valid: input.ValidationRunID != ""},
			CreatedBy:                pgtype.Text{String: input.Actor, Valid: input.Actor != ""},
		})
		if err == nil {
			created, err := q.GetRecoveryPlaybook(ctx, store.GetRecoveryPlaybookParams{OrgID: input.OrgID, ID: id})
			if err != nil {
				return store.RecoveryPlaybook{}, false, fmt.Errorf("read created playbook: %w", err)
			}
			return created, true, nil
		}
		var pgErr *pgconn.PgError
		if !errors.As(err, &pgErr) || pgErr.Code != "23505" {
			return store.RecoveryPlaybook{}, false, fmt.Errorf("insert draft: %w", err)
		}
		if duplicate, dupErr := q.FindPlaybookBySourceVersion(ctx, store.FindPlaybookBySourceVersionParams{
			OrgID: input.OrgID, SourceWorkflowVersionID: input.SourceWorkflowVersionID,
		}); dupErr == nil {
			return duplicate, false, nil
		}
	}
	return store.RecoveryPlaybook{}, false, errors.New("recovery playbook version retry exhausted")
}

// ActivatePlaybook retires any previous active exact match and flips the
// draft, in one transaction. The baseline's partial unique index (one
// active per (org, workflow, signature)) turns a concurrent double
// activation into a clean conflict — the loser stays a draft.
func (e *Engine) ActivatePlaybook(ctx context.Context, orgID, id, actor string) (store.RecoveryPlaybook, error) {
	tx, err := e.pool.Begin(ctx)
	if err != nil {
		return store.RecoveryPlaybook{}, fmt.Errorf("begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := store.New(tx)
	current, err := q.GetRecoveryPlaybook(ctx, store.GetRecoveryPlaybookParams{OrgID: orgID, ID: id})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return store.RecoveryPlaybook{}, ErrPlaybookNotFound
		}
		return store.RecoveryPlaybook{}, fmt.Errorf("read playbook: %w", err)
	}
	if current.Status != "draft" {
		return store.RecoveryPlaybook{}, fmt.Errorf("%w: %s", ErrPlaybookInvalidStatus, current.Status)
	}
	if _, err := q.RetirePreviousActivePlaybookMatch(ctx, store.RetirePreviousActivePlaybookMatchParams{
		OrgID: orgID, WorkflowID: current.WorkflowID, Signature: current.Signature,
		Actor: pgtype.Text{String: actor, Valid: actor != ""}, ExcludeID: id,
	}); err != nil {
		return store.RecoveryPlaybook{}, fmt.Errorf("retire previous match: %w", err)
	}
	activated, err := q.ActivateDraftPlaybook(ctx, store.ActivateDraftPlaybookParams{
		OrgID: orgID, ID: id, Actor: pgtype.Text{String: actor, Valid: actor != ""},
	})
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return store.RecoveryPlaybook{}, ErrPlaybookConflict
		}
		return store.RecoveryPlaybook{}, fmt.Errorf("activate: %w", err)
	}
	if activated == 0 {
		return store.RecoveryPlaybook{}, fmt.Errorf("%w: %s", ErrPlaybookInvalidStatus, current.Status)
	}
	if err := tx.Commit(ctx); err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return store.RecoveryPlaybook{}, ErrPlaybookConflict
		}
		return store.RecoveryPlaybook{}, fmt.Errorf("commit: %w", err)
	}
	result, err := store.New(e.pool).GetRecoveryPlaybook(ctx, store.GetRecoveryPlaybookParams{OrgID: orgID, ID: id})
	if err != nil {
		return store.RecoveryPlaybook{}, fmt.Errorf("read activated: %w", err)
	}
	return result, nil
}

// DeadLetterSignature derives the exact failure signature the playbook
// match is keyed on — the SAME normalization the clustering surfaces use.
func DeadLetterSignature(item store.GetDeadLetterRow) string {
	return deadLetterSignatureFromParts(item.NodeID, item.NodeJson, item.ErrorJson)
}

// deadLetterSignatureFromParts is the shared normalizer entry for callers
// holding a different row projection (alert producers, redrive).
func deadLetterSignatureFromParts(nodeID string, nodeJSON, errorJSON []byte) string {
	var node struct {
		Type   string `json:"type"`
		Config struct {
			Tool string `json:"tool"`
		} `json:"config"`
	}
	_ = json.Unmarshal(nodeJSON, &node)
	return signature.NormalizeJSON(errorJSON, signature.Context{
		NodeID: nodeID, NodeType: node.Type, ToolName: node.Config.Tool,
	}).Signature
}

// VerifyPlaybookReplayClaim ports the contract's full evidence chain: an
// ACTIVE exact-match playbook + a FRESH succeeded validation run of this
// dead letter's run, carrying this playbook, whose validated workflow is
// byte-identical to the workflow the replay will run.
func (e *Engine) VerifyPlaybookReplayClaim(
	ctx context.Context, orgID string, item store.GetDeadLetterRow,
	workflow *domain.Workflow, playbookID, validationRunID string,
) bool {
	q := store.New(e.pool)
	playbook, err := q.GetRecoveryPlaybook(ctx, store.GetRecoveryPlaybookParams{OrgID: orgID, ID: playbookID})
	if err != nil {
		return false
	}
	sig := DeadLetterSignature(item)
	if playbook.Status != "active" || playbook.WorkflowID.String != workflow.ID || playbook.Signature != sig {
		return false
	}
	run, err := q.GetRun(ctx, store.GetRunParams{ID: validationRunID, OrgID: orgID})
	if err != nil {
		return false
	}
	if !run.ReplayMode.Valid || run.ReplayMode.String != "validation" ||
		!run.ValidationEvidenceLevel.Valid || run.ValidationEvidenceLevel.String == "writes_skipped" ||
		run.ParentRunID.String != item.RunID || run.Status != "succeeded" {
		return false
	}
	var envelope struct {
		Workflow           json.RawMessage `json:"workflow"`
		RecoveryPlaybookID string          `json:"recoveryPlaybookId"`
	}
	if json.Unmarshal(run.InputJson, &envelope) != nil || envelope.RecoveryPlaybookID != playbookID {
		return false
	}
	validated, _ := domain.Parse(envelope.Workflow)
	if validated == nil {
		return false
	}
	return WorkflowsEqual(validated, workflow)
}

// workflowsEqual is the runtime's totalChanges==0 equivalent: canonical
// re-marshal of both parsed documents and byte comparison.
func WorkflowsEqual(a, b *domain.Workflow) bool {
	rawA, errA := json.Marshal(a)
	rawB, errB := json.Marshal(b)
	return errA == nil && errB == nil && bytes.Equal(rawA, rawB)
}

// recordPlaybookValidationOutcome runs at a validation run's terminal flip.
// The run marker and playbook mutation share the caller's transaction, so a
// later outcome read can be idempotent without racing terminal completion.
func (e *Engine) recordPlaybookValidationOutcome(ctx context.Context, q *store.Queries, runID, status string) error {
	run, err := q.GetRunExecution(ctx, runID)
	if err != nil || !run.ReplayMode.Valid || run.ReplayMode.String != "validation" {
		return nil
	}
	var envelope struct {
		RecoveryPlaybookID string `json:"recoveryPlaybookId"`
	}
	if json.Unmarshal(run.InputJson, &envelope) != nil || envelope.RecoveryPlaybookID == "" {
		return nil
	}
	_, err = e.recordPlaybookValidationWithQueries(
		ctx, q, run.OrgID, envelope.RecoveryPlaybookID, runID, status == "succeeded", "system",
	)
	return err
}

func (e *Engine) recordPlaybookValidationWithQueries(
	ctx context.Context,
	q *store.Queries,
	orgID, playbookID, validationRunID string,
	succeeded bool,
	actor string,
) (bool, error) {
	params := store.RecordPlaybookValidationSuccessParams{
		OrgID: orgID, ID: playbookID,
		ValidationRunID: pgtype.Text{String: validationRunID, Valid: true},
		Actor:           pgtype.Text{String: actor, Valid: actor != ""},
	}
	var (
		recorded int64
		err      error
	)
	if succeeded {
		recorded, err = q.RecordPlaybookValidationSuccess(ctx, params)
	} else {
		recorded, err = q.RecordPlaybookValidationRegression(ctx, store.RecordPlaybookValidationRegressionParams(params))
	}
	if err != nil {
		return false, err
	}
	if recorded == 0 {
		return false, nil
	}
	action := "recovery.playbook.validated"
	if !succeeded {
		action = "recovery.playbook.regressed"
	}
	metadata, _ := json.Marshal(map[string]any{"validationRunId": validationRunID})
	if err := q.InsertAuditLogRow(ctx, store.InsertAuditLogRowParams{
		ID: e.newID(), OrgID: orgID,
		UserID:     pgtype.Text{String: actor, Valid: actor != ""},
		Action:     action,
		TargetType: pgtype.Text{String: "recovery_playbook", Valid: true},
		TargetID:   pgtype.Text{String: playbookID, Valid: true},
		Metadata:   metadata,
	}); err != nil {
		return false, err
	}
	return true, nil
}

// RecordPlaybookValidationOutcome is the explicit outcome/read-back path.
// Terminal completion normally wins the marker first; callers then receive
// recorded=false and the already-converged playbook.
func (e *Engine) RecordPlaybookValidationOutcome(
	ctx context.Context,
	orgID, playbookID, validationRunID string,
	succeeded bool,
	actor string,
) (store.RecoveryPlaybook, bool, error) {
	tx, err := e.pool.Begin(ctx)
	if err != nil {
		return store.RecoveryPlaybook{}, false, fmt.Errorf("begin validation outcome: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := store.New(e.wrapTx(tx))
	recorded, err := e.recordPlaybookValidationWithQueries(
		ctx, q, orgID, playbookID, validationRunID, succeeded, actor,
	)
	if err != nil {
		return store.RecoveryPlaybook{}, false, fmt.Errorf("record validation outcome: %w", err)
	}
	playbook, err := q.GetRecoveryPlaybook(ctx, store.GetRecoveryPlaybookParams{OrgID: orgID, ID: playbookID})
	if err != nil {
		return store.RecoveryPlaybook{}, false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return store.RecoveryPlaybook{}, false, fmt.Errorf("commit validation outcome: %w", err)
	}
	return playbook, recorded, nil
}

func (e *Engine) recordPlaybookAppliedWithQueries(
	ctx context.Context,
	q *store.Queries,
	orgID, playbookID, validationRunID, deadLetterID, actor string,
) (bool, error) {
	recorded, err := q.RecordPlaybookApplied(ctx, store.RecordPlaybookAppliedParams{
		OrgID: orgID, ID: playbookID,
		ValidationRunID: pgtype.Text{String: validationRunID, Valid: true},
		Actor:           pgtype.Text{String: actor, Valid: actor != ""},
	})
	if err != nil || recorded == 0 {
		return false, err
	}
	metadata, _ := json.Marshal(map[string]any{
		"deadLetterId": deadLetterID, "validationRunId": validationRunID,
	})
	if err := q.InsertAuditLogRow(ctx, store.InsertAuditLogRowParams{
		ID: e.newID(), OrgID: orgID,
		UserID:     pgtype.Text{String: actor, Valid: actor != ""},
		Action:     "recovery.playbook.applied",
		TargetType: pgtype.Text{String: "recovery_playbook", Valid: true},
		TargetID:   pgtype.Text{String: playbookID, Valid: true},
		Metadata:   metadata,
	}); err != nil {
		return false, err
	}
	return true, nil
}

// RecordPlaybookApplied confirms a terminally successful use. The terminal
// impact transaction normally records it first; this route-safe form is an
// idempotent convergence/read-back operation.
func (e *Engine) RecordPlaybookApplied(
	ctx context.Context,
	orgID, playbookID, validationRunID, deadLetterID, actor string,
) (store.RecoveryPlaybook, bool, error) {
	tx, err := e.pool.Begin(ctx)
	if err != nil {
		return store.RecoveryPlaybook{}, false, fmt.Errorf("begin applied outcome: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := store.New(e.wrapTx(tx))
	recorded, err := e.recordPlaybookAppliedWithQueries(
		ctx, q, orgID, playbookID, validationRunID, deadLetterID, actor,
	)
	if err != nil {
		return store.RecoveryPlaybook{}, false, fmt.Errorf("record applied outcome: %w", err)
	}
	playbook, err := q.GetRecoveryPlaybook(ctx, store.GetRecoveryPlaybookParams{OrgID: orgID, ID: playbookID})
	if err != nil {
		return store.RecoveryPlaybook{}, false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return store.RecoveryPlaybook{}, false, fmt.Errorf("commit applied outcome: %w", err)
	}
	return playbook, recorded, nil
}

func truncateRunes(value string, max int) string {
	runes := []rune(value)
	if len(runes) <= max {
		return value
	}
	return string(runes[:max])
}

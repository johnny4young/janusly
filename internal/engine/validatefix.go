// The Recovery dialog's sandbox gate, implements the contract's
// replayDeadLetterAsValidation: a proposed fix runs as a FRESH validation
// replay of the suggested workflow — write sides skipped, static
// evidence, trace-only replay lineage back to the failed run — so an
// operator sees real signal before any production mutation.
package engine

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/store"
)

// ErrValidateFixFailingNodeMissing reports a suggestion that dropped the
// failing node — the sandbox could not exercise the failure path.
var ErrValidateFixFailingNodeMissing = errors.New("suggested workflow does not contain the failing node")

// ReplayDeadLetterAsValidation seeds a validation run of the SUGGESTED
// workflow with the original run's resolved input. The new run carries
// replayMode="validation" (write-side skips plus static evidence) and
// trace-only lineage (parentLinkKind="replay") back to the
// failed run for the Recovery dialog's before/after projection.
func (e *Engine) ReplayDeadLetterAsValidation(
	ctx context.Context, orgID, deadLetterID string, suggested *domain.Workflow, createdBy string,
) (string, error) {
	return e.ReplayDeadLetterAsValidationWithPlaybook(ctx, orgID, deadLetterID, suggested, createdBy, "")
}

// ReplayDeadLetterAsValidationWithPlaybook additionally records the
// playbook claim in the run input so the terminal flip can attribute the
// sandbox outcome (fresh evidence or auto-retire).
func (e *Engine) ReplayDeadLetterAsValidationWithPlaybook(
	ctx context.Context, orgID, deadLetterID string, suggested *domain.Workflow, createdBy, playbookID string,
) (string, error) {
	q := store.New(e.pool)
	item, err := q.GetDeadLetter(ctx, store.GetDeadLetterParams{ID: deadLetterID, OrgID: orgID})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", ErrDeadLetterNotFound
		}
		return "", fmt.Errorf("read dead letter: %w", err)
	}

	found := false
	for _, node := range suggested.Nodes {
		if node.ID == item.NodeID {
			found = true
			break
		}
	}
	if !found {
		return "", ErrValidateFixFailingNodeMissing
	}

	// The original run's RESOLVED input seeds the sandbox so the fix is
	// validated against the exact payload that failed.
	var originalInput any
	if run, err := q.GetRunExecution(ctx, item.RunID); err == nil {
		var envelope struct {
			Input any `json:"input"`
		}
		_ = json.Unmarshal(run.InputJson, &envelope)
		originalInput = envelope.Input
	}

	// The CONTINUATION shape (reference consistency): only the failing node
	// re-executes. Ancestors copy their terminal context from the original
	// run so templates on the failing node see the same upstream outputs;
	// descendants stay pending (the ordinary cascade continues the
	// validation); everything else is skipped as outside the path.
	ancestors := collectRelatives(suggested, item.NodeID, true)
	descendants := collectRelatives(suggested, item.NodeID, false)
	originalRows, err := q.ListRunNodesByRun(ctx, item.RunID)
	if err != nil {
		return "", fmt.Errorf("read original nodes: %w", err)
	}
	originalByID := map[string]store.ListRunNodesByRunRow{}
	for _, row := range originalRows {
		originalByID[row.NodeID] = row
	}

	runID := e.newID()
	inputEnvelope := map[string]any{
		"workflow": suggested, "input": originalInput,
		"failingNodeId": item.NodeID, "validationEffectMode": "skip",
	}
	if playbookID != "" {
		inputEnvelope["recoveryPlaybookId"] = playbookID
	}
	inputJSON, err := json.Marshal(inputEnvelope)
	if err != nil {
		return "", fmt.Errorf("marshal validation input: %w", err)
	}
	tx, err := e.pool.Begin(ctx)
	if err != nil {
		return "", fmt.Errorf("begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	txq := store.New(e.wrapTx(tx))
	if err := txq.InsertRun(ctx, store.InsertRunParams{
		ID: runID, OrgID: orgID, WorkflowVersionID: runID,
		Status: "running", InputJson: inputJSON,
		CreatedBy:               pgtype.Text{String: createdBy, Valid: createdBy != ""},
		ReplayMode:              pgtype.Text{String: "validation", Valid: true},
		ValidationEvidenceLevel: pgtype.Text{String: "static", Valid: true},
		ParentRunID:             pgtype.Text{String: item.RunID, Valid: true},
		ParentLinkKind:          pgtype.Text{String: "replay", Valid: true},
	}); err != nil {
		return "", fmt.Errorf("insert validation run: %w", err)
	}
	copyableStatuses := map[string]bool{"succeeded": true, "skipped": true}
	for _, node := range suggested.Nodes {
		original, hasOriginal := originalByID[node.ID]
		startsQueued := node.ID == item.NodeID
		canCopy := !startsQueued && ancestors[node.ID] && hasOriginal && copyableStatuses[original.Status]
		continues := descendants[node.ID]

		status := "skipped"
		attempts := int32(0)
		stateJSON := []byte(`{"skipped":{"reason":"outside_validation_path"}}`)
		switch {
		case canCopy:
			status = original.Status
			attempts = original.Attempts.Int32
			stateJSON = original.StateJson
			if len(stateJSON) == 0 {
				stateJSON = []byte(`{}`)
			}
		case startsQueued:
			status, attempts, stateJSON = "queued", 1, []byte(`{}`)
		case continues:
			status, attempts, stateJSON = "pending", 0, []byte(`{}`)
		}
		if err := txq.InsertRunNode(ctx, store.InsertRunNodeParams{
			ID: e.newID(), RunID: runID, NodeID: node.ID,
			Status: status, Attempts: pgtype.Int4{Int32: attempts, Valid: true},
			StateJson: stateJSON,
		}); err != nil {
			return "", fmt.Errorf("seed validation node %s: %w", node.ID, err)
		}
	}
	startedAt := eventNow()
	payload, _ := json.Marshal(map[string]any{
		"originalRunId": item.RunID, "failingNodeId": item.NodeID,
		"validationEffectMode": "skip",
	})
	if err := txq.InsertRunEventAt(ctx, store.InsertRunEventAtParams{
		ID: e.newID(), RunID: runID,
		Type: "run.started.validation", Payload: payload, CreatedAt: &startedAt,
	}); err != nil {
		return "", fmt.Errorf("insert run.started.validation: %w", err)
	}
	if err := txq.NotifyWake(ctx, runID); err != nil {
		return "", fmt.Errorf("notify wake: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return "", fmt.Errorf("commit: %w", err)
	}
	return runID, nil
}

// collectRelatives walks the edge graph from nodeID: ancestors (walk
// incoming) or descendants (walk outgoing), excluding the node itself.
func collectRelatives(wf *domain.Workflow, nodeID string, ancestors bool) map[string]bool {
	adjacency := map[string][]string{}
	for _, edge := range wf.Edges {
		if ancestors {
			adjacency[edge.To] = append(adjacency[edge.To], edge.From)
		} else {
			adjacency[edge.From] = append(adjacency[edge.From], edge.To)
		}
	}
	seen := map[string]bool{}
	queue := append([]string{}, adjacency[nodeID]...)
	for len(queue) > 0 {
		current := queue[0]
		queue = queue[1:]
		if seen[current] {
			continue
		}
		seen[current] = true
		queue = append(queue, adjacency[current]...)
	}
	return seen
}

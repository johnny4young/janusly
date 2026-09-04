// Replay Lab adapters (reference the source contract
// replay-lab.ts): standalone sandbox replay of ANY historic run (whole
// DAG from roots) and the targeted FORK (start at one node, predecessors
// cloned from the source run's terminal state). Both write
// replayMode="validation" runs — the engine's dryRun gate skips
// write-side effects uniformly — with trace-only "replay" lineage and
// NO workflow_versions row (sandbox runs never produce reusable
// versions; the snapshot lives in runs.inputJson). Sandbox runs carry a
// NULL traceId, the contract posture.
package engine

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/store"
)

// ReplayRunAsValidation writes a fresh whole-DAG sandbox run: roots
// queued, downstream pending, run.started.replay-lab event, one tx.
func (e *Engine) ReplayRunAsValidation(
	ctx context.Context, orgID, sourceRunID string, wf *domain.Workflow,
	input any, createdBy string, hasPatch bool,
) (string, error) {
	runID := e.newID()
	if input == nil {
		input = map[string]any{}
	}
	inputJSON, err := json.Marshal(map[string]any{"workflow": wf, "input": input})
	if err != nil {
		return "", fmt.Errorf("marshal lab input: %w", err)
	}
	roots := map[string]bool{}
	for _, node := range wf.Nodes {
		roots[node.ID] = true
	}
	for _, edge := range wf.Edges {
		delete(roots, edge.To)
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
		ParentRunID:             pgtype.Text{String: sourceRunID, Valid: true},
		ParentLinkKind:          pgtype.Text{String: "replay", Valid: true},
	}); err != nil {
		return "", fmt.Errorf("insert lab run: %w", err)
	}
	for _, node := range wf.Nodes {
		status, attempts := "pending", int32(0)
		if roots[node.ID] {
			status, attempts = "queued", 1
		}
		if err := txq.InsertRunNode(ctx, store.InsertRunNodeParams{
			ID: e.newID(), RunID: runID, NodeID: node.ID,
			Status: status, Attempts: pgtype.Int4{Int32: attempts, Valid: true},
			StateJson: []byte(`{}`),
		}); err != nil {
			return "", fmt.Errorf("seed lab node %s: %w", node.ID, err)
		}
	}
	startedAt := e.eventNow()
	payload, _ := json.Marshal(map[string]any{
		"workflowVersionId": runID, "sourceRunId": sourceRunID, "hasPatch": hasPatch,
	})
	if err := txq.InsertRunEventAt(ctx, store.InsertRunEventAtParams{
		ID: e.newID(), RunID: runID,
		Type: "run.started.replay-lab", Payload: payload, CreatedAt: &startedAt,
	}); err != nil {
		return "", fmt.Errorf("insert run.started.replay-lab: %w", err)
	}
	if err := txq.NotifyWake(ctx, runID); err != nil {
		return "", fmt.Errorf("notify wake: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return "", fmt.Errorf("commit: %w", err)
	}
	return runID, nil
}

// ReplayLabForkResult is the discriminated fork outcome — validation
// misses answer codes, never throws (the route maps them to 422).
type ReplayLabForkResult struct {
	OK               bool
	RunID            string
	PredecessorCount int
	Code             string
	Message          string
}

// ReplayRunAsValidationFork clones the fork node's transitive
// predecessors from the source run (all must have succeeded), queues
// ONLY the fork node (optionally seeded with an input override), keeps
// the downstream closure pending, and marks every unrelated branch
// skipped so the sandbox never executes them.
func (e *Engine) ReplayRunAsValidationFork(
	ctx context.Context, orgID, sourceRunID string, wf *domain.Workflow,
	forkNodeID string, inputOverride, input any, createdBy string,
) (ReplayLabForkResult, error) {
	found := false
	for _, node := range wf.Nodes {
		if node.ID == forkNodeID {
			found = true
			break
		}
	}
	if !found {
		return ReplayLabForkResult{Code: "fork_node_not_found",
			Message: fmt.Sprintf("Fork node %q is not part of the source run's workflow.", forkNodeID)}, nil
	}
	predecessors := collectRelatives(wf, forkNodeID, true)
	downstream := collectRelatives(wf, forkNodeID, false)

	sourceRows, err := store.New(e.pool).ListRunNodesByRun(ctx, sourceRunID)
	if err != nil {
		return ReplayLabForkResult{}, fmt.Errorf("read source nodes: %w", err)
	}
	sourceByID := map[string]store.ListRunNodesByRunRow{}
	for _, row := range sourceRows {
		sourceByID[row.NodeID] = row
	}
	for predID := range predecessors {
		row, ok := sourceByID[predID]
		if !ok || row.Status != "succeeded" {
			status := "missing"
			if ok {
				status = row.Status
			}
			return ReplayLabForkResult{Code: "predecessor_not_succeeded",
				Message: fmt.Sprintf("Predecessor node %q did not succeed in the source run (status: %s).", predID, status)}, nil
		}
	}

	runID := e.newID()
	if input == nil {
		input = map[string]any{}
	}
	inputJSON, err := json.Marshal(map[string]any{
		"workflow": wf, "input": input,
		"fork": map[string]any{
			"sourceRunId": sourceRunID, "forkNodeId": forkNodeID,
			"hasOverride": inputOverride != nil,
		},
	})
	if err != nil {
		return ReplayLabForkResult{}, fmt.Errorf("marshal fork input: %w", err)
	}
	tx, err := e.pool.Begin(ctx)
	if err != nil {
		return ReplayLabForkResult{}, fmt.Errorf("begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	txq := store.New(e.wrapTx(tx))
	if err := txq.InsertRun(ctx, store.InsertRunParams{
		ID: runID, OrgID: orgID, WorkflowVersionID: runID,
		Status: "running", InputJson: inputJSON,
		CreatedBy:               pgtype.Text{String: createdBy, Valid: createdBy != ""},
		ReplayMode:              pgtype.Text{String: "validation", Valid: true},
		ValidationEvidenceLevel: pgtype.Text{String: "static", Valid: true},
		ParentRunID:             pgtype.Text{String: sourceRunID, Valid: true},
		ParentNodeID:            pgtype.Text{String: forkNodeID, Valid: true},
		ParentLinkKind:          pgtype.Text{String: "replay", Valid: true},
	}); err != nil {
		return ReplayLabForkResult{}, fmt.Errorf("insert fork run: %w", err)
	}
	for _, node := range wf.Nodes {
		params := store.InsertRunNodeParams{
			ID: e.newID(), RunID: runID, NodeID: node.ID,
			Status: "skipped", Attempts: pgtype.Int4{Int32: 0, Valid: true},
			StateJson: []byte(`{"skipped":{"reason":"outside_replay_fork","forkNodeId":"` + forkNodeID + `"}}`),
		}
		switch {
		case predecessors[node.ID]:
			source := sourceByID[node.ID]
			state := source.StateJson
			if len(state) == 0 {
				state = []byte(`{}`)
			}
			params.Status, params.StateJson = "succeeded", state
		case node.ID == forkNodeID:
			seed := []byte(`{}`)
			if inputOverride != nil {
				if raw, err := json.Marshal(map[string]any{"input": inputOverride}); err == nil {
					seed = raw
				}
			}
			params.Status, params.StateJson = "queued", seed
			params.Attempts = pgtype.Int4{Int32: 1, Valid: true}
		case downstream[node.ID]:
			params.Status, params.StateJson = "pending", []byte(`{}`)
		}
		if err := txq.InsertRunNode(ctx, params); err != nil {
			return ReplayLabForkResult{}, fmt.Errorf("seed fork node %s: %w", node.ID, err)
		}
	}
	startedAt := e.eventNow()
	payload, _ := json.Marshal(map[string]any{
		"workflowVersionId": runID, "sourceRunId": sourceRunID, "forkNodeId": forkNodeID,
		"predecessorCount": len(predecessors), "hasOverride": inputOverride != nil,
	})
	if err := txq.InsertRunEventAt(ctx, store.InsertRunEventAtParams{
		ID: e.newID(), RunID: runID,
		Type: "run.started.replay-lab-fork", Payload: payload, CreatedAt: &startedAt,
	}); err != nil {
		return ReplayLabForkResult{}, fmt.Errorf("insert run.started.replay-lab-fork: %w", err)
	}
	if err := txq.NotifyWake(ctx, runID); err != nil {
		return ReplayLabForkResult{}, fmt.Errorf("notify wake: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return ReplayLabForkResult{}, fmt.Errorf("commit: %w", err)
	}
	return ReplayLabForkResult{OK: true, RunID: runID, PredecessorCount: len(predecessors)}, nil
}

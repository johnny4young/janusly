// Solution-pack sample runs are standalone sandboxes whose external trigger
// has already fired. They seed root nodes as succeeded with the selected
// sample payload, then let the ordinary worker execute the workflow body.
package engine

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/go/internal/domain"
	"github.com/johnny4young/janusly/go/internal/store"
)

// SandboxRunInput describes one standalone validation run with no source-run
// lineage. Source is provenance only and never participates in authorization.
type SandboxRunInput struct {
	OrgID     string
	Workflow  *domain.Workflow
	Input     any
	CreatedBy string
	Source    string
}

func sandboxSeedPlan(workflow *domain.Workflow) (roots, ready map[string]bool) {
	roots = make(map[string]bool, len(workflow.Nodes))
	predecessors := make(map[string][]string, len(workflow.Nodes))
	for _, node := range workflow.Nodes {
		roots[node.ID] = true
	}
	for _, edge := range workflow.Edges {
		delete(roots, edge.To)
		predecessors[edge.To] = append(predecessors[edge.To], edge.From)
	}
	ready = make(map[string]bool, len(workflow.Nodes)-len(roots))
	for _, node := range workflow.Nodes {
		if roots[node.ID] {
			continue
		}
		incoming := predecessors[node.ID]
		if len(incoming) == 0 {
			continue
		}
		allSeeded := true
		for _, predecessor := range incoming {
			if !roots[predecessor] {
				allSeeded = false
				break
			}
		}
		if allSeeded {
			ready[node.ID] = true
		}
	}
	return roots, ready
}

// StartSandboxRun atomically writes a fresh validation run, treats every root
// trigger as already completed with Input, and publishes only successors whose
// complete predecessor set was seeded. Write-side executors remain dry-run
// skipped through the ordinary replay_mode=validation gate.
func (e *Engine) StartSandboxRun(ctx context.Context, in SandboxRunInput) (string, error) {
	if in.Workflow == nil {
		return "", fmt.Errorf("sandbox workflow is required")
	}
	input := in.Input
	if input == nil {
		input = map[string]any{}
	}
	runID := e.newID()
	inputJSON, err := json.Marshal(map[string]any{
		"workflow": in.Workflow,
		"input":    input,
	})
	if err != nil {
		return "", fmt.Errorf("marshal sandbox input: %w", err)
	}
	roots, ready := sandboxSeedPlan(in.Workflow)
	if len(in.Workflow.Nodes) > 0 && len(roots) == 0 {
		return "", fmt.Errorf("sandbox workflow has no root node")
	}

	tx, err := e.pool.Begin(ctx)
	if err != nil {
		return "", fmt.Errorf("begin sandbox run: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := store.New(e.wrapTx(tx))
	if err := q.InsertRun(ctx, store.InsertRunParams{
		ID: runID, OrgID: in.OrgID, WorkflowVersionID: runID,
		Status: "running", InputJson: inputJSON,
		CreatedBy:               pgtype.Text{String: in.CreatedBy, Valid: in.CreatedBy != ""},
		ReplayMode:              pgtype.Text{String: "validation", Valid: true},
		ValidationEvidenceLevel: pgtype.Text{String: "static", Valid: true},
	}); err != nil {
		return "", fmt.Errorf("insert sandbox run: %w", err)
	}

	startedAt := eventNow()
	events := &runEventBuffer{}
	startedPayload := safePersist(map[string]any{
		"workflowVersionId": runID,
		"source":            in.Source,
	}, defaultPersistMaxBytes())
	events.add(e.newID(), runID, "", "run.started.sandbox", startedPayload, startedAt)

	rootIndex := 0
	for _, node := range in.Workflow.Nodes {
		status, attempts := "pending", int32(0)
		state := json.RawMessage(`{}`)
		var nodeStartedAt, nodeFinishedAt, publicationAt *time.Time
		publicationGeneration := int32(0)
		switch {
		case roots[node.ID]:
			status = "succeeded"
			nodeStartedAt, nodeFinishedAt = &startedAt, &startedAt
			state = safePersist(map[string]any{"output": input}, stateJSONMaxBytes)
		case ready[node.ID]:
			status, attempts = "queued", 1
			publicationAt, publicationGeneration = &startedAt, 1
		}
		if err := q.InsertSeededRunNode(ctx, store.InsertSeededRunNodeParams{
			ID: e.newID(), RunID: runID, NodeID: node.ID,
			Status: status, Attempts: pgtype.Int4{Int32: attempts, Valid: true},
			StateJson: state, StartedAt: nodeStartedAt, FinishedAt: nodeFinishedAt,
			QueuePublicationRepairAfter: publicationAt,
			QueuePublicationGeneration:  publicationGeneration,
		}); err != nil {
			return "", fmt.Errorf("seed sandbox node %s: %w", node.ID, err)
		}
		if roots[node.ID] {
			rootIndex++
			completedAt := startedAt.Add(time.Duration(rootIndex) * time.Millisecond)
			payload := safePersist(map[string]any{
				"output": input, "sandboxTrigger": true,
			}, defaultPersistMaxBytes())
			events.add(e.newID(), runID, node.ID, "node.completed", payload, completedAt)
		}
	}

	if len(ready) == 0 {
		causeAt := startedAt.Add(time.Duration(rootIndex) * time.Millisecond)
		if err := e.flipRunTerminal(ctx, q, events, runID, "succeeded",
			map[string]any{"nodes": len(in.Workflow.Nodes)}, causeAt, nil); err != nil {
			return "", err
		}
		if err := e.appendStatusChecked(ctx, events, runID, causeAt); err != nil {
			return "", err
		}
	} else if err := q.NotifyWake(ctx, runID); err != nil {
		return "", fmt.Errorf("notify sandbox work: %w", err)
	}
	if err := events.flush(ctx, q); err != nil {
		return "", err
	}
	if err := q.NotifyRunEvents(ctx, runID); err != nil {
		return "", fmt.Errorf("notify sandbox events: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return "", fmt.Errorf("commit sandbox run: %w", err)
	}
	return runID, nil
}

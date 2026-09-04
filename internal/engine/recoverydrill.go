// Solution-pack recovery drills cross real runtime boundaries while remaining
// validation runs. They are server-authored adapters, not a general facility
// for callers to fabricate run history.
package engine

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/store"
)

const (
	runtimeDrillSecretName = "JANUSLY_RUNTIME_DRILL_MISSING_SECRET"
	runtimeDrillProbeKey   = "runtimeDrillProbe"
	runtimeDrillTimeout    = 30 * time.Second
	runtimeDrillPoll       = 50 * time.Millisecond
	stallDrillMargin       = time.Second
	defaultStallThreshold  = time.Hour
	minStallThreshold      = 15 * time.Minute
	maxStallThreshold      = 24 * time.Hour
)

// RecoveryDrillSource is the bounded server-owned provenance persisted with a
// validation run. Public DLQ projection deliberately exposes a smaller subset.
type RecoveryDrillSource struct {
	Kind         string `json:"kind"`
	PackID       string `json:"packId"`
	FixtureID    string `json:"fixtureId"`
	FailureMode  string `json:"failureMode"`
	RecoveryPath string `json:"recoveryPath"`
}

type RecoveryDrillInput struct {
	OrgID        string
	CreatedBy    string
	Workflow     *domain.Workflow
	FailedNodeID string
	Input        any
	Source       RecoveryDrillSource
}

type RuntimeFailureDrillEvidence struct {
	RecoveryPath        string `json:"recoveryPath"`
	Boundary            string `json:"boundary"`
	ExecutedNodeID      string `json:"executedNodeId"`
	SeededAncestorCount int    `json:"seededAncestorCount"`
	Attempts            int32  `json:"attempts"`
	RuntimeMS           int64  `json:"runtimeMs"`
}

type StalledNodeDrillEvidence struct {
	RecoveryPath     string `json:"recoveryPath"`
	ThresholdMinutes int64  `json:"thresholdMinutes"`
	SimulatedStallMS int64  `json:"simulatedStallMs"`
	ReaperRuntimeMS  int64  `json:"reaperRuntimeMs"`
	Scanned          int    `json:"scanned"`
	Reaped           int    `json:"reaped"`
	DeadLettered     int    `json:"deadLettered"`
}

type RuntimeFailureDrillResult struct {
	RunID        string
	DeadLetterID string
	Evidence     RuntimeFailureDrillEvidence
}

type StalledNodeDrillResult struct {
	RunID        string
	DeadLetterID string
	Evidence     StalledNodeDrillEvidence
}

func cloneRuntimeFailureWorkflow(workflow *domain.Workflow, failedNodeID string) (*domain.Workflow, map[string]bool, error) {
	if workflow == nil {
		return nil, nil, errors.New("recovery drill workflow is required")
	}
	targetIndex := -1
	for i := range workflow.Nodes {
		if workflow.Nodes[i].ID == failedNodeID {
			targetIndex = i
			break
		}
	}
	if targetIndex < 0 {
		return nil, nil, fmt.Errorf("recovery drill node %s not found in workflow", failedNodeID)
	}

	predecessors := make(map[string][]string, len(workflow.Nodes))
	for _, edge := range workflow.Edges {
		predecessors[edge.To] = append(predecessors[edge.To], edge.From)
	}
	ancestors := make(map[string]bool, len(workflow.Nodes))
	pending := append([]string(nil), predecessors[failedNodeID]...)
	for len(pending) > 0 {
		last := len(pending) - 1
		nodeID := pending[last]
		pending = pending[:last]
		if ancestors[nodeID] {
			continue
		}
		ancestors[nodeID] = true
		pending = append(pending, predecessors[nodeID]...)
	}

	cloned := *workflow
	cloned.Nodes = append([]domain.Node(nil), workflow.Nodes...)
	target := cloned.Nodes[targetIndex]
	config := make(map[string]any, len(target.Config)+1)
	config[runtimeDrillProbeKey] = "{{secret." + runtimeDrillSecretName + "}}"
	for key, value := range target.Config {
		if key != runtimeDrillProbeKey {
			config[key] = value
		}
	}
	target.Config = config
	cloned.Nodes[targetIndex] = target
	return &cloned, ancestors, nil
}

func drillInputJSON(workflow *domain.Workflow, input any, drill any) json.RawMessage {
	if input == nil {
		input = map[string]any{}
	}
	return safePersist(map[string]any{
		"workflow": workflow,
		"input":    input,
		"drill":    drill,
	}, 0)
}

func (e *Engine) insertRuntimeFailureDrill(ctx context.Context, input RecoveryDrillInput, workflow *domain.Workflow, ancestors map[string]bool, now time.Time) (string, error) {
	runID := e.newID()
	tx, err := e.pool.Begin(ctx)
	if err != nil {
		return "", fmt.Errorf("begin runtime recovery drill: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := store.New(e.wrapTx(tx))
	if err := q.InsertRecoveryDrillRun(ctx, store.InsertRecoveryDrillRunParams{
		ID: runID, OrgID: input.OrgID, WorkflowVersionID: runID, Status: "running",
		InputJson:  drillInputJSON(workflow, input.Input, input.Source),
		WorkflowID: runWorkflowID(workflow, runID),
		CreatedBy:  pgtype.Text{String: input.CreatedBy, Valid: input.CreatedBy != ""},
		CreatedAt:  &now,
	}); err != nil {
		return "", fmt.Errorf("insert runtime recovery drill: %w", err)
	}

	roots := make(map[string]bool, len(workflow.Nodes))
	for _, node := range workflow.Nodes {
		roots[node.ID] = true
	}
	for _, edge := range workflow.Edges {
		delete(roots, edge.To)
	}
	for _, node := range workflow.Nodes {
		status := "pending"
		attempts := int32(0)
		state := map[string]any{}
		var startedAt, finishedAt, publicationAt *time.Time
		publicationGeneration := int32(0)
		switch {
		case node.ID == input.FailedNodeID:
			status, attempts = "queued", 1
			publicationAt, publicationGeneration = &now, 1
		case ancestors[node.ID]:
			status = "succeeded"
			startedAt, finishedAt = &now, &now
			output := any(map[string]any{})
			if roots[node.ID] {
				output = input.Input
				if output == nil {
					output = map[string]any{}
				}
			}
			state["output"] = output
		}
		if err := q.InsertSeededRunNode(ctx, store.InsertSeededRunNodeParams{
			ID: e.newID(), RunID: runID, NodeID: node.ID, Status: status,
			Attempts: pgtype.Int4{Int32: attempts, Valid: true}, StateJson: safePersist(state, stateJSONMaxBytes),
			StartedAt: startedAt, FinishedAt: finishedAt,
			QueuePublicationRepairAfter: publicationAt, QueuePublicationGeneration: publicationGeneration,
		}); err != nil {
			return "", fmt.Errorf("insert runtime recovery drill node %s: %w", node.ID, err)
		}
	}
	startedPayload := safePersist(map[string]any{"workflowVersionId": runID, "source": input.Source}, 0)
	if err := q.InsertRunEventAt(ctx, store.InsertRunEventAtParams{
		ID: e.newID(), RunID: runID, Type: "run.started.sandbox",
		Payload: startedPayload, CreatedAt: &now,
	}); err != nil {
		return "", fmt.Errorf("insert runtime recovery drill start event: %w", err)
	}
	eventOffset := 0
	for _, node := range workflow.Nodes {
		if !ancestors[node.ID] {
			continue
		}
		eventOffset++
		eventAt := now.Add(time.Duration(eventOffset) * time.Millisecond)
		if err := q.InsertRunEventAt(ctx, store.InsertRunEventAtParams{
			ID: e.newID(), RunID: runID,
			NodeID: pgtype.Text{String: node.ID, Valid: true},
			Type:   "node.completed", Payload: json.RawMessage(`{"runtimeDrillSeeded":true}`),
			CreatedAt: &eventAt,
		}); err != nil {
			return "", fmt.Errorf("insert runtime recovery drill ancestor event: %w", err)
		}
	}
	if err := q.NotifyWake(ctx, runID); err != nil {
		return "", fmt.Errorf("notify runtime recovery drill: %w", err)
	}
	if err := q.NotifyRunEvents(ctx, runID); err != nil {
		return "", fmt.Errorf("notify runtime recovery drill events: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return "", fmt.Errorf("commit runtime recovery drill: %w", err)
	}
	return runID, nil
}

// RunRuntimeFailureDrill seeds successful ancestors and lets the ordinary Go
// worker claim and fail the selected node before any provider or effect call.
func (e *Engine) RunRuntimeFailureDrill(ctx context.Context, input RecoveryDrillInput) (RuntimeFailureDrillResult, error) {
	if _, configured := os.LookupEnv(runtimeDrillSecretName); configured {
		return RuntimeFailureDrillResult{}, fmt.Errorf("%s must remain unset for safe runtime drills", runtimeDrillSecretName)
	}
	workflow, ancestors, err := cloneRuntimeFailureWorkflow(input.Workflow, input.FailedNodeID)
	if err != nil {
		return RuntimeFailureDrillResult{}, err
	}
	now := e.now().UTC()
	runID, err := e.insertRuntimeFailureDrill(ctx, input, workflow, ancestors, now)
	if err != nil {
		return RuntimeFailureDrillResult{}, err
	}

	started := time.Now()
	deadline := time.NewTimer(runtimeDrillTimeout)
	defer deadline.Stop()
	ticker := time.NewTicker(runtimeDrillPoll)
	defer ticker.Stop()
	for {
		row, queryErr := store.New(e.pool).FindLatestDeadLetterForNode(ctx, store.FindLatestDeadLetterForNodeParams{
			OrgID: input.OrgID, RunID: runID, NodeID: input.FailedNodeID,
		})
		if queryErr == nil {
			return RuntimeFailureDrillResult{
				RunID: runID, DeadLetterID: row.ID,
				Evidence: RuntimeFailureDrillEvidence{
					RecoveryPath: "runtime_failure", Boundary: "worker_dlq",
					ExecutedNodeID: input.FailedNodeID, SeededAncestorCount: len(ancestors),
					Attempts: row.Attempt, RuntimeMS: max(time.Since(started).Milliseconds(), 0),
				},
			}, nil
		}
		if !errors.Is(queryErr, pgx.ErrNoRows) {
			return RuntimeFailureDrillResult{}, fmt.Errorf("query runtime recovery drill failure: %w", queryErr)
		}
		select {
		case <-ctx.Done():
			return RuntimeFailureDrillResult{}, ctx.Err()
		case <-deadline.C:
			return RuntimeFailureDrillResult{}, fmt.Errorf("runtime failure drill timed out waiting for node %s", input.FailedNodeID)
		case <-ticker.C:
		}
	}
}

func configuredStallThreshold() time.Duration {
	threshold := defaultStallThreshold
	if raw := os.Getenv("JANUSLY_REAPER_THRESHOLD_MS"); raw != "" {
		if milliseconds, err := strconv.ParseInt(raw, 10, 64); err == nil && milliseconds > 0 {
			threshold = time.Duration(milliseconds) * time.Millisecond
		}
	} else if raw := os.Getenv("JANUSLY_STALLED_NODE_THRESHOLD_MINUTES"); raw != "" {
		if minutes, err := strconv.ParseInt(raw, 10, 64); err == nil && minutes > 0 {
			threshold = time.Duration(minutes) * time.Minute
		}
	}
	floor := minStallThreshold
	if raw := os.Getenv("JANUSLY_REAPER_THRESHOLD_FLOOR_MS"); raw != "" {
		if milliseconds, err := strconv.ParseInt(raw, 10, 64); err == nil && milliseconds > 0 {
			floor = time.Duration(milliseconds) * time.Millisecond
		}
	}
	if floor > maxStallThreshold {
		floor = maxStallThreshold
	}
	if threshold < floor {
		threshold = floor
	}
	if threshold > maxStallThreshold {
		threshold = maxStallThreshold
	}
	return threshold
}

// RunStalledNodeDrill seeds one historical running claim and invokes the real
// reaper through an exact tenant/run selection, never touching unrelated work.
func (e *Engine) RunStalledNodeDrill(ctx context.Context, input RecoveryDrillInput) (StalledNodeDrillResult, error) {
	if input.Workflow == nil {
		return StalledNodeDrillResult{}, errors.New("recovery drill workflow is required")
	}
	found := false
	for _, node := range input.Workflow.Nodes {
		if node.ID == input.FailedNodeID {
			found = true
			break
		}
	}
	if !found {
		return StalledNodeDrillResult{}, fmt.Errorf("recovery drill node %s not found in workflow", input.FailedNodeID)
	}

	threshold := configuredStallThreshold()
	initiatedAt := e.now().UTC()
	simulatedStall := threshold + stallDrillMargin
	stalledAt := initiatedAt.Add(-simulatedStall)
	runID := e.newID()
	drill := map[string]any{
		"kind": input.Source.Kind, "packId": input.Source.PackID,
		"fixtureId": input.Source.FixtureID, "failureMode": input.Source.FailureMode,
		"recoveryPath":       input.Source.RecoveryPath,
		"initiatedAt":        initiatedAt.Format(time.RFC3339Nano),
		"simulatedStartedAt": stalledAt.Format(time.RFC3339Nano),
		"thresholdMinutes":   int64(threshold / time.Minute),
	}

	tx, err := e.pool.Begin(ctx)
	if err != nil {
		return StalledNodeDrillResult{}, fmt.Errorf("begin stalled-node recovery drill: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := store.New(e.wrapTx(tx))
	if err := q.InsertRecoveryDrillRun(ctx, store.InsertRecoveryDrillRunParams{
		ID: runID, OrgID: input.OrgID, WorkflowVersionID: runID, Status: "running",
		InputJson:  drillInputJSON(input.Workflow, map[string]any{}, drill),
		WorkflowID: runWorkflowID(input.Workflow, runID),
		CreatedBy:  pgtype.Text{String: input.CreatedBy, Valid: input.CreatedBy != ""},
		CreatedAt:  &stalledAt,
	}); err != nil {
		return StalledNodeDrillResult{}, fmt.Errorf("insert stalled-node recovery drill: %w", err)
	}
	if err := q.InsertSeededRunNode(ctx, store.InsertSeededRunNodeParams{
		ID: e.newID(), RunID: runID, NodeID: input.FailedNodeID, Status: "running",
		Attempts: pgtype.Int4{Int32: 1, Valid: true}, StateJson: json.RawMessage(`{}`),
		StartedAt: &stalledAt,
	}); err != nil {
		return StalledNodeDrillResult{}, fmt.Errorf("insert stalled-node recovery drill node: %w", err)
	}
	startedPayload := safePersist(map[string]any{"workflowVersionId": runID, "drill": input.Source}, 0)
	if err := q.InsertRunEventAt(ctx, store.InsertRunEventAtParams{
		ID: e.newID(), RunID: runID, Type: "run.started",
		Payload: startedPayload, CreatedAt: &stalledAt,
	}); err != nil {
		return StalledNodeDrillResult{}, fmt.Errorf("insert stalled-node recovery drill event: %w", err)
	}
	if err := q.NotifyRunEvents(ctx, runID); err != nil {
		return StalledNodeDrillResult{}, fmt.Errorf("notify stalled-node recovery drill events: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return StalledNodeDrillResult{}, fmt.Errorf("commit stalled-node recovery drill: %w", err)
	}

	reaperStarted := time.Now()
	reaped, err := e.reapScopedStalledNodes(ctx, input.OrgID, runID, threshold, map[string]any{
		"reason": "worker_stalled", "drill": input.Source,
	}, slog.Default())
	if err != nil {
		return StalledNodeDrillResult{}, err
	}
	letter, letterErr := store.New(e.pool).FindLatestDeadLetterForNode(ctx, store.FindLatestDeadLetterForNodeParams{
		OrgID: input.OrgID, RunID: runID, NodeID: input.FailedNodeID,
	})
	deadLettered := 0
	if letterErr == nil {
		deadLettered = 1
	}
	if reaped.Scanned != 1 || reaped.Reaped != 1 || deadLettered != 1 {
		return StalledNodeDrillResult{}, fmt.Errorf(
			"stalled-node drill did not complete: scanned=%d reaped=%d deadLettered=%d",
			reaped.Scanned, reaped.Reaped, deadLettered,
		)
	}
	return StalledNodeDrillResult{
		RunID: runID, DeadLetterID: letter.ID,
		Evidence: StalledNodeDrillEvidence{
			RecoveryPath:     "stalled_node_reaper",
			ThresholdMinutes: int64(threshold / time.Minute),
			SimulatedStallMS: simulatedStall.Milliseconds(),
			ReaperRuntimeMS:  max(time.Since(reaperStarted).Milliseconds(), 0),
			Scanned:          reaped.Scanned, Reaped: reaped.Reaped, DeadLettered: deadLettered,
		},
	}, nil
}

// `subworkflow` node — calls another saved workflow as a step (reference
// packages/engine/src/subworkflow.ts + subworkflow-terminal-reconciler.ts).
//
// Async pause-and-resume with the ATOMIC start contract: the child's
// StartRun transaction ALSO commits the parent node's exact
// running→waiting checkpoint and both parent events, so the child's root
// nodes become claimable only together with the parent's pause — no
// window where the child runs against a parent that never checkpointed.
//
// Terminal handoff is durable: the child's terminal flip arms
// runs.parentNotificationAfter in the SAME update (see
// MarkRunTerminalFromRunning); the immediate notifier clears the marker
// only after the exact parent checkpoint plus downstream readiness (or
// run rollup) settles, and the leased once-per-minute reconciler retries
// any marker a crash left behind. A failed parent still SETTLES every
// exact waiting child (complete-without-reopen / fail-without-rollup), so
// a later replay cannot reopen a parent holding an unresolved wait.
//
// Invariants:
//   - Multi-tenant: the child resolves org-scoped through an ACTIVE
//     workflow parent (tombstones answer not-found).
//   - Recursion guard: org config `subworkflow.maxDepth` (env
//     JANUSLY_MAX_SUBWORKFLOW_DEPTH, default 5), walking only executable
//     parent links; replay lineage is a boundary; walker bounded at 100.
//   - Validation propagation: a validation parent spawns the child with
//     replayMode="validation" (write sides stay skipped); explicit pins
//     and validation runs never consume canary traffic.
package engine

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"os"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/go/internal/domain"
	"github.com/johnny4young/janusly/go/internal/executors"
	"github.com/johnny4young/janusly/go/internal/grammar"
	"github.com/johnny4young/janusly/go/internal/orgconfig"
	"github.com/johnny4young/janusly/go/internal/store"
)

const subworkflowDepthWalkerMax = 100

// maxSubworkflowDepth resolves the tenant ceiling (org config → env → 5).
func (e *Engine) maxSubworkflowDepth(ctx context.Context, orgID string) int {
	if configured := orgconfig.LoadNumber(ctx, e.pool, orgID, "subworkflow.maxDepth"); configured >= 1 {
		return int(configured)
	}
	if raw := os.Getenv("JANUSLY_MAX_SUBWORKFLOW_DEPTH"); raw != "" {
		if value, err := strconv.Atoi(raw); err == nil && value >= 1 {
			return value
		}
	}
	return 5
}

// computeSubworkflowDepth walks executable subworkflow parent links upward.
// Replay lineage deliberately terminates the walk so validation doesn't
// inherit the production source run's nesting budget.
func (e *Engine) computeSubworkflowDepth(ctx context.Context, runID string) (int, error) {
	q := store.New(e.pool)
	depth, current := 0, runID
	for current != "" {
		row, err := q.GetRunParentLink(ctx, current)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return depth, nil
			}
			return 0, fmt.Errorf("depth walk: %w", err)
		}
		executable := row.ParentLinkKind.String == "subworkflow" ||
			(!row.ParentLinkKind.Valid && !row.ReplayMode.Valid && row.ParentNodeID.Valid)
		if !row.ParentRunID.Valid || !executable {
			return depth, nil
		}
		depth++
		current = row.ParentRunID.String
		if depth > subworkflowDepthWalkerMax {
			return 0, fmt.Errorf("Subworkflow depth walker bounded at %d (cycle?)", subworkflowDepthWalkerMax) //nolint:staticcheck // reference message is the wire contract
		}
	}
	return depth, nil
}

// executeSubworkflowNode is the dispatcher's subworkflow branch: depth
// guard, org-scoped child load (pin / rollout / latest), forwarded-input
// precedence, and the ATOMIC child start + parent checkpoint. Returns the
// Waiting sentinel purely for the worker's control flow — the checkpoint
// is already durable, so the worker's MarkNodeWaiting no-ops on the CAS.
func (e *Engine) executeSubworkflowNode(
	ctx context.Context, claim ClaimedNode, config map[string]any,
	runInput map[string]any, replayMode string, redactedValues []string,
) (any, error) {
	rawWorkflowID, _ := config["workflowId"].(string)
	workflowID := ""
	if rawWorkflowID != "" {
		workflowID = rawWorkflowID
	}
	if workflowID == "" {
		return nil, fmt.Errorf("subworkflow.config.workflowId is required")
	}
	var pinnedVersion *int
	if raw, present := config["version"]; present {
		value, ok := raw.(float64)
		if !ok || value != math.Trunc(value) || value < 1 {
			return nil, fmt.Errorf("subworkflow.config.version must be a positive integer")
		}
		pinned := int(value)
		pinnedVersion = &pinned
	}

	// 1. Recursion guard — fail fast before spawning anything.
	depth, err := e.computeSubworkflowDepth(ctx, claim.RunID)
	if err != nil {
		return nil, err
	}
	if max := e.maxSubworkflowDepth(ctx, claim.OrgID); depth >= max {
		return nil, fmt.Errorf("Subworkflow depth limit reached (%d >= %d)", depth, max) //nolint:staticcheck // reference message is the wire contract
	}

	// 2. Load the child (org-scoped, active parent only). An unpinned
	// production call participates in the child's deployment; pins and
	// validation runs stay exact.
	q := store.New(e.pool)
	dryRun := replayMode == "validation"
	var childWorkflow *domain.Workflow
	childVersionID, childVersion := "", 0
	rolloutID, rolloutVariant := "", ""
	if pinnedVersion == nil && !dryRun {
		if assignment, err := e.ResolveWorkflowRolloutAssignment(ctx, claim.OrgID, workflowID,
			claim.RunID+":"+claim.NodeID); err == nil && assignment != nil {
			childWorkflow = assignment.Workflow
			childVersionID = assignment.VersionID
			rolloutID, rolloutVariant = assignment.Rollout.ID, assignment.Variant
		}
	}
	if childWorkflow == nil {
		if pinnedVersion != nil {
			row, err := q.GetWorkflowVersionByNumber(ctx, store.GetWorkflowVersionByNumberParams{
				WorkflowID: workflowID, OrgID: claim.OrgID, Version: int32(*pinnedVersion),
			})
			if err != nil {
				return nil, fmt.Errorf("Subworkflow not found: %s version %d (org: %s)", workflowID, *pinnedVersion, claim.OrgID) //nolint:staticcheck // reference message is the wire contract
			}
			childWorkflow, _ = domain.Parse(row.DagJson)
			childVersionID, childVersion = row.ID, int(row.Version)
		} else {
			ownerState, err := q.GetWorkflowIngestState(ctx, workflowID)
			if err != nil || ownerState.OrgID != claim.OrgID || ownerState.DeletedAt != nil {
				return nil, fmt.Errorf("Subworkflow not found: %s (org: %s)", workflowID, claim.OrgID) //nolint:staticcheck // reference message is the wire contract
			}
			row, err := q.GetLatestWorkflowVersion(ctx, store.GetLatestWorkflowVersionParams{
				WorkflowID: workflowID, OrgID: claim.OrgID,
			})
			if err != nil {
				return nil, fmt.Errorf("Subworkflow not found: %s (org: %s)", workflowID, claim.OrgID) //nolint:staticcheck // reference message is the wire contract
			}
			childWorkflow, _ = domain.Parse(row.DagJson)
			childVersionID, childVersion = row.ID, int(row.Version)
		}
	}
	if childWorkflow == nil {
		return nil, fmt.Errorf("Subworkflow snapshot failed validation: %s", workflowID) //nolint:staticcheck // reference message is the wire contract
	}

	// 3. Forwarded input: config.input (present, including null) wins;
	// otherwise the parent's own run input; secrets always redacted.
	var forwarded any
	if configInput, present := config["input"]; present {
		if configInput == nil {
			forwarded = map[string]any{}
		} else {
			forwarded = configInput
		}
	} else if parentInput, ok := runInput["input"]; ok && parentInput != nil {
		forwarded = parentInput
	} else {
		forwarded = map[string]any{}
	}
	forwarded = grammar.RedactValues(forwarded, redactedValues)

	childReplay := ""
	if dryRun {
		childReplay = "validation"
	}
	// The child inherits the parent's correlation id so the whole chain
	// remains copyable as one trace (best-effort: a blip means a fresh id).
	parentTrace, _ := store.New(e.pool).GetRunTraceID(ctx, claim.RunID)
	start := StartInput{
		OrgID: claim.OrgID, Workflow: childWorkflow, WorkflowVersionID: childVersionID,
		Input: forwarded, ReplayMode: childReplay, TraceID: parentTrace.String,
		ParentRunID: claim.RunID, ParentNodeID: claim.NodeID, ParentLinkKind: "subworkflow",
		WorkflowRolloutID: rolloutID, WorkflowRolloutVariant: rolloutVariant,
		ParentCheckpoint: &ParentCheckpoint{
			RunID: claim.RunID, NodeID: claim.NodeID,
			ChildWorkflowID: workflowID, ChildWorkflowVersion: childVersion,
			ChildWorkflowVersionID: childVersionID, Depth: depth + 1,
		},
	}
	childRunID, err := e.StartRun(ctx, start)
	if err != nil {
		return nil, err
	}
	// The checkpoint is durable; this sentinel only steers the worker (its
	// MarkNodeWaiting CAS no-ops against the already-waiting row).
	return executors.Waiting{
		Reason: "Waiting for subworkflow",
		Metadata: map[string]any{
			"kind": "subworkflow", "childRunId": childRunID,
			"childWorkflowId": workflowID, "childWorkflowVersion": childVersion,
		},
	}, nil
}

// ParentCheckpoint carries the parent's pause identity into the child's
// start transaction.
type ParentCheckpoint struct {
	RunID, NodeID          string
	ChildWorkflowID        string
	ChildWorkflowVersion   int
	ChildWorkflowVersionID string
	Depth                  int
}

// ErrParentCheckpointConflict: the parent node was no longer `running`
// when the child start tried to checkpoint it (a raced cancel/timeout).
var ErrParentCheckpointConflict = errors.New("subworkflow parent checkpoint conflict")

// commitParentCheckpoint runs INSIDE the child's start transaction: CAS
// the parent node running→waiting and append both parent events.
func (e *Engine) commitParentCheckpoint(
	ctx context.Context, q *store.Queries, checkpoint *ParentCheckpoint, childRunID string,
) error {
	checkpointAt := eventNow()
	metadata := map[string]any{
		"kind": "subworkflow", "reason": "Waiting for subworkflow",
		"childRunId": childRunID, "childWorkflowId": checkpoint.ChildWorkflowID,
		"childWorkflowVersion":   checkpoint.ChildWorkflowVersion,
		"childWorkflowVersionId": checkpoint.ChildWorkflowVersionID,
		"waitingSince":           checkpointAt.Format("2006-01-02T15:04:05.000Z"),
	}
	marked, err := q.MarkRunNodeWaiting(ctx, store.MarkRunNodeWaitingParams{
		RunID: checkpoint.RunID, NodeID: checkpoint.NodeID,
		StateJson: safePersist(map[string]any{"waiting": metadata}, stateJSONMaxBytes),
	})
	if err != nil {
		return fmt.Errorf("parent checkpoint: %w", err)
	}
	if marked == 0 {
		return ErrParentCheckpointConflict
	}
	startedPayload := safePersist(map[string]any{
		"childRunId": childRunID, "childWorkflowId": checkpoint.ChildWorkflowID,
		"childWorkflowVersion": checkpoint.ChildWorkflowVersion,
		"depth":                checkpoint.Depth,
	}, defaultPersistMaxBytes())
	if err := q.InsertRunEventAt(ctx, store.InsertRunEventAtParams{
		ID: e.newID(), RunID: checkpoint.RunID,
		NodeID: pgtype.Text{String: checkpoint.NodeID, Valid: true},
		Type:   "subworkflow.started", Payload: startedPayload, CreatedAt: &checkpointAt,
	}); err != nil {
		return fmt.Errorf("insert subworkflow.started: %w", err)
	}
	waitingPayload := safePersist(map[string]any{
		"status": "waiting", "reason": "Waiting for subworkflow", "metadata": metadata,
	}, defaultPersistMaxBytes())
	waitingAt := checkpointAt.Add(time.Millisecond)
	if err := q.InsertRunEventAt(ctx, store.InsertRunEventAtParams{
		ID: e.newID(), RunID: checkpoint.RunID,
		NodeID: pgtype.Text{String: checkpoint.NodeID, Valid: true},
		Type:   "node.waiting", Payload: waitingPayload, CreatedAt: &waitingAt,
	}); err != nil {
		return fmt.Errorf("insert node.waiting: %w", err)
	}
	return q.NotifyRunEvents(ctx, checkpoint.RunID)
}

/* ------------------------- terminal handoff ---------------------------- */

// DeliverParentNotifications walks the parent chain from a terminal child,
// settling each armed marker: notify → clear on settle → continue with the
// parent (whose own flip may have armed ITS marker — the trampoline that
// collapses a deep failure chain). Best-effort: anything unsettled stays
// armed for the reconciler.
func (e *Engine) DeliverParentNotifications(ctx context.Context, runID string) {
	q := store.New(e.pool)
	current := runID
	for hop := 0; hop < subworkflowDepthWalkerMax; hop++ {
		row, err := q.GetRunParentLink(ctx, current)
		if err != nil || row.ParentNotificationAfter == nil || !isTerminalRunStatus(row.Status) {
			return
		}
		settled, parentRunID := e.notifyParentOnTerminal(ctx, current, row.Status)
		if !settled {
			return
		}
		_ = q.ClearParentNotification(ctx, store.ClearParentNotificationParams{
			ID: current, Status: row.Status,
		})
		if parentRunID == "" {
			return
		}
		current = parentRunID
	}
}

func isTerminalRunStatus(status string) bool {
	return status == "succeeded" || status == "failed" || status == "cancelled" || status == "timed_out"
}

// notifyParentOnTerminal resumes the parent's subworkflow node for one
// terminal child. Returns (settled, parentRunID-to-continue-with).
func (e *Engine) notifyParentOnTerminal(ctx context.Context, childRunID, childStatus string) (bool, string) {
	q := store.New(e.pool)
	child, err := q.GetRunParentLink(ctx, childRunID)
	if err != nil {
		return false, ""
	}
	executable := child.ParentLinkKind.String == "subworkflow" ||
		(!child.ParentLinkKind.Valid && !child.ReplayMode.Valid)
	if !child.ParentRunID.Valid || !child.ParentNodeID.Valid || !executable {
		return true, "" // Top-level or trace-only lineage: nothing owed.
	}
	if child.Status != childStatus {
		return false, "" // A replay superseded this leased terminal generation.
	}
	parentRunID, parentNodeID := child.ParentRunID.String, child.ParentNodeID.String
	parent, err := q.GetRunParentLink(ctx, parentRunID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return true, "" // Parent gone (orphan-tolerant).
		}
		return false, ""
	}

	if childStatus == "succeeded" {
		return e.settleParentOnChildSuccess(ctx, child, parent, parentRunID, parentNodeID, childRunID), parentRunID
	}
	return e.settleParentOnChildFailure(ctx, parent, parentRunID, parentNodeID, childRunID, childStatus), parentRunID
}

func (e *Engine) settleParentOnChildSuccess(
	ctx context.Context, child store.GetRunParentLinkRow, parent store.GetRunParentLinkRow,
	parentRunID, parentNodeID, childRunID string,
) bool {
	childOutput := map[string]any{}
	if len(child.OutputJson) > 0 {
		_ = json.Unmarshal(child.OutputJson, &childOutput)
	}
	finishedAt := eventNow()
	state := safePersist(map[string]any{
		"output":      childOutput,
		"subworkflow": map[string]any{"childRunId": childRunID},
	}, stateJSONMaxBytes)
	settled := false
	err := e.inCompletionTx(ctx, parentRunID, func(q *store.Queries, events *runEventBuffer) error {
		completed, err := q.MarkWaitingSubworkflowSucceeded(ctx, store.MarkWaitingSubworkflowSucceededParams{
			RunID: parentRunID, NodeID: parentNodeID,
			StateJson: state, FinishedAt: &finishedAt, ChildRunID: childRunID,
		})
		if err != nil {
			return fmt.Errorf("complete parent node: %w", err)
		}
		if completed == 0 {
			return errSkipCommit
		}
		payload := safePersist(map[string]any{"childRunId": childRunID}, defaultPersistMaxBytes())
		events.add(e.newID(), parentRunID, parentNodeID, "subworkflow.completed", payload, finishedAt)
		settled = true
		// A failed parent SETTLES the wait without reopening: no downstream
		// scheduling — a replay may later reopen the parent explicitly.
		if parent.Status == "running" {
			return e.scheduleDownstream(ctx, q, events, parentRunID, finishedAt)
		}
		return nil
	})
	if err != nil {
		return false
	}
	if settled {
		return true
	}
	// CAS missed: crash recheck — an already-succeeded exact checkpoint is
	// replayable readiness work, not a conflict.
	q := store.New(e.pool)
	node, err := q.GetRunNodeSnapshot(ctx, store.GetRunNodeSnapshotParams{RunID: parentRunID, NodeID: parentNodeID})
	if err != nil {
		return false
	}
	var nodeState struct {
		Subworkflow struct {
			ChildRunID string `json:"childRunId"`
		} `json:"subworkflow"`
	}
	_ = json.Unmarshal(node.StateJson, &nodeState)
	if node.Status == "succeeded" && nodeState.Subworkflow.ChildRunID == childRunID {
		latest, err := q.GetRunParentLink(ctx, parentRunID)
		if err == nil && latest.Status == "running" {
			_ = e.inCompletionTx(ctx, parentRunID, func(txq *store.Queries, events *runEventBuffer) error {
				return e.scheduleDownstream(ctx, txq, events, parentRunID, eventNow())
			})
		}
		return true
	}
	latest, err := q.GetRunParentLink(ctx, parentRunID)
	return err == nil && isTerminalRunStatus(latest.Status)
}

func (e *Engine) settleParentOnChildFailure(
	ctx context.Context, parent store.GetRunParentLinkRow,
	parentRunID, parentNodeID, childRunID, childStatus string,
) bool {
	q := store.New(e.pool)
	serr := map[string]any{
		"message":     fmt.Sprintf("Subworkflow %s", childStatus),
		"name":        "SubworkflowFailedError",
		"code":        "SUBWORKFLOW_" + map[string]string{"failed": "FAILED", "cancelled": "CANCELLED", "timed_out": "TIMED_OUT"}[childStatus],
		"childRunId":  childRunID,
		"childStatus": childStatus,
	}
	if childStatus == "failed" {
		if first, err := q.GetFirstFailedRunNode(ctx, childRunID); err == nil {
			var firstError any
			_ = json.Unmarshal(first.ErrorJson, &firstError)
			serr["firstChildFailure"] = map[string]any{"nodeId": first.NodeID, "error": firstError}
		}
	}
	failedAt := eventNow()
	settled := false
	err := e.inCompletionTx(ctx, parentRunID, func(txq *store.Queries, events *runEventBuffer) error {
		failed, err := txq.MarkWaitingSubworkflowFailed(ctx, store.MarkWaitingSubworkflowFailedParams{
			RunID: parentRunID, NodeID: parentNodeID,
			ErrorJson: safePersist(serr, deadLetterErrorMaxBytes), FinishedAt: &failedAt,
			ChildRunID: childRunID,
		})
		if err != nil {
			return fmt.Errorf("fail parent node: %w", err)
		}
		if failed == 0 {
			return errSkipCommit
		}
		payload := safePersist(map[string]any{"error": serr}, defaultPersistMaxBytes())
		events.add(e.newID(), parentRunID, parentNodeID, "node.failed", payload, failedAt)
		settled = true
		// A sibling may have flipped the parent already — the node settle
		// above is all this generation owes then.
		if parent.Status == "running" {
			return e.flipRunTerminal(ctx, txq, events, parentRunID, "failed",
				map[string]any{"reason": "subworkflow_failed", "childRunId": childRunID}, failedAt, nil)
		}
		return nil
	})
	if err != nil {
		return false
	}
	if settled {
		return true
	}
	// CAS missed: the failure may have committed before a crash stopped the
	// rollup — an exact already-failed checkpoint re-runs the idempotent
	// flip; any terminal parent is settled.
	node, err := q.GetRunNodeSnapshot(ctx, store.GetRunNodeSnapshotParams{RunID: parentRunID, NodeID: parentNodeID})
	if err != nil {
		return false
	}
	var nodeError struct {
		ChildRunID string `json:"childRunId"`
	}
	_ = json.Unmarshal(node.ErrorJson, &nodeError)
	if node.Status == "failed" && nodeError.ChildRunID == childRunID {
		latest, err := q.GetRunParentLink(ctx, parentRunID)
		if err == nil && latest.Status == "running" {
			_ = e.inCompletionTx(ctx, parentRunID, func(txq *store.Queries, events *runEventBuffer) error {
				return e.flipRunTerminal(ctx, txq, events, parentRunID, "failed",
					map[string]any{"reason": "subworkflow_failed", "childRunId": childRunID}, eventNow(), nil)
			})
		}
		return true
	}
	latest, err := q.GetRunParentLink(ctx, parentRunID)
	return err == nil && isTerminalRunStatus(latest.Status)
}

/* ---------------------------- reconciler ------------------------------- */

const (
	subworkflowReconcilerLimit = 500
	subworkflowReconcilerLease = 60 * time.Second
)

// ReconcileSubworkflowTerminals leases due markers and retries the parent
// handoff with per-child fault isolation.
func (e *Engine) ReconcileSubworkflowTerminals(ctx context.Context) (scanned, repaired int) {
	now := time.Now().UTC()
	lease := now.Add(subworkflowReconcilerLease)
	due, err := store.New(e.pool).ClaimDueParentNotifications(ctx, store.ClaimDueParentNotificationsParams{
		Now: &now, LeaseUntil: &lease, RowLimit: subworkflowReconcilerLimit,
	})
	if err != nil {
		return 0, 0
	}
	for _, row := range due {
		settled, _ := e.notifyParentOnTerminal(ctx, row.ID, row.Status)
		if settled {
			_ = store.New(e.pool).ClearParentNotification(ctx, store.ClearParentNotificationParams(row))
			repaired++
			// The parent's own flip may have armed ITS marker — chase it now
			// rather than waiting a lease.
			e.DeliverParentNotifications(ctx, row.ID)
		}
	}
	return len(due), repaired
}

// RunSubworkflowTerminalReconciler loops the repair sweep until the
// context ends (wired from the API binary next to the other sweeps).
func (e *Engine) RunSubworkflowTerminalReconciler(ctx context.Context, every time.Duration, logger *slog.Logger) {
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		scanned, repaired := e.ReconcileSubworkflowTerminals(ctx)
		if scanned > 0 {
			logger.Info("subworkflow terminal reconciler sweep",
				"scanned", scanned, "repaired", repaired)
		}
	}
}

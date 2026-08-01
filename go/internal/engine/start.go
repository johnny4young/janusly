// Package engine implements the durable execution core. Its founding
// invariant, inherited from the reference backend: starting a run persists
// the run row, every node row and the run.started event in ONE transaction,
// so a partially-started run can never escape to a worker.
package engine

import (
	"context"
	"encoding/json"
	"fmt"
	"math/rand/v2"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/johnny4young/janusly/go/internal/domain"
	"github.com/johnny4young/janusly/go/internal/store"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"

	"github.com/johnny4young/janusly/go/internal/observability"
)

// Engine owns run lifecycle operations over the shared schema.
type Engine struct {
	pool  *pgxpool.Pool
	newID func() string
	// wrapTx lets tests interpose on the transaction's statements to prove
	// atomicity; production keeps the identity wrapper.
	wrapTx func(store.DBTX) store.DBTX
	// now and randFloat are seams for deterministic retry-scheduling tests.
	now       func() time.Time
	randFloat func() float64
}

// New builds an Engine over the given pool.
func New(pool *pgxpool.Pool) *Engine {
	return &Engine{
		pool:      pool,
		newID:     uuid.NewString,
		wrapTx:    func(tx store.DBTX) store.DBTX { return tx },
		now:       time.Now,
		randFloat: rand.Float64,
	}
}

// InputValidationError reports a run-start payload that does not satisfy the
// workflow's declared inputs. The errors list is wire contract: the API
// returns it verbatim, matching the reference's 400 body.
type InputValidationError struct {
	Errors []string
}

func (e *InputValidationError) Error() string {
	return "Workflow input validation failed: " + strings.Join(e.Errors, "; ")
}

// StartInput carries everything one run start needs.
type StartInput struct {
	OrgID string
	// Workflow is the validated document to execute.
	Workflow *domain.Workflow
	// WorkflowVersionID pins the version identity; empty falls back to the
	// workflow id and then to the generated run id, like the reference.
	WorkflowVersionID string
	// Input is the caller's payload; nil means none was supplied.
	Input     any
	CreatedBy string
	// ReplayMode marks a validation replay ("validation"): write-side
	// skips apply and the ai node never dials the SDK. Empty = production.
	ReplayMode string
	// TriggerEventID, when set, CAS-claims that trigger_events row inside
	// the start transaction: "event claimed" and "run exists" commit or
	// roll back together, so a concurrent relay retry can never spawn a
	// second run for the same inbound event.
	TriggerEventID string
	// IdempotencyKey, when set, claims (org, key) inside the start
	// transaction; a duplicate aborts the new run and the caller returns
	// the original via ErrStartIdempotencyReplay.
	IdempotencyKey string
	// Parent lineage: ParentLinkKind "replay" marks TRACE-ONLY lineage (a
	// continuation/validation run points at the run it replays); depth and
	// terminal delivery follow only executable ("subworkflow") edges.
	ParentRunID    string
	ParentNodeID   string
	ParentLinkKind string
	// ParentCheckpoint, when set, commits the parent subworkflow node's
	// exact running→waiting checkpoint plus both parent events INSIDE this
	// start transaction — the child's roots become claimable only together
	// with the parent's pause.
	ParentCheckpoint *ParentCheckpoint
	// Rollout assignment captured AT START — the durable deployment choice
	// (variant + rollout id) rides the run row and the run.started event so
	// outcome receipts and audits read the frozen assignment, never a
	// mutable rollout row.
	WorkflowRolloutID      string
	WorkflowRolloutVariant string
	// TraceID, when set, carries the parent chain's correlation id
	// (subworkflow starts). Empty = a fresh id is stamped, so every root
	// run gets one up front — the reference start-run posture.
	TraceID string
}

// ErrStartIdempotencyReplay reports a duplicate Idempotency-Key: the
// original run id rides the error for the caller to return verbatim.
type ErrStartIdempotencyReplay struct{ RunID string }

func (e *ErrStartIdempotencyReplay) Error() string {
	return "idempotency key already used by run " + e.RunID
}

// TriggerEventStartConflictError reports a trigger-event start claim that
// lost the CAS: another start already consumed the event. Callers treat it
// as a duplicate delivery, not a failure.
type TriggerEventStartConflictError struct{}

func (e *TriggerEventStartConflictError) Error() string {
	return "trigger event was already claimed by another run start"
}

// StartRun resolves declared defaults, validates the payload, and commits
// the whole run skeleton atomically: run row, node rows (roots queued with
// their first attempt, the rest pending) and the run.started event. The
// worker wake-up NOTIFY rides the same transaction, so it fires only if the
// commit does.
func (e *Engine) StartRun(ctx context.Context, in StartInput) (string, error) {
	input := in.Input
	if input == nil {
		input = map[string]any{}
	}
	if in.Workflow.Inputs != nil {
		input = domain.ApplyInputDefaults(in.Workflow.Inputs, input)
		if errs := domain.ValidateInputValue(in.Workflow.Inputs, input, "$"); len(errs) > 0 {
			return "", &InputValidationError{Errors: errs}
		}
	}

	runID := e.newID()
	versionID := in.WorkflowVersionID
	if versionID == "" {
		versionID = in.Workflow.ID
	}
	if versionID == "" {
		versionID = runID
	}

	// The persisted input records the configuration the run actually used:
	// the snapshot plus the RESOLVED payload, so later readers see effective
	// values even after the workflow's defaults change. The snapshot is the
	// reference's workflow ENTITY shape — the doc enriched with orgId /
	// createdBy / metadata / input — pinned by the dual-run comparator.
	workflowSnapshot := map[string]any{}
	if raw, err := json.Marshal(in.Workflow); err == nil {
		_ = json.Unmarshal(raw, &workflowSnapshot)
	}
	orgIDForSnapshot := in.OrgID
	if orgIDForSnapshot == "" {
		orgIDForSnapshot = "default"
	}
	workflowSnapshot["orgId"] = orgIDForSnapshot
	if in.CreatedBy != "" {
		workflowSnapshot["createdBy"] = in.CreatedBy
	} else {
		workflowSnapshot["createdBy"] = nil
	}
	workflowSnapshot["input"] = input
	if _, present := workflowSnapshot["metadata"]; !present {
		workflowSnapshot["metadata"] = map[string]any{"tags": []any{}}
	}
	inputJSON, err := json.Marshal(map[string]any{
		"workflow": workflowSnapshot,
		"input":    input,
	})
	if err != nil {
		return "", fmt.Errorf("marshal run input: %w", err)
	}

	roots := map[string]bool{}
	for _, node := range in.Workflow.Nodes {
		roots[node.ID] = true
	}
	for _, edge := range in.Workflow.Edges {
		delete(roots, edge.To)
	}

	// Root span per run (T-504): a no-op without a registered provider.
	ctx, startSpan := observability.Tracer().Start(ctx, "run.start",
		trace.WithAttributes(
			attribute.String("janusly.run_id", runID),
			attribute.String("janusly.org_id", in.OrgID),
			attribute.String("janusly.workflow_version_id", versionID),
		))
	defer startSpan.End()

	tx, err := e.pool.Begin(ctx)
	if err != nil {
		return "", fmt.Errorf("begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := store.New(e.wrapTx(tx))

	traceID := in.TraceID
	if traceID == "" {
		traceID = uuid.NewString()
	}
	if err := q.InsertRun(ctx, store.InsertRunParams{
		ID: runID, OrgID: in.OrgID, WorkflowVersionID: versionID,
		Status: "running", InputJson: inputJSON,
		CreatedBy:  pgtype.Text{String: in.CreatedBy, Valid: in.CreatedBy != ""},
		ReplayMode: pgtype.Text{String: in.ReplayMode, Valid: in.ReplayMode != ""},
		// A validation replay carries its evidence level from birth: the
		// sandbox produced STATIC evidence (write sides skipped), and the
		// contract ladder reads this to decide what the run may prove.
		ValidationEvidenceLevel: pgtype.Text{String: "static", Valid: in.ReplayMode == "validation"},
		ParentRunID:             pgtype.Text{String: in.ParentRunID, Valid: in.ParentRunID != ""},
		ParentNodeID:            pgtype.Text{String: in.ParentNodeID, Valid: in.ParentNodeID != ""},
		ParentLinkKind:          pgtype.Text{String: in.ParentLinkKind, Valid: in.ParentLinkKind != ""},
		WorkflowRolloutID:       pgtype.Text{String: in.WorkflowRolloutID, Valid: in.WorkflowRolloutID != ""},
		WorkflowRolloutVariant:  pgtype.Text{String: in.WorkflowRolloutVariant, Valid: in.WorkflowRolloutVariant != ""},
		TraceID:                 pgtype.Text{String: traceID, Valid: true},
	}); err != nil {
		return "", fmt.Errorf("insert run: %w", err)
	}

	if in.IdempotencyKey != "" {
		claimed, err := q.ClaimStartIdempotencyKey(ctx, store.ClaimStartIdempotencyKeyParams{
			OrgID: in.OrgID, IdempotencyKey: in.IdempotencyKey, RunID: runID,
		})
		if err != nil {
			return "", fmt.Errorf("claim idempotency key: %w", err)
		}
		if claimed == 0 {
			original, err := store.New(e.pool).GetStartIdempotencyRun(ctx, store.GetStartIdempotencyRunParams{
				OrgID: in.OrgID, IdempotencyKey: in.IdempotencyKey,
			})
			if err != nil {
				return "", fmt.Errorf("read idempotent run: %w", err)
			}
			return "", &ErrStartIdempotencyReplay{RunID: original}
		}
	}

	if in.TriggerEventID != "" {
		claimed, err := q.ClaimTriggerEventStart(ctx, store.ClaimTriggerEventStartParams{
			OrgID: in.OrgID, ID: in.TriggerEventID,
			RunID: pgtype.Text{String: runID, Valid: true},
		})
		if err != nil {
			return "", fmt.Errorf("claim trigger event: %w", err)
		}
		if claimed == 0 {
			return "", &TriggerEventStartConflictError{}
		}
	}

	for _, node := range in.Workflow.Nodes {
		status, attempts := "pending", int32(0)
		if roots[node.ID] {
			status, attempts = "queued", 1
		}
		if err := q.InsertRunNode(ctx, store.InsertRunNodeParams{
			ID: e.newID(), RunID: runID, NodeID: node.ID,
			Status: status, Attempts: pgtype.Int4{Int32: attempts, Valid: true},
			StateJson: json.RawMessage(`{}`),
		}); err != nil {
			return "", fmt.Errorf("insert node %s: %w", node.ID, err)
		}
	}

	startedFields := map[string]string{"workflowVersionId": versionID}
	if in.WorkflowRolloutID != "" {
		startedFields["workflowRolloutId"] = in.WorkflowRolloutID
		startedFields["workflowRolloutVariant"] = in.WorkflowRolloutVariant
	}
	startedPayload, _ := json.Marshal(startedFields)
	startedAt := eventNow()
	if err := q.InsertRunEventAt(ctx, store.InsertRunEventAtParams{
		ID: e.newID(), RunID: runID, Type: "run.started", Payload: startedPayload,
		CreatedAt: &startedAt,
	}); err != nil {
		return "", fmt.Errorf("insert run.started: %w", err)
	}
	// The reference's initial publication appends node.queued per root
	// (T-505 event-granularity parity). Millisecond offsets keep the
	// (created_at, id) keyset from ever ordering a queued event before
	// run.started or shuffling roots between reads.
	rootIndex := 0
	for _, node := range in.Workflow.Nodes {
		if !roots[node.ID] {
			continue
		}
		rootIndex++
		queuedAt := startedAt.Add(time.Duration(rootIndex) * time.Millisecond)
		if err := q.InsertRunEventAt(ctx, store.InsertRunEventAtParams{
			ID: e.newID(), RunID: runID,
			NodeID: pgtype.Text{String: node.ID, Valid: true},
			Type:   "node.queued", Payload: json.RawMessage(`{}`),
			CreatedAt: &queuedAt,
		}); err != nil {
			return "", fmt.Errorf("insert node.queued: %w", err)
		}
	}

	if in.ParentCheckpoint != nil {
		if err := e.commitParentCheckpoint(ctx, q, in.ParentCheckpoint, runID); err != nil {
			return "", err
		}
	}

	if err := q.NotifyWake(ctx, runID); err != nil {
		return "", fmt.Errorf("notify wake: %w", err)
	}
	if err := q.NotifyRunEvents(ctx, runID); err != nil {
		return "", fmt.Errorf("notify run events: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return "", fmt.Errorf("commit: %w", err)
	}
	return runID, nil
}

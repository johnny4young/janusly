// Dispatcher — the per-node execution pipeline the worker pool plugs in:
// build the run context, render the node config with secret/env tracking,
// record unresolved-path evidence (failing under a strict template policy),
// dispatch to the executor for the node type, and scrub every resolved
// secret/env value from outputs and errors before they reach persistence.
package engine

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/go/internal/domain"
	"github.com/johnny4young/janusly/go/internal/executors"
	"github.com/johnny4young/janusly/go/internal/grammar"
	"github.com/johnny4young/janusly/go/internal/store"
)

// Dispatcher resolves and executes one claimed node at a time.
type Dispatcher struct {
	engine     *Engine
	registry   map[string]executors.Func
	renderOpts grammar.RenderOptions
}

// NewDispatcher wires the executor registry over this engine. Env access
// defaults to the process environment; secrets default to none (every
// {{secret.X}} is a hard failure) until a secret source is configured.
func (e *Engine) NewDispatcher(opts grammar.RenderOptions) *Dispatcher {
	if opts.LookupEnv == nil {
		opts.LookupEnv = os.LookupEnv
	}
	return &Dispatcher{engine: e, registry: executors.Registry(), renderOpts: opts}
}

// Execute implements ExecuteFunc: the output it returns is what the engine
// commits under state_json.output.
func (d *Dispatcher) Execute(ctx context.Context, claim ClaimedNode, node domain.Node, wf *domain.Workflow, runInput map[string]any) (any, error) {
	q := store.New(d.engine.pool)
	rows, err := q.ListRunNodesByRun(ctx, claim.RunID)
	if err != nil {
		return nil, fmt.Errorf("load run context: %w", err)
	}
	runContext := runContextFromRows(rows)
	// The run's start/trigger input rides as context.input — unless a legacy
	// workflow claims a node literally named "input" (new saves reserve it).
	if _, taken := runContext["input"]; !taken {
		if runInput == nil {
			runInput = map[string]any{}
		}
		runContext["input"] = runInput
	}

	config := node.Config
	if config == nil {
		config = map[string]any{}
	}
	rendered, err := grammar.RenderTemplateWithRedactions(config, map[string]any{
		"context": runContext,
		"inputs":  config,
	}, d.renderOpts)
	if err != nil {
		// A missing secret is already name-only — safe to surface verbatim.
		return nil, err
	}

	if len(rendered.UnresolvedPaths) > 0 {
		if err := d.recordUnresolvedPaths(ctx, q, claim, wf, rendered.UnresolvedPaths); err != nil {
			return nil, err
		}
	}

	execute, ok := d.registry[node.Type]
	if !ok {
		return nil, fmt.Errorf("No executor for node type: %s", node.Type) //nolint:staticcheck // reference message is the wire contract
	}
	renderedConfig, _ := rendered.Rendered.(map[string]any)
	if renderedConfig == nil {
		renderedConfig = map[string]any{}
	}
	output, execErr := execute(ctx, executors.Input{Config: renderedConfig, Context: runContext})
	if execErr != nil {
		return nil, errors.New(grammar.RedactString(execErr.Error(), rendered.RedactedValues))
	}
	return grammar.RedactValues(output, rendered.RedactedValues), nil
}

// recordUnresolvedPaths appends the bounded, deduplicated evidence event and
// fails the node when the workflow pinned templatePolicy: "strict" — the
// same evidence either way, so lenient runs stay diagnosable.
func (d *Dispatcher) recordUnresolvedPaths(ctx context.Context, q *store.Queries, claim ClaimedNode, wf *domain.Workflow, paths []string) error {
	policy := wf.TemplatePolicy
	if policy == "" {
		policy = "lenient"
	}
	recorded := paths
	if len(recorded) > grammar.MaxRecordedUnresolvedPaths {
		recorded = recorded[:grammar.MaxRecordedUnresolvedPaths]
	}
	payload, err := json.Marshal(map[string]any{
		"count": len(paths), "paths": recorded,
		"truncated": len(paths) > len(recorded), "policy": policy,
	})
	if err != nil {
		return fmt.Errorf("marshal unresolved-path payload: %w", err)
	}
	eventAt := time.Now().UTC()
	if err := q.InsertRunEventAt(ctx, store.InsertRunEventAtParams{
		ID: d.engine.newID(), RunID: claim.RunID,
		NodeID: pgtype.Text{String: claim.NodeID, Valid: true},
		Type:   "template.unresolved_path", Payload: payload, CreatedAt: &eventAt,
	}); err != nil {
		return fmt.Errorf("insert template.unresolved_path: %w", err)
	}
	if policy == "strict" {
		return grammar.NewUnresolvedTemplatePathError(paths)
	}
	return nil
}

// runContextFromRows projects node rows into the template/expression
// context: {status, attempts, state, output, error} per node id, with
// output falling back to {} when the node hasn't produced one.
func runContextFromRows(rows []store.ListRunNodesByRunRow) map[string]any {
	runContext := make(map[string]any, len(rows))
	for _, row := range rows {
		var state map[string]any
		if len(row.StateJson) > 0 {
			_ = json.Unmarshal(row.StateJson, &state)
		}
		if state == nil {
			state = map[string]any{}
		}
		output, ok := state["output"]
		if !ok || output == nil {
			output = map[string]any{}
		}
		var errValue any
		if len(row.ErrorJson) > 0 {
			_ = json.Unmarshal(row.ErrorJson, &errValue)
		}
		attempts := float64(0)
		if row.Attempts.Valid {
			attempts = float64(row.Attempts.Int32)
		}
		runContext[row.NodeID] = map[string]any{
			"status":   row.Status,
			"attempts": attempts,
			"state":    state,
			"output":   output,
			"error":    errValue,
		}
	}
	return runContext
}

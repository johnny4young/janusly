// Package executors holds the per-node-type execution functions. Each
// executor receives its RENDERED config (templates already substituted by
// the dispatcher) plus the run context, and returns the output that lands
// under state_json.output. Pure with respect to persistence: executors never
// touch the database — the engine owns every status transition.
//
// Scope contract inherited from the reference: inside a node, the `inputs.`
// template/expression root means that node's own config; the run input is
// reachable as `context.input.*`.
package executors

import (
	"context"
	"fmt"

	"github.com/johnny4young/janusly/go/internal/grammar"
	"github.com/johnny4young/janusly/go/internal/tools"
)

// Input carries one execution's rendered config and run context, plus the
// claim identity waiting-node executors embed in resume metadata.
type Input struct {
	RunID   string
	NodeID  string
	Config  map[string]any
	Context map[string]any
}

// Func executes one node and returns its output value.
type Func func(ctx context.Context, in Input) (any, error)

// Registry returns the executable subset: node types outside this map fail
// dispatch with the reference's "No executor" error.
func Registry() map[string]Func {
	toolRegistry := tools.NewRegistry()
	return map[string]Func{
		"tool":          NewToolExecutor(toolRegistry),
		"noop":          executeNoop,
		"condition":     executeCondition,
		"transform":     executeTransform,
		"wait_until":    executeWaitUntil,
		"approval":      executeApproval,
		"http":          NewHTTPExecutor(HTTPOptions{}),
		"parallel_fork": executeParallelFork,
		"join":          executeJoin,
	}
}

func executeNoop(context.Context, Input) (any, error) {
	return map[string]any{}, nil
}

// executeCondition evaluates config.expression and emits {result: bool}.
// An evaluation error fails the node — the authoring validator rejects
// out-of-grammar expressions at save, so a runtime error means real drift.
func executeCondition(_ context.Context, in Input) (any, error) {
	expression, ok := in.Config["expression"].(string)
	if !ok {
		return nil, fmt.Errorf("condition expression must be a string")
	}
	result, err := grammar.EvaluateExpression(expression, grammar.Scope{
		Context: in.Context, Inputs: in.Config,
	})
	if err != nil {
		return nil, err
	}
	return map[string]any{"result": result}, nil
}

// executeTransform renders config.mapping against {context, inputs: own
// config} — the rendered mapping IS the node output.
func executeTransform(_ context.Context, in Input) (any, error) {
	return grammar.MapInput(in.Config["mapping"], map[string]any{
		"context": in.Context, "inputs": in.Config,
	})
}

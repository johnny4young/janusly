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
)

// Input carries one execution's rendered config and run context, plus the
// claim identity waiting-node executors embed in resume metadata.
type Input struct {
	RunID   string
	NodeID  string
	Config  map[string]any
	Context map[string]any
	// Emit appends one run event through the engine (the reference's
	// appendEvent seam); nil in unit tests that don't observe events.
	Emit func(eventType string, payload map[string]any) string
	// ReportUnresolved feeds late-bound unresolved template paths back to
	// the dispatcher's evidence/policy machinery; a strict template policy
	// surfaces here as the returned error.
	ReportUnresolved func(paths []string) error
	// HTTPBounds carries the per-tenant outbound defaults the dispatcher
	// resolved from org config; nil keeps the platform constants. Node
	// config always wins over these.
	HTTPBounds *HTTPBounds
	// AI carries the tenant-resolved seams for `ai`/`agent` nodes; nil
	// behaves as "no provider configured" (the $0 fallback).
	AI *AIDeps
	// Memory carries the org-scoped memory seams for the vector tools;
	// nil behaves as consent-off (search empty, upsert memory_disabled).
	Memory *MemoryDeps
	// Mcp carries the dispatcher-built MCP client seam (mcp_tool nodes).
	Mcp *McpDeps
}

// MemoryDeps are thin closures over the memory substrate — the vector
// tools NEVER re-implement embedding or DB access.
type MemoryDeps struct {
	DryRun bool
	Commit func(content string, metadata map[string]any) map[string]any
	Recall func(query string) []map[string]any
	// Episodic seams (agent loop): recall renders the DATA-framed block;
	// record commits one goal+outcome episode. Nil = memory off.
	RecallEpisodes func(goal string) (block string, count int, fingerprints []string)
	RecordEpisode  func(goal, outcome string, success bool, stepCount int)
}

// HTTPBounds are the tenant-effective outbound HTTP defaults.
type HTTPBounds struct {
	TimeoutMs          float64
	MaxResponseBytes   int
	MaxRedirects       int
	StreamPreviewBytes int
}

// Func executes one node and returns its output value.
type Func func(ctx context.Context, in Input) (any, error)

// Registry returns the executable subset: node types outside this map fail
// dispatch with the reference's "No executor" error.
func Registry() map[string]Func {
	toolRegistry := NewToolRegistry()
	httpExec := NewHTTPExecutor(HTTPOptions{})
	return map[string]Func{
		"tool":             NewToolExecutor(toolRegistry),
		"agent":            NewAgentExecutor(toolRegistry, httpExec),
		"multi_agent":      NewMultiAgentExecutor(toolRegistry, httpExec),
		"noop":             executeNoop,
		"ai":               executeAiNode,
		"condition":        executeCondition,
		"transform":        executeTransform,
		"wait_until":       executeWaitUntil,
		"approval":         executeApproval,
		"http":             NewHTTPExecutor(HTTPOptions{}),
		"parallel_fork":    executeParallelFork,
		"loop":             executeLoop,
		"join":             executeJoin,
		"webhook_received": executeWebhookReceived,
		"mcp_tool":         NewMcpToolExecutor(),
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

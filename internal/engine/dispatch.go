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
	"log/slog"
	"maps"
	"os"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/internal/ai"
	"github.com/johnny4young/janusly/internal/aibudget"
	"github.com/johnny4young/janusly/internal/aiconfig"
	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/executors"
	"github.com/johnny4young/janusly/internal/grammar"
	"github.com/johnny4young/janusly/internal/mcpclient"
	"github.com/johnny4young/janusly/internal/memory"
	"github.com/johnny4young/janusly/internal/orgconfig"
	"github.com/johnny4young/janusly/internal/prompts"
	"github.com/johnny4young/janusly/internal/ratelimit"
	"github.com/johnny4young/janusly/internal/secretstore"
	"github.com/johnny4young/janusly/internal/store"
	"github.com/johnny4young/janusly/internal/tools"
)

// Dispatcher resolves and executes one claimed node at a time.
type Dispatcher struct {
	engine     *Engine
	registry   map[string]executors.Func
	renderOpts grammar.RenderOptions
	mcp        *mcpclient.Client
	aiLimiter  *ratelimit.Limiter
}

// RouterExecution carries the internal routing plan from deterministic
// dispatch into the specialized completion transaction. Only Decision is
// persisted; Candidates are retained solely to skip losing successors.
type RouterExecution struct {
	Decision     domain.DecisionOutput
	Candidates   []domain.DecisionCandidate
	SuccessorIDs map[string]bool
}

const agentWritesEnabledEnv = "JANUSLY_AGENT_WRITES_ENABLED"

// literalAgentHTTPRequests binds agent egress to exact request templates with
// literal workflow-authored targets. A URL that contains any template is
// intentionally excluded: its runtime value may originate in run input,
// prior output, or memory and must be modeled as an explicit http node instead
// of planner-selected egress. The rendered request retains authored secret and
// context substitutions for execution; model-facing projections are redacted
// independently.
func literalAgentHTTPRequests(raw, rendered map[string]any) map[string]map[string]any {
	allowed := map[string]map[string]any{}
	add := func(rawValue, renderedValue any, request map[string]any) bool {
		rawURL, rawOK := rawValue.(string)
		renderedURL, renderedOK := renderedValue.(string)
		if !rawOK || !renderedOK || strings.Contains(rawURL, "{{") {
			return false
		}
		if target := strings.TrimSpace(renderedURL); target != "" {
			request = maps.Clone(request)
			request["url"] = target
			allowed[target] = request
			return true
		}
		return false
	}
	rawInput, _ := raw["input"].(map[string]any)
	renderedInput, _ := rendered["input"].(map[string]any)
	tool, _ := raw["tool"].(string)
	// An explicit http.request tool uses its input object as the sole request
	// contract. This mirrors the deterministic planner's precedence.
	if tool == "http.request" {
		if rawInput != nil && renderedInput != nil {
			add(rawInput["url"], renderedInput["url"], renderedInput)
		}
		return allowed
	}

	request := map[string]any{}
	for _, key := range []string{
		"url", "method", "headers", "body", "timeoutMs", "maxResponseBytes",
		"maxRedirects", "bodyMode", "streamPreviewBytes",
	} {
		if value, ok := rendered[key]; ok {
			request[key] = value
		}
	}
	if add(raw["url"], rendered["url"], request) {
		return allowed
	}
	// LLM-authored agents may declare the request under input without setting
	// config.tool. Accept it only when no top-level request exists, keeping the
	// per-agent authority unambiguous.
	if rawInput != nil && renderedInput != nil {
		add(rawInput["url"], renderedInput["url"], renderedInput)
	}
	return allowed
}

func literalMultiAgentHTTPRequests(raw, rendered map[string]any) []map[string]map[string]any {
	rawAgents, _ := raw["agents"].([]any)
	renderedAgents, _ := rendered["agents"].([]any)
	requests := make([]map[string]map[string]any, len(renderedAgents))
	for index := range renderedAgents {
		rawAgent, _ := valueAt(rawAgents, index).(map[string]any)
		renderedAgent, _ := renderedAgents[index].(map[string]any)
		if rawAgent != nil && renderedAgent != nil {
			requests[index] = literalAgentHTTPRequests(rawAgent, renderedAgent)
		}
	}
	return requests
}

func valueAt(values []any, index int) any {
	if index < 0 || index >= len(values) {
		return nil
	}
	return values[index]
}

// authoredAgentWritesOptIn reads the workflow author's immutable policy, not
// the rendered config. A template in allowWriteTools may resolve from trigger
// input to a native boolean; runtime data must never be able to mint one of the
// independent grants required for a write-capable agent.
func authoredAgentWritesOptIn(config map[string]any) bool {
	allowed, _ := config["allowWriteTools"].(bool)
	return allowed
}

// NewDispatcher wires the executor registry over this engine. Env access
// defaults to the process environment filtered through the credential policy;
// secrets default to none (every {{secret.X}} is a hard failure) until a
// secret source is configured. Callers may still provide an explicit lookup.
func (e *Engine) NewDispatcher(opts grammar.RenderOptions) *Dispatcher {
	if opts.LookupEnv == nil {
		opts.LookupEnv = secretstore.LookupAllowedEnv
	}
	limiter := ratelimit.New(e.pool, ratelimit.Hooks{})
	return &Dispatcher{
		engine: e, registry: executors.Registry(), renderOpts: opts,
		mcp: mcpclient.New(e.pool, limiter), aiLimiter: limiter,
	}
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
	renderOpts := d.renderOpts
	if node.Type == "loop" {
		// The loop's item/index scopes bind per iteration inside the
		// executor; deferring them here mirrors the contract's
		// renderLoopConfig split.
		renderOpts.DeferredRoots = append([]string{"item", "index"}, renderOpts.DeferredRoots...)
	}
	if node.Type == "multi_agent" {
		// Sequential crews bind previousAgents PER COMPLETED AGENT inside
		// the executor; the parallel branch renders once before launch and
		// never defers past it.
		renderOpts.DeferredRoots = append([]string{"previousAgents"}, renderOpts.DeferredRoots...)
	}
	rendered, err := grammar.RenderTemplateWithRedactions(config, map[string]any{
		"context": runContext,
		"inputs":  config,
	}, renderOpts)
	if err != nil {
		// A missing secret is already name-only — safe to surface verbatim.
		return nil, err
	}

	if len(rendered.UnresolvedPaths) > 0 {
		if err := d.recordUnresolvedPaths(ctx, q, claim, wf, rendered.UnresolvedPaths); err != nil {
			return nil, err
		}
	}

	renderedConfig, _ := rendered.Rendered.(map[string]any)
	if renderedConfig == nil {
		renderedConfig = map[string]any{}
	}
	// The subworkflow node needs the engine (atomic child start + parent
	// checkpoint), so it dispatches here instead of the executors map.
	if node.Type == "subworkflow" {
		replayMode := claim.replayMode(ctx, q)
		return d.engine.executeSubworkflowNode(ctx, claim, renderedConfig,
			map[string]any{"input": runContext["input"]}, replayMode, rendered.RedactedValues)
	}
	if node.Type == "router" || node.Type == "router_llm" {
		candidates := domain.NormalizeDecisionCandidates(renderedConfig["candidates"])
		if len(candidates) == 0 {
			return nil, fmt.Errorf("%s node requires at least one valid routing candidate", node.Type)
		}
		rows, err := q.ListRoutingStats(ctx, claim.OrgID)
		if err != nil {
			return nil, fmt.Errorf("load routing stats: %w", err)
		}
		stats := make(map[string]domain.RoutingStat, len(rows))
		for _, row := range rows {
			stats[row.NodeID] = domain.RoutingStat{
				Pulls: row.Pulls, MeanReward: float64(row.MeanReward),
			}
		}
		successorIDs := map[string]bool{}
		for _, edge := range wf.Edges {
			if edge.From == node.ID {
				successorIDs[edge.To] = true
			}
		}
		return RouterExecution{
			Decision: domain.Decide(domain.DecisionInput{
				Candidates:  candidates,
				Preferences: domain.DecisionPreferencesFromValue(runContext["preferences"]),
				Budget:      domain.DecisionBudgetFromValue(runContext["budget"]),
				RLStats:     stats,
				Strategy:    domain.NormalizeDecisionStrategy(renderedConfig["strategy"]),
			}),
			Candidates: candidates, SuccessorIDs: successorIDs,
		}, nil
	}
	execute, ok := d.registry[node.Type]
	if !ok {
		return nil, fmt.Errorf("No executor for node type: %s", node.Type) //nolint:staticcheck // contract message is the wire contract
	}
	var httpBounds *executors.HTTPBounds
	if node.Type == "http" || node.Type == "tool" || node.Type == "loop" || node.Type == "agent" || node.Type == "multi_agent" {
		bounds := LoadOrgHTTPBounds(ctx, q, claim.OrgID, d.renderOpts.LookupEnv)
		httpBounds = &bounds
	}
	dryRun := claim.replayMode(ctx, q) == "validation"
	var aiDeps *executors.AIDeps
	if node.Type == "ai" || node.Type == "agent" || node.Type == "multi_agent" {
		aiDeps = d.buildAIDeps(ctx, claim)
	}
	var memoryDeps *executors.MemoryDeps
	if node.Type == "tool" || node.Type == "loop" || node.Type == "agent" || node.Type == "multi_agent" {
		memoryDeps = d.buildMemoryDeps(ctx, claim, wf.ID, rendered.RedactedValues)
	}
	var integrationDeps *tools.IntegrationDeps
	if node.Type == "tool" || node.Type == "loop" || node.Type == "agent" || node.Type == "multi_agent" {
		integrationDeps = d.engine.buildIntegrationDeps(claim.OrgID, claim.RunID, claim.NodeID)
	}
	var mcpDeps *executors.McpDeps
	if node.Type == "mcp_tool" {
		mcpDeps = &executors.McpDeps{
			Execute: func(execCtx context.Context, mcpCall executors.McpCall) executors.McpEnvelope {
				return d.mcp.Execute(execCtx, mcpclient.Call{
					OrgID: claim.OrgID, ConnectionAlias: mcpCall.ConnectionAlias,
					ToolName: mcpCall.ToolName, Input: mcpCall.Input,
					TimeoutMs: mcpCall.TimeoutMs, DryRun: dryRun,
					RunID: claim.RunID, NodeID: claim.NodeID, WorkflowID: wf.ID,
				})
			},
		}
	}
	agentWritesAuthorized := false
	var agentAllowedHTTPRequests map[string]map[string]any
	var agentAllowedHTTPRequestsByIndex []map[string]map[string]any
	if node.Type == "agent" || node.Type == "multi_agent" {
		if node.Type == "agent" {
			agentAllowedHTTPRequests = literalAgentHTTPRequests(config, renderedConfig)
		} else {
			agentAllowedHTTPRequestsByIndex = literalMultiAgentHTTPRequests(config, renderedConfig)
		}
		agentWritesAuthorized = !dryRun && authoredAgentWritesOptIn(config) &&
			os.Getenv(agentWritesEnabledEnv) == "true" &&
			orgconfig.LoadBool(ctx, d.engine.pool, claim.OrgID, "ai.agentWriteConsent") &&
			domain.HasApprovalAncestorIn(wf, node.ID)
	}
	output, execErr := execute(ctx, executors.Input{
		RunID: claim.RunID, NodeID: claim.NodeID,
		Config: renderedConfig, Context: runContext, HTTPBounds: httpBounds,
		RedactedValues: rendered.RedactedValues,
		AI:             aiDeps, Memory: memoryDeps, Mcp: mcpDeps, Integrations: integrationDeps,
		AgentWritesAuthorized:           agentWritesAuthorized,
		AgentAllowedHTTPRequests:        agentAllowedHTTPRequests,
		AgentAllowedHTTPRequestsByIndex: agentAllowedHTTPRequestsByIndex,
		DryRun:                          dryRun,
		Emit: func(eventType string, payload map[string]any) string {
			eventAt := d.engine.eventNow()
			raw := grammar.SafePersistPayload(payload, grammar.PersistOptions{
				RedactedValues: rendered.RedactedValues,
			})
			eventID := d.engine.newID()
			if err := q.InsertRunEventAt(ctx, store.InsertRunEventAtParams{
				ID: eventID, RunID: claim.RunID,
				NodeID: pgtype.Text{String: claim.NodeID, Valid: true},
				Type:   eventType, Payload: raw, CreatedAt: &eventAt,
			}); err != nil && ctx.Err() == nil {
				// Mirrors claimBatch: an executor timeline that silently
				// stops recording is worse than a warning per lost event.
				slog.Warn("executor event not recorded", "runId", claim.RunID, "nodeId", claim.NodeID, "type", eventType, "error", err)
			}
			return eventID
		},
		ReportUnresolved: func(paths []string) error {
			return d.recordUnresolvedPaths(ctx, q, claim, wf, paths)
		},
	})
	if execErr != nil {
		return nil, redactExecError(execErr, rendered.RedactedValues)
	}
	if waiting, ok := output.(executors.Waiting); ok {
		waiting.Metadata, _ = grammar.RedactValues(waiting.Metadata, rendered.RedactedValues).(map[string]any)
		return waiting, nil
	}
	return grammar.RedactValues(output, rendered.RedactedValues), nil
}

// redactExecError scrubs resolved secret/env values from the message while
// preserving the error's classification identity (name/code/status) — the
// retry ladder reads those fields to match retryOn patterns like "5xx".
func redactExecError(execErr error, redactedValues []string) error {
	message := grammar.RedactString(execErr.Error(), redactedValues)
	var rich richError
	if errors.As(execErr, &rich) {
		out := &ExecError{
			Message: message, Name: rich.ErrorName(),
			Code: rich.ErrorCode(), StatusCode: rich.ErrorStatusCode(),
		}
		var detailed detailedError
		if errors.As(execErr, &detailed) && detailed.ErrorDetails() != nil {
			out.Details = grammar.RedactValues(detailed.ErrorDetails(), redactedValues)
		}
		if flagged, ok := execErr.(interface{ ErrorWriteSide() bool }); ok {
			out.WriteSide = flagged.ErrorWriteSide()
		}
		out.WriteSide = out.WriteSide || errorCarriesWriteSide(execErr)
		return out
	}
	var config *executors.ConfigError
	if errors.As(execErr, &config) {
		return &ExecError{Message: message, Name: "WaitingConfigError", Code: config.Code}
	}
	return errors.New(message)
}

// errorCarriesWriteSide walks wrapped errors for the write-side marker.
func errorCarriesWriteSide(execErr error) bool {
	var shape *executors.ExecErrorShape
	return errors.As(execErr, &shape) && shape.WriteSide
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
	eventAt := d.engine.eventNow()
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

// buildAIDeps resolves the tenant seams for an ai node: the catalog-built
// chokepoint client, the fail-soft budget check, the PromptOps resolver,
// and the dry-run flag from the run's replay mode (a validation replay
// must never touch the SDK).
func (d *Dispatcher) buildAIDeps(ctx context.Context, claim ClaimedNode) *executors.AIDeps {
	pool := d.engine.pool
	client, settings := aiconfig.Resolve(ctx, pool, claim.OrgID)
	workflowID, _ := store.New(pool).GetRunWorkflowID(ctx, claim.RunID)
	dryRun := claim.replayMode(ctx, store.New(pool)) == "validation"
	return &executors.AIDeps{
		Client: client, OrgID: claim.OrgID, WorkflowID: workflowID, DryRun: dryRun,
		PromptMaxChars: settings.PromptMaxChars,
		BudgetAllowed: func() (bool, map[string]any) {
			// Composite gate: the run's workflow override bites
			// before the org default; resolution failure degrades to org.
			result := aibudget.CheckScoped(ctx, pool, claim.OrgID, workflowID)
			budget := map[string]any{
				"monthlyUsdSpent": result.MonthlyUsdSpent, "monthlyUsdLimit": result.MonthlyUsdLimit,
				"policy": result.Policy, "exceededAt": result.ExceededAt,
			}
			return result.Allowed, budget
		},
		RateAllowed: func() *ai.AIError {
			if d.aiLimiter == nil {
				return nil
			}
			if err := d.aiLimiter.Enforce(ctx, claim.OrgID, ratelimit.Options{
				Name: "ai", Max: settings.RateLimitPerMin, Window: time.Minute,
			}); err != nil {
				return &ai.AIError{Class: "rate_limit", Message: err.Error(), BeforeEgress: true}
			}
			return nil
		},
		ResolvePrompt: func(name string, version int, variables map[string]string) (string, error) {
			return prompts.ResolveTemplate(ctx, pool, claim.OrgID, name, version, variables)
		},
	}
}

// buildMemoryDeps wires the vector tools to the memory substrate with
// the run's org/run identity and the validation dry-run flag.
func (d *Dispatcher) buildMemoryDeps(ctx context.Context, claim ClaimedNode, workflowID string, redactedValues []string) *executors.MemoryDeps {
	pool := d.engine.pool
	redactedValues = append([]string(nil), redactedValues...)
	dryRun := claim.replayMode(ctx, store.New(pool)) == "validation"
	return &executors.MemoryDeps{
		DryRun: dryRun,
		Commit: func(content string, metadata map[string]any) map[string]any {
			result := memory.Commit(ctx, pool, memory.CommitInput{
				OrgID: claim.OrgID, WorkflowID: workflowID, RunID: claim.RunID, Kind: "workflow_vector",
				Content: content, Metadata: metadata, RedactedValues: redactedValues,
			})
			out := map[string]any{"ok": result.OK}
			if result.Error != "" {
				out["error"] = result.Error
			}
			if result.ID != "" {
				out["id"] = result.ID
			}
			return out
		},
		RecallEpisodes: func(goal string) (string, int, []string) {
			recall := memory.RecallAgentEpisodes(ctx, pool, claim.OrgID, workflowID, claim.RunID, goal, redactedValues)
			return recall.Block, recall.Count, recall.Fingerprints
		},
		RecordEpisode: func(goal, outcome string, success bool, stepCount int) {
			memory.RecordAgentEpisode(ctx, pool, claim.OrgID, workflowID, claim.RunID, goal, outcome, success, stepCount, redactedValues)
		},
		Recall: func(query string) []map[string]any {
			entries := memory.Recall(ctx, pool, memory.RecallInput{
				OrgID: claim.OrgID, WorkflowID: workflowID, RunID: claim.RunID, Kind: "workflow_vector", Query: query,
				RedactedValues: redactedValues,
			})
			out := make([]map[string]any, 0, len(entries))
			for _, entry := range entries {
				out = append(out, map[string]any{
					"id": entry.ID, "kind": entry.Kind, "content": entry.Content,
					"metadata": entry.Metadata,
				})
			}
			return out
		},
	}
}

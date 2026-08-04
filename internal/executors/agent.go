// The `agent` node executor — the plan → tool → observe loop with a step
// budget, implements the contract's runAgentLoop with its deterministic
// RULES planner as the no-key default (the LLM planner arrives with its
// own ticket and falls back here). Every iteration emits the contract's
// event family (started, step.started, step.planned, agent.reasoning,
// tool.started/completed, reflection, completed); a validation dry-run
// SKIPS write-side tools at execution (and the LLM planner additionally
// hides them from the prompt — defense in depth). http.request runs
// through the SAME machinery as the http node: SSRF guard, bounds,
// redirects — never a second HTTP stack.
package executors

import (
	"context"
	"encoding/json"
	"fmt"
	"maps"
	"strings"
	"time"

	"github.com/johnny4young/janusly/internal/ai"
	"github.com/johnny4young/janusly/internal/aiguidance"
	"github.com/johnny4young/janusly/internal/tools"
)

// AgentPlan is one planner decision.
type AgentPlan struct {
	Done        bool           `json:"done,omitempty"`
	FinalAnswer string         `json:"finalAnswer,omitempty"`
	Tool        string         `json:"tool,omitempty"`
	Input       map[string]any `json:"input,omitempty"`
	Reason      string         `json:"reason,omitempty"`
	Mode        string         `json:"mode,omitempty"`
	AiError     string         `json:"aiError,omitempty"`
}

// planAgentTool is the contract's deterministic rules ladder, verbatim.
func planAgentTool(config map[string]any, planningContext map[string]any) AgentPlan {
	if tool, ok := config["tool"].(string); ok && tool != "" {
		input, _ := config["input"].(map[string]any)
		if input == nil {
			input = map[string]any{}
		}
		return AgentPlan{Tool: tool, Input: input, Reason: "Explicit tool selected by node config"}
	}
	goal := strings.ToLower(fmt.Sprint(config["goal"]))
	switch {
	case strings.Contains(goal, "uppercase") || strings.Contains(goal, "upper case"):
		value := config["value"]
		if value == nil {
			value = config["text"]
		}
		if value == nil {
			value = ""
		}
		return AgentPlan{Tool: "text.uppercase", Input: map[string]any{"value": value},
			Reason: "Goal matched text uppercase transformation"}
	case strings.Contains(goal, "pick") || strings.Contains(goal, "extract"):
		path, _ := config["path"].(string)
		return AgentPlan{Tool: "json.pick", Input: map[string]any{"path": path},
			Reason: "Goal matched JSON extraction"}
	case strings.Contains(goal, "http") || strings.Contains(goal, "request") || strings.Contains(goal, "call api"):
		input := map[string]any{"url": config["url"], "method": "GET"}
		if method, ok := config["method"].(string); ok && method != "" {
			input["method"] = method
		}
		if body, ok := config["body"]; ok {
			input["body"] = body
		}
		if headers, ok := config["headers"]; ok {
			input["headers"] = headers
		}
		return AgentPlan{Tool: "http.request", Input: input, Reason: "Goal matched HTTP/API request"}
	default:
		serialized, _ := json.Marshal(map[string]any{"goal": config["goal"], "context": planningContext})
		return AgentPlan{Tool: "text.uppercase", Input: map[string]any{"value": string(serialized)},
			Reason: "Fallback planner selected text.uppercase"}
	}
}

// sensitiveHTTPRequest classifies an http.request plan as write-side.
func sensitiveHTTPRequest(input map[string]any) bool {
	method, _ := input["method"].(string)
	switch strings.ToUpper(method) {
	case "POST", "PUT", "PATCH", "DELETE":
		return true
	}
	return false
}

// NewAgentExecutor builds the agent loop over the tool registry and the
// http node's executor (http.request = the same guarded machinery).
func NewAgentExecutor(registry *tools.Registry, httpExec Func) Func {
	return func(ctx context.Context, in Input) (any, error) {
		return runAgentLoop(ctx, in, in.Config, "agent", registry, httpExec)
	}
}

func runAgentLoop(ctx context.Context, in Input, agentConfig map[string]any, eventPrefix string,
	registry *tools.Registry, httpExec Func) (map[string]any, error) {
	planner, _ := agentConfig["planner"].(string)
	if planner == "" {
		planner = "rules"
	}
	maxSteps := 3
	if raw, ok := agentConfig["maxSteps"].(float64); ok && raw >= 1 {
		maxSteps = int(raw)
	}
	reflectionEnabled, _ := agentConfig["reflection"].(bool)
	// The sandbox contract ("a validation replay never runs a write side")
	// must hold on the authoritative per-execution flag, exactly like
	// tool.go and http.go read it. Deriving it from AIDeps alone made the
	// guarantee depend on the dispatcher always building a non-nil AI dep:
	// true today, but a nil AI would have silently re-enabled real writes.
	dryRun := in.DryRun || (in.AI != nil && in.AI.DryRun)
	emit := func(eventType string, payload map[string]any) string {
		if in.Emit != nil {
			return in.Emit(eventType, payload)
		}
		return ""
	}
	name, _ := agentConfig["name"].(string)
	emit(eventPrefix+".started", map[string]any{
		"name": name, "planner": planner, "maxSteps": maxSteps,
		"reflection": reflectionEnabled, "goal": agentConfig["goal"],
	})

	// Cross-run episodic recall feeds the LLM planner ONLY (rules ignores
	// memory) — the embedding call is skipped otherwise.
	goalText := fmt.Sprint(agentConfig["goal"])
	if agentConfig["goal"] == nil {
		goalText = ""
	}
	episodeBlock, episodeCount := "", 0
	var episodeFingerprints []string
	llmConfigured := in.AI != nil && in.AI.Client != nil && in.AI.Client.Configured()
	if planner == "openai" && llmConfigured && in.Memory != nil && in.Memory.RecallEpisodes != nil {
		episodeBlock, episodeCount, episodeFingerprints = in.Memory.RecallEpisodes(goalText)
	}
	memoryInfluenceEmitted := false

	steps := make([]map[string]any, 0, maxSteps)
	var lastResult any
	var lastReflection map[string]any

	for i := 0; i < maxSteps; i++ {
		emit(eventPrefix+".step.started", map[string]any{"agent": name, "iteration": i})
		planningContext := map[string]any{"context": in.Context, "steps": steps, "lastReflection": lastReflection}

		var plan AgentPlan
		if planner == "openai" && in.AI != nil {
			plan = planAgentToolWithLLM(ctx, in, agentConfig, planningContext, steps, registry, episodeBlock)
		} else {
			plan = planAgentTool(agentConfig, planningContext)
			plan.Mode = "rules"
		}
		// Only a successfully parsed AI plan generated WITH a non-empty
		// recall emits the memory event — no-client/malformed/thrown paths
		// emit nothing, and episode content never enters the event.
		if !memoryInfluenceEmitted && episodeCount > 0 && plan.Mode == "ai" {
			emit("agent.memory.recalled", map[string]any{
				"count": episodeCount, "fingerprints": episodeFingerprints,
			})
			memoryInfluenceEmitted = true
		}
		plannedEventID := emit(eventPrefix+".step.planned", map[string]any{"agent": name, "iteration": i, "plan": plan})
		decision := "use_tool"
		var toolField any = fallbackReasoningText(
			sanitizeReasoningText(plan.Tool, agentReasoningToolMaxChars), "unknown")
		if plan.Done {
			decision, toolField = "finish", nil
		}
		emit("agent.reasoning", map[string]any{
			"agent": fallbackReasoningText(
				sanitizeReasoningText(name, agentReasoningAgentMaxChars), "agent"),
			"iteration": i, "planner": planner, "mode": plan.Mode,
			"scope": fallbackReasoningText(
				sanitizeReasoningText(eventPrefix, agentReasoningScopeMaxChars), "agent"),
			"replacesEventId": plannedEventID,
			"decision":        decision, "tool": toolField,
			"reason": fallbackReasoningText(
				sanitizeReasoningText(plan.Reason, agentReasoningReasonMaxChars),
				"Planner did not provide an operational rationale."),
		})

		if plan.Done {
			emit(eventPrefix+".completed", map[string]any{
				"agent": name, "iteration": i, "finalAnswer": plan.FinalAnswer, "steps": steps,
			})
			// Record the episode; skipped in dry-run so sandbox runs never
			// pollute durable memory.
			if !dryRun && in.Memory != nil && in.Memory.RecordEpisode != nil {
				in.Memory.RecordEpisode(goalText, plan.FinalAnswer, true, len(steps))
			}
			return map[string]any{"steps": steps, "finalAnswer": plan.FinalAnswer, "reflection": lastReflection}, nil
		}

		// Dry-run write-skip: the executor-level defense in depth.
		writeSide := registry.IsWriteSide(plan.Tool) ||
			(plan.Tool == "http.request" && sensitiveHTTPRequest(plan.Input))
		if dryRun && writeSide {
			result := map[string]any{"tool": plan.Tool, "dryRun": true, "skipped": true}
			emit(eventPrefix+".tool.completed", map[string]any{
				"agent": name, "iteration": i, "tool": plan.Tool, "result": result,
			})
			steps = append(steps, map[string]any{"iteration": i, "plan": plan, "result": result})
			lastResult = result
			continue
		}

		emit(eventPrefix+".tool.started", map[string]any{
			"agent": name, "iteration": i, "tool": plan.Tool, "input": plan.Input,
		})
		result := executeAgentTool(ctx, in, plan, agentConfig, registry, httpExec)
		emit(eventPrefix+".tool.completed", map[string]any{
			"agent": name, "iteration": i, "tool": plan.Tool, "result": result,
		})

		if reflectionEnabled {
			decision := "accept"
			reason := "The result looks acceptable."
			if hasFailureSignal(result) {
				decision, reason = "retry", "The result contains an error-like signal."
			}
			lastReflection = map[string]any{
				"agent": name, "iteration": i, "decision": decision, "reason": reason,
			}
			emit(eventPrefix+".reflection", lastReflection)
		}
		steps = append(steps, map[string]any{"iteration": i, "plan": plan, "result": result, "reflection": lastReflection})
		lastResult = result
	}

	emit(eventPrefix+".completed", map[string]any{
		"agent": name, "reason": "maxSteps reached", "steps": steps, "finalResult": lastResult,
	})
	if !dryRun && in.Memory != nil && in.Memory.RecordEpisode != nil {
		outcome, _ := json.Marshal(lastResult)
		in.Memory.RecordEpisode(goalText,
			fmt.Sprintf("Reached step budget (%d) without completing. Last result: %.500s", len(steps), string(outcome)),
			false, len(steps))
	}
	return map[string]any{"steps": steps, "finalResult": lastResult, "reflection": lastReflection}, nil
}

// executeAgentTool runs one planned tool with the per-call timeout:
// http.request through the http node's machinery, everything else via
// the registry. Failures land as {ok:false} envelopes — the loop
// observes them, it never dies on them.
func executeAgentTool(ctx context.Context, in Input, plan AgentPlan, agentConfig map[string]any,
	registry *tools.Registry, httpExec Func) map[string]any {
	callCtx := ctx
	if timeoutMs, ok := agentConfig["timeoutMs"].(float64); ok && timeoutMs > 0 {
		var cancel context.CancelFunc
		callCtx, cancel = context.WithTimeout(ctx, time.Duration(timeoutMs)*time.Millisecond)
		defer cancel()
	}
	if plan.Tool == "http.request" {
		output, err := httpExec(callCtx, Input{
			RunID: in.RunID, NodeID: in.NodeID, Config: plan.Input,
			Context: in.Context, HTTPBounds: in.HTTPBounds,
		})
		if err != nil {
			return map[string]any{"ok": false, "error": err.Error()}
		}
		result := map[string]any{"ok": true}
		if outputMap, ok := output.(map[string]any); ok {
			maps.Copy(result, outputMap)
		}
		return result
	}
	if plan.Tool == "vector.search" || plan.Tool == "vector.upsert" {
		return executeVectorTool(plan.Tool, plan.Input, in.Memory)
	}
	output, err := registry.Execute(callCtx, plan.Tool, plan.Input)
	if err != nil {
		return map[string]any{"ok": false, "error": err.Error()}
	}
	result := map[string]any{"ok": true}
	maps.Copy(result, output)
	return result
}

func hasFailureSignal(result map[string]any) bool {
	if result == nil {
		return true
	}
	if ok, present := result["ok"].(bool); present && !ok {
		return true
	}
	_, hasError := result["error"]
	return hasError
}

// Per-field caps for the stable operator-facing rationale contract —
// pinned to the contract's run-events.ts values.
const (
	agentReasoningAgentMaxChars  = 120
	agentReasoningScopeMaxChars  = 160
	agentReasoningToolMaxChars   = 160
	agentReasoningReasonMaxChars = 500
)

// sanitizeReasoningText produces one bounded `agent.reasoning` field: an
// operational summary, never hidden chain-of-thought — secrets scrubbed,
// control/invisible characters flattened, whitespace collapsed, rune-capped.
func sanitizeReasoningText(value string, maxChars int) string {
	scrubbed := aiguidance.ScrubGuidanceSecrets(value)
	flattened := strings.Map(func(r rune) rune {
		switch {
		case r <= 0x1f, r == 0x7f,
			r >= 0x200b && r <= 0x200f,
			r >= 0x202a && r <= 0x202e,
			r >= 0x2060 && r <= 0x206f,
			r == 0xfeff:
			return ' '
		}
		return r
	}, scrubbed)
	collapsed := strings.Join(strings.Fields(flattened), " ")
	runes := []rune(collapsed)
	if len(runes) > maxChars {
		runes = runes[:maxChars]
	}
	return string(runes)
}

func fallbackReasoningText(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}

// planAgentToolWithLLM ports the contract's LLM planner: free-json plan
// validated against the tool catalog, every failure falling back to the
// deterministic rules planner with aiError attribution — the loop always
// makes progress.
func planAgentToolWithLLM(ctx context.Context, in Input, agentConfig map[string]any,
	planningContext map[string]any, steps []map[string]any, registry *tools.Registry,
	recalledEpisodes string) AgentPlan {
	deps := in.AI
	rulesFallback := func(aiError string) AgentPlan {
		plan := planAgentTool(agentConfig, planningContext)
		plan.Mode, plan.AiError = "fallback", aiError
		return plan
	}
	if deps == nil || deps.Client == nil || !deps.Client.Configured() {
		return rulesFallback("llm_not_configured")
	}
	// Budget: a block TERMINATES the agent cleanly instead of re-firing.
	if deps.BudgetAllowed != nil {
		if allowed, budget := deps.BudgetAllowed(); !allowed {
			return AgentPlan{
				Tool: "done", Done: true, Mode: "fallback", AiError: "budget_exceeded",
				FinalAnswer: "Agent terminated: AI cost budget exceeded.",
				Reason:      fmt.Sprintf("Budget exceeded — agent terminated (%v of %v).", budget["monthlyUsdSpent"], budget["monthlyUsdLimit"]),
			}
		}
	}

	goal := agentConfig["goal"]
	if goal == nil {
		goal = "Choose the best tool for this workflow step."
	}
	systemPrompt := "You are a workflow agent planner. Select exactly one tool from availableTools, or return done=true if the goal is complete. Return only valid JSON."
	if refRaw, ok := agentConfig["systemPromptRef"].(map[string]any); ok && deps.ResolvePrompt != nil {
		if refName, ok := refRaw["name"].(string); ok && refName != "" {
			version := 0
			if v, ok := refRaw["version"].(float64); ok {
				version = int(v)
			}
			variables := map[string]string{}
			if raw, ok := agentConfig["variables"].(map[string]any); ok {
				for key, value := range raw {
					if text, ok := value.(string); ok {
						variables[key] = text
					}
				}
			}
			if resolved, err := deps.ResolvePrompt(refName, version, variables); err == nil {
				systemPrompt = resolved
			}
			// A resolver failure falls back silently to the hardcoded prompt.
		}
	}

	availableTools := plannerToolsWithHTTP(registry, deps.DryRun)
	availableNames := map[string]bool{}
	for _, tool := range availableTools {
		if toolName, ok := tool["name"].(string); ok {
			availableNames[toolName] = true
		}
	}
	promptPayload := map[string]any{
		"goal": goal, "config": agentConfig, "context": planningContext,
		"history": steps, "availableTools": availableTools,
		"requiredJsonShape": map[string]any{
			"done": "boolean optional", "finalAnswer": "string optional",
			"tool":  "one available tool name when not done",
			"input": "object with tool input when not done", "reason": "short reason",
		},
	}
	if recalledEpisodes != "" {
		promptPayload["recalledEpisodes"] = recalledEpisodes
	}
	promptJSON, _ := json.Marshal(promptPayload)
	modelHint, _ := agentConfig["model"].(string)
	result, aiErr := deps.Client.GenerateText(ctx, ai.GenerateTextInput{
		System: systemPrompt, Prompt: string(promptJSON), ResponseFormat: "json",
		ModelHint: modelHint,
		Context:   ai.CallContext{OrgID: deps.OrgID, RunID: in.RunID, NodeID: in.NodeID, WorkflowID: deps.WorkflowID},
	})
	if aiErr != nil {
		return rulesFallback(aiErr.Error())
	}
	var reply struct {
		Done        bool           `json:"done"`
		FinalAnswer string         `json:"finalAnswer"`
		Tool        string         `json:"tool"`
		Input       map[string]any `json:"input"`
		Reason      string         `json:"reason"`
	}
	text := result.Text
	if text == "" {
		text = "{}"
	}
	if err := json.Unmarshal([]byte(text), &reply); err != nil {
		return rulesFallback("LLM planner returned a malformed plan shape")
	}
	if reply.Done {
		finalAnswer := reply.FinalAnswer
		if finalAnswer == "" {
			finalAnswer = "Done"
		}
		reason := reply.Reason
		if reason == "" {
			reason = "Goal completed"
		}
		return AgentPlan{Tool: "done", Done: true, FinalAnswer: finalAnswer, Reason: reason, Mode: "ai"}
	}
	if reply.Tool == "" || !availableNames[reply.Tool] {
		return rulesFallback("LLM planner did not return an available tool")
	}
	input := reply.Input
	if input == nil {
		input = map[string]any{}
	}
	reason := reply.Reason
	if reason == "" {
		reason = "LLM selected tool"
	}
	return AgentPlan{Tool: reply.Tool, Input: input, Reason: reason, Mode: "ai"}
}

// plannerToolsWithHTTP appends the executor-level http.request entry to
// the registry projection (read-side by default; dryRun keeps it since
// the executor's own write gate covers sensitive methods).
func plannerToolsWithHTTP(registry *tools.Registry, dryRun bool) []map[string]any {
	out := registry.PlannerTools(dryRun)
	return append(out, map[string]any{
		"name":        "http.request",
		"description": "Perform an outbound HTTP request through the guarded HTTP stack (SSRF-validated, bounded).",
		"required":    []string{"url"},
		"inputFields": []map[string]any{
			{"name": "url", "type": "string", "required": true},
			{"name": "method", "type": "string"}, {"name": "headers", "type": "object"},
			{"name": "body", "type": "unknown"},
		},
		"writeSide": false,
	})
}

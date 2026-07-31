// The `agent` node executor — the plan → tool → observe loop with a step
// budget, ported from the reference's runAgentLoop with its deterministic
// RULES planner as the no-key default (the LLM planner arrives with its
// own ticket and falls back here). Every iteration emits the reference's
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
	"strings"
	"time"

	"github.com/johnny4young/janusly/go/internal/tools"
)

// AgentPlan is one planner decision.
type AgentPlan struct {
	Done        bool           `json:"done,omitempty"`
	FinalAnswer string         `json:"finalAnswer,omitempty"`
	Tool        string         `json:"tool,omitempty"`
	Input       map[string]any `json:"input,omitempty"`
	Reason      string         `json:"reason,omitempty"`
	Mode        string         `json:"mode,omitempty"`
}

// planAgentTool is the reference's deterministic rules ladder, verbatim.
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
	dryRun := in.AI != nil && in.AI.DryRun
	emit := func(eventType string, payload map[string]any) {
		if in.Emit != nil {
			in.Emit(eventType, payload)
		}
	}
	name, _ := agentConfig["name"].(string)
	emit(eventPrefix+".started", map[string]any{
		"name": name, "planner": planner, "maxSteps": maxSteps,
		"reflection": reflectionEnabled, "goal": agentConfig["goal"],
	})

	steps := make([]map[string]any, 0, maxSteps)
	var lastResult any
	var lastReflection map[string]any

	for i := 0; i < maxSteps; i++ {
		emit(eventPrefix+".step.started", map[string]any{"agent": name, "iteration": i})
		planningContext := map[string]any{"context": in.Context, "steps": steps, "lastReflection": lastReflection}

		var plan AgentPlan
		if planner == "openai" && in.AI != nil {
			plan = planAgentToolWithLLM(ctx, in, agentConfig, planningContext, steps)
		} else {
			plan = planAgentTool(agentConfig, planningContext)
			plan.Mode = "rules"
		}
		emit(eventPrefix+".step.planned", map[string]any{"agent": name, "iteration": i, "plan": plan})
		decision := "use_tool"
		reasonText := plan.Reason
		if plan.Done {
			decision = "finish"
		}
		if reasonText == "" {
			reasonText = "Planner did not provide an operational rationale."
		}
		emit("agent.reasoning", map[string]any{
			"agent": boundedText(name, 80), "iteration": i, "planner": planner,
			"mode": plan.Mode, "scope": boundedText(eventPrefix, 40),
			"decision": decision, "tool": boundedText(plan.Tool, 120),
			"reason": boundedText(reasonText, 280),
		})

		if plan.Done {
			emit(eventPrefix+".completed", map[string]any{
				"agent": name, "iteration": i, "finalAnswer": plan.FinalAnswer, "steps": steps,
			})
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
			for key, value := range outputMap {
				result[key] = value
			}
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
	for key, value := range output {
		result[key] = value
	}
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

func boundedText(value string, max int) string {
	runes := []rune(value)
	if len(runes) <= max {
		return value
	}
	return string(runes[:max])
}

// planAgentToolWithLLM is the LLM planner seam — its real implementation
// arrives with its own ticket; until then every call falls back to rules.
func planAgentToolWithLLM(_ context.Context, _ Input, agentConfig map[string]any,
	planningContext map[string]any, _ []map[string]any) AgentPlan {
	plan := planAgentTool(agentConfig, planningContext)
	plan.Mode = "fallback"
	return plan
}

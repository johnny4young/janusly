// The `multi_agent` node — a crew of agent loops over one shared context,
// ported from the reference: sequential mode binds each agent's goal
// template PER COMPLETED AGENT ({context, previousAgents} at that
// agent's turn — the dispatcher defers the previousAgents root for this
// node type), parallel mode NEVER defers previousAgents (every goal
// binds once, before launch — a late binding would race). Failures honor
// continueOnError; aggregation follows the reference's last / all /
// first / best-effort strategies; the output shape is the reference's
// {mode, aggregation, count, finalAnswer, agents}.
package executors

import (
	"context"
	"fmt"
	"sync"

	"github.com/johnny4young/janusly/go/internal/grammar"
	"github.com/johnny4young/janusly/go/internal/tools"
)

// NewMultiAgentExecutor builds the crew executor over the same registry
// and http machinery as the single agent.
func NewMultiAgentExecutor(registry *tools.Registry, httpExec Func) Func {
	return func(ctx context.Context, in Input) (any, error) {
		return runMultiAgent(ctx, in, registry, httpExec)
	}
}

func runMultiAgent(ctx context.Context, in Input, registry *tools.Registry, httpExec Func) (any, error) {
	agentsRaw, _ := in.Config["agents"].([]any)
	mode, _ := in.Config["mode"].(string)
	if mode == "" {
		mode = "sequential"
	}
	aggregation, _ := in.Config["aggregation"].(string)
	if aggregation == "" {
		aggregation = "last"
	}
	continueOnError, _ := in.Config["continueOnError"].(bool)
	emit := func(eventType string, payload map[string]any) {
		if in.Emit != nil {
			in.Emit(eventType, payload)
		}
	}
	sharedContext := map[string]any{}
	for key, value := range in.Context {
		sharedContext[key] = value
	}
	results := make([]any, 0, len(agentsRaw))
	emit("multi_agent.started", map[string]any{
		"mode": mode, "aggregation": aggregation, "count": len(agentsRaw), "goal": in.Config["goal"],
	})

	runOne := func(index int, agentConfig map[string]any, contextSnapshot map[string]any) (map[string]any, error) {
		name, _ := agentConfig["name"].(string)
		emit("multi_agent.agent.started", map[string]any{
			"index": index, "name": name, "role": agentConfig["role"],
			"goal": agentConfig["goal"], "mode": mode,
		})
		inner := in
		inner.Context = contextSnapshot
		result, err := runAgentLoop(ctx, inner, agentConfig, fmt.Sprintf("multi_agent.agent.%d", index), registry, httpExec)
		if err != nil {
			return nil, err
		}
		return map[string]any{
			"index": index, "name": name, "role": agentConfig["role"],
			"status": "completed", "result": result,
		}, nil
	}

	if mode == "parallel" {
		// EVERY goal binds before launch — previousAgents is the (empty)
		// snapshot, never a late binding.
		configs := make([]map[string]any, len(agentsRaw))
		for index, raw := range agentsRaw {
			config, err := resolveCrewAgentConfig(in, raw, index, sharedContext, results)
			if err != nil {
				return nil, err
			}
			configs[index] = config
		}
		type settled struct {
			value map[string]any
			err   error
		}
		outcomes := make([]settled, len(configs))
		var wg sync.WaitGroup
		for index, config := range configs {
			wg.Add(1)
			go func() {
				defer wg.Done()
				value, err := runOne(index, config, sharedContext)
				outcomes[index] = settled{value: value, err: err}
			}()
		}
		wg.Wait()
		for index, outcome := range outcomes {
			name, _ := configs[index]["name"].(string)
			if outcome.err == nil {
				results = append(results, outcome.value)
				sharedContext[fmt.Sprintf("agent_%d", index+1)] = map[string]any{"output": outcome.value["result"]}
				sharedContext[name] = map[string]any{"output": outcome.value["result"]}
				emit("multi_agent.agent.completed", outcome.value)
				continue
			}
			failed := map[string]any{
				"index": index, "name": name, "status": "failed",
				"error": map[string]any{"message": outcome.err.Error()},
			}
			results = append(results, failed)
			emit("multi_agent.agent.failed", failed)
			if !continueOnError {
				return nil, fmt.Errorf("Multi-agent %s failed: %s", name, outcome.err.Error()) //nolint:staticcheck // reference message
			}
		}
	} else {
		for index, raw := range agentsRaw {
			// Sequential: the goal template binds NOW, with the completed
			// agents so far — the deferred previousAgents root resolves at
			// this exact lifecycle point.
			config, err := resolveCrewAgentConfig(in, raw, index, sharedContext, results)
			if err != nil {
				return nil, err
			}
			name, _ := config["name"].(string)
			value, err := runOne(index, config, sharedContext)
			if err != nil {
				failed := map[string]any{
					"index": index, "name": name, "status": "failed",
					"error": map[string]any{"message": err.Error()},
				}
				results = append(results, failed)
				emit("multi_agent.agent.failed", failed)
				if !continueOnError {
					return nil, err
				}
				continue
			}
			results = append(results, value)
			sharedContext[fmt.Sprintf("agent_%d", index+1)] = map[string]any{"output": value["result"]}
			sharedContext[name] = map[string]any{"output": value["result"]}
			emit("multi_agent.agent.completed", value)
		}
	}

	finalAnswer := aggregateCrewResults(results, aggregation)
	emit("multi_agent.completed", map[string]any{
		"mode": mode, "aggregation": aggregation, "count": len(results),
		"finalAnswer": finalAnswer, "agents": results,
	})
	return map[string]any{
		"mode": mode, "aggregation": aggregation, "count": len(results),
		"finalAnswer": finalAnswer, "agents": results,
	}, nil
}

// resolveCrewAgentConfig merges one agent entry with the node-level
// defaults and renders its goal against {context, previousAgents} —
// the late-bound scope with the strict-policy hook applied here.
func resolveCrewAgentConfig(in Input, raw any, index int, sharedContext map[string]any, results []any) (map[string]any, error) {
	agent, _ := raw.(map[string]any)
	if agent == nil {
		agent = map[string]any{}
	}
	merged := map[string]any{}
	for key, value := range agent {
		merged[key] = value
	}
	if merged["name"] == nil {
		merged["name"] = fmt.Sprintf("agent_%d", index+1)
	}
	if merged["planner"] == nil {
		if planner, ok := in.Config["planner"]; ok {
			merged["planner"] = planner
		}
	}
	if merged["maxSteps"] == nil {
		if steps, ok := in.Config["maxSteps"]; ok {
			merged["maxSteps"] = steps
		} else {
			merged["maxSteps"] = float64(2)
		}
	}
	if merged["reflection"] == nil {
		if reflection, ok := in.Config["reflection"]; ok {
			merged["reflection"] = reflection
		} else {
			merged["reflection"] = true
		}
	}
	goal := merged["goal"]
	if goal == nil {
		goal = in.Config["goal"]
	}
	if goal == nil {
		goal = "Complete the task"
	}
	rendered, err := grammar.RenderTemplateWithRedactions(goal, map[string]any{
		"context":        sharedContext,
		"previousAgents": results,
	}, grammar.RenderOptions{})
	if err != nil {
		return nil, err
	}
	if len(rendered.UnresolvedPaths) > 0 && in.ReportUnresolved != nil {
		// The late-bound strict-policy hook: a strict template policy
		// fails here, BEFORE the agent runs on a missing value.
		if err := in.ReportUnresolved(rendered.UnresolvedPaths); err != nil {
			return nil, err
		}
	}
	merged["goal"] = fmt.Sprint(rendered.Rendered)
	return merged, nil
}

// aggregateCrewResults ports the reference strategies verbatim.
func aggregateCrewResults(results []any, strategy string) any {
	resultOf := func(item any) map[string]any {
		entry, _ := item.(map[string]any)
		if entry == nil {
			return nil
		}
		result, _ := entry["result"].(map[string]any)
		return result
	}
	answerOf := func(item any) any {
		result := resultOf(item)
		if result == nil {
			return nil
		}
		if answer, ok := result["finalAnswer"]; ok && answer != nil && answer != "" {
			return answer
		}
		if final, ok := result["finalResult"]; ok {
			return final
		}
		return nil
	}
	switch strategy {
	case "all":
		return results
	case "first":
		if len(results) == 0 {
			return nil
		}
		if answer := answerOf(results[0]); answer != nil {
			return answer
		}
		return results[0]
	case "best-effort":
		for _, item := range results {
			if entry, ok := item.(map[string]any); ok && entry["status"] != "failed" {
				if answer := answerOf(item); answer != nil {
					return answer
				}
			}
		}
		if len(results) > 0 {
			return resultOf(results[len(results)-1])
		}
		return nil
	default: // "last"
		if len(results) == 0 {
			return nil
		}
		return answerOf(results[len(results)-1])
	}
}

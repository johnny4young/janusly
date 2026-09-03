package executors

import (
	"context"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/johnny4young/janusly/internal/tools"
)

func TestAgentWriteToolsFailClosedWithoutDispatchAuthority(t *testing.T) {
	registry := tools.NewRegistry()
	fired := false
	registry.Register(tools.Definition{
		Name: "test.mutate", WriteSide: true,
		Execute: func(context.Context, map[string]any) (map[string]any, error) {
			fired = true
			return map[string]any{"changed": true}, nil
		},
	})
	execute := NewAgentExecutor(registry, nil)
	config := map[string]any{
		"planner": "rules", "tool": "test.mutate", "maxSteps": float64(agentMaxSteps),
	}

	output, err := execute(context.Background(), Input{Config: config})
	if err != nil {
		t.Fatalf("denied write: %v", err)
	}
	if fired {
		t.Fatal("write tool executed without dispatcher authority")
	}
	result := output.(map[string]any)["finalResult"].(map[string]any)
	if result["ok"] != false || result["error"] != "agent_write_not_authorized" {
		t.Fatalf("denied envelope: %+v", result)
	}
	if steps := output.(map[string]any)["steps"].([]map[string]any); len(steps) != 1 {
		t.Fatalf("stable write denial must terminate after one decision: %+v", steps)
	}

	fired = false
	_, err = execute(context.Background(), Input{
		Config: config, AgentWritesAuthorized: true,
	})
	if err != nil {
		t.Fatalf("authorized write: %v", err)
	}
	if !fired {
		t.Fatal("authorized write tool did not execute")
	}
}

func TestAgentRulePlannerRejectsOversizedInputBeforeToolDispatch(t *testing.T) {
	registry := tools.NewRegistry()
	var calls atomic.Int32
	registry.Register(tools.Definition{
		Name: "test.inspect", Local: true,
		Execute: func(context.Context, map[string]any) (map[string]any, error) {
			calls.Add(1)
			return map[string]any{"inspected": true}, nil
		},
	})
	output, err := NewAgentExecutor(registry, nil)(context.Background(), Input{
		Config: map[string]any{
			"planner": "rules", "tool": "test.inspect", "maxSteps": float64(agentMaxSteps),
			"input": map[string]any{"blob": strings.Repeat("x", agentPlanInputMaxBytes+1)},
		},
	})
	if err != nil {
		t.Fatalf("oversized plan: %v", err)
	}
	if calls.Load() != 0 {
		t.Fatalf("oversized input reached tool %d time(s)", calls.Load())
	}
	result := output.(map[string]any)
	steps := result["steps"].([]map[string]any)
	if len(steps) != 1 {
		t.Fatalf("rejected invariant input repeated: %+v", steps)
	}
	plan := steps[0]["plan"].(AgentPlan)
	if len(plan.Input) != 0 {
		t.Fatalf("rejected input survived into step history: %+v", plan.Input)
	}
	final := result["finalResult"].(map[string]any)
	if final["error"] != "agent_tool_input_too_large" || final["maxBytes"] != agentPlanInputMaxBytes {
		t.Fatalf("rejection envelope: %+v", final)
	}
}

func TestAgentStableHTTPRequestAndDryRunDenialsTerminateAfterOneStep(t *testing.T) {
	registry := tools.NewRegistry()
	var writes atomic.Int32
	registry.Register(tools.Definition{
		Name: "test.mutate", WriteSide: true,
		Execute: func(context.Context, map[string]any) (map[string]any, error) {
			writes.Add(1)
			return map[string]any{"changed": true}, nil
		},
	})

	tests := []struct {
		name string
		in   Input
		key  string
		want any
	}{
		{
			name: "unbound HTTP target",
			in: Input{Config: map[string]any{
				"planner": "rules", "tool": "http.request", "maxSteps": float64(agentMaxSteps),
				"input": map[string]any{"url": "https://invented.example", "method": "GET"},
			}},
			key: "error", want: "agent_http_url_not_authorized",
		},
		{
			name: "validation write",
			in: Input{
				Config: map[string]any{
					"planner": "rules", "tool": "test.mutate", "maxSteps": float64(agentMaxSteps),
				},
				DryRun: true, AgentWritesAuthorized: true,
			},
			key: "skipped", want: true,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			output, err := NewAgentExecutor(registry, nil)(context.Background(), test.in)
			if err != nil {
				t.Fatalf("execute: %v", err)
			}
			result := output.(map[string]any)
			steps := result["steps"].([]map[string]any)
			if len(steps) != 1 {
				t.Fatalf("stable denial repeated across step budget: %+v", steps)
			}
			final := result["finalResult"].(map[string]any)
			if final[test.key] != test.want {
				t.Fatalf("denial envelope: %+v", final)
			}
		})
	}
	if writes.Load() != 0 {
		t.Fatalf("stable denial dispatched %d writes", writes.Load())
	}
}

func TestAgentAuthorizedWriteAttemptExecutesAtMostOnce(t *testing.T) {
	registry := tools.NewRegistry()
	var calls atomic.Int32
	registry.Register(tools.Definition{
		Name: "test.mutate", WriteSide: true,
		Execute: func(context.Context, map[string]any) (map[string]any, error) {
			calls.Add(1)
			return map[string]any{"changed": true}, nil
		},
	})
	output, err := NewAgentExecutor(registry, nil)(context.Background(), Input{
		Config: map[string]any{
			"planner": "rules", "tool": "test.mutate", "maxSteps": float64(3),
		},
		AgentWritesAuthorized: true,
	})
	if err != nil {
		t.Fatalf("authorized write: %v", err)
	}
	steps := output.(map[string]any)["steps"].([]map[string]any)
	if calls.Load() != 1 || len(steps) != 1 {
		t.Fatalf("deterministic write repeated: calls=%d steps=%+v", calls.Load(), steps)
	}
}

func TestParallelMultiAgentSharesOneWriteAttemptBudget(t *testing.T) {
	registry := tools.NewRegistry()
	var calls atomic.Int32
	registry.Register(tools.Definition{
		Name: "test.mutate", WriteSide: true,
		Execute: func(context.Context, map[string]any) (map[string]any, error) {
			calls.Add(1)
			return map[string]any{"changed": true}, nil
		},
	})
	agent := func(name string) map[string]any {
		return map[string]any{
			"name": name, "goal": "Apply the authorized test mutation once",
			"planner": "rules", "tool": "test.mutate",
			"maxSteps": float64(3),
		}
	}
	output, err := NewMultiAgentExecutor(registry, nil)(context.Background(), Input{
		Config: map[string]any{
			"mode": "parallel", "aggregation": "all",
			"agents": []any{agent("first"), agent("second")},
		},
		AgentWritesAuthorized: true,
	})
	if err != nil {
		t.Fatalf("parallel crew: %v", err)
	}
	if calls.Load() != 1 {
		t.Fatalf("parallel crew dispatched %d writes, want exactly one", calls.Load())
	}
	agents := output.(map[string]any)["agents"].([]any)
	exhausted := 0
	for _, raw := range agents {
		entry := raw.(map[string]any)
		result := entry["result"].(map[string]any)
		steps := result["steps"].([]map[string]any)
		if len(steps) != 1 {
			t.Fatalf("write child must terminate after one decision: %+v", steps)
		}
		stepResult := steps[0]["result"].(map[string]any)
		if stepResult["error"] == "agent_write_budget_exhausted" {
			exhausted++
		}
	}
	if exhausted != 1 {
		t.Fatalf("one sibling must receive the bounded denial, got %d: %+v", exhausted, agents)
	}
}

func TestAgentHTTPRequestUsesClosedMethodAuthority(t *testing.T) {
	calls := 0
	httpExec := func(_ context.Context, in Input) (any, error) {
		calls++
		return map[string]any{"method": in.Config["method"]}, nil
	}
	execute := NewAgentExecutor(tools.NewRegistry(), httpExec)
	run := func(method string, authorized bool) map[string]any {
		t.Helper()
		output, err := execute(context.Background(), Input{
			Config: map[string]any{
				"planner": "rules", "tool": "http.request", "maxSteps": float64(1),
				"input": map[string]any{"url": "https://example.com", "method": method},
			},
			AgentWritesAuthorized: authorized,
			AgentAllowedHTTPRequests: map[string]map[string]any{
				"https://example.com": {"url": "https://example.com", "method": method},
			},
		})
		if err != nil {
			t.Fatalf("execute %s: %v", method, err)
		}
		return output.(map[string]any)["finalResult"].(map[string]any)
	}

	if result := run("GET", false); result["ok"] != true || calls != 1 {
		t.Fatalf("read must execute without write authority: result=%+v calls=%d", result, calls)
	}
	if result := run("POST", false); result["error"] != "agent_write_not_authorized" || calls != 1 {
		t.Fatalf("POST must be denied: result=%+v calls=%d", result, calls)
	}
	if result := run("PROPFIND", false); result["error"] != "agent_write_not_authorized" || calls != 1 {
		t.Fatalf("unknown method must fail closed: result=%+v calls=%d", result, calls)
	}
	if result := run("POST", true); result["ok"] != true || calls != 2 {
		t.Fatalf("authorized POST must execute once: result=%+v calls=%d", result, calls)
	}
}

func TestAgentHTTPExecutesAuthoredRequestNotModelFields(t *testing.T) {
	var received map[string]any
	httpExec := func(_ context.Context, in Input) (any, error) {
		received = in.Config
		return map[string]any{"status": float64(200)}, nil
	}
	in := Input{
		AgentWritesAuthorized: true,
		AgentAllowedHTTPRequests: map[string]map[string]any{
			"https://example.com/case": {
				"url": "https://example.com/case", "method": "POST",
				"headers": map[string]any{"Authorization": "Bearer authored"},
				"body":    map[string]any{"status": "acknowledged"},
			},
		},
	}
	plan := AgentPlan{Tool: "http.request", Input: map[string]any{
		"url": "https://example.com/case", "method": "DELETE",
		"headers": map[string]any{"X-Exfiltrate": "model-chosen"},
	}}
	result := executeAgentTool(context.Background(), in, plan, map[string]any{}, tools.NewRegistry(), httpExec)
	if result["ok"] != true {
		t.Fatalf("request: %+v", result)
	}
	if received["method"] != "POST" || received["body"].(map[string]any)["status"] != "acknowledged" {
		t.Fatalf("executor did not use authored request: %+v", received)
	}
	if _, leaked := received["headers"].(map[string]any)["X-Exfiltrate"]; leaked {
		t.Fatalf("model-produced header reached egress: %+v", received)
	}
}

func TestAgentPlannerCannotExposeAuthoredWriteAsModelLabeledRead(t *testing.T) {
	calls := 0
	httpExec := func(_ context.Context, _ Input) (any, error) {
		calls++
		return map[string]any{"status": float64(200)}, nil
	}
	client := &captureAIClient{reply: `{"tool":"http.request","input":{"url":"https://example.com/case","method":"GET"},"reason":"inspect"}`}
	execute := NewAgentExecutor(NewToolRegistry(), httpExec)
	allowed := map[string]map[string]any{
		"https://example.com/case": {
			"url": "https://example.com/case", "method": "POST",
			"body": map[string]any{"status": "acknowledged"},
		},
	}
	if !agentPlanWriteSide(NewToolRegistry(), AgentPlan{Tool: "http.request", Input: map[string]any{
		"url": "https://example.com/case", "method": "GET",
	}}, allowed) {
		t.Fatal("write classification must use the authored POST rather than the model's GET label")
	}
	output, err := execute(context.Background(), Input{
		Config: map[string]any{
			"planner": "ai", "maxSteps": float64(1),
		},
		AI:                       &AIDeps{Client: client},
		AgentAllowedHTTPRequests: allowed,
	})
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	steps := output.(map[string]any)["steps"].([]map[string]any)
	plan := steps[0]["plan"].(AgentPlan)
	if plan.Mode != "fallback" || plan.AiError != "LLM planner did not return an available tool" || calls != 0 {
		t.Fatalf("unauthorized authored POST leaked into planner authority: plan=%+v calls=%d", plan, calls)
	}
}

func TestAgentPlannerProjectionHasOneMethodSensitiveHTTPTool(t *testing.T) {
	registry := NewToolRegistry()
	readRequest := map[string]map[string]any{
		"https://example.com": {"url": "https://example.com", "method": "GET"},
	}
	readOnly := plannerToolsWithHTTP(registry, false, false, readRequest)
	httpCount := 0
	for _, entry := range readOnly {
		name, _ := entry["name"].(string)
		if name == "http.request" {
			httpCount++
			if entry["writeSide"] != false || entry["methodSensitive"] != true || entry["writeAuthorized"] != false {
				t.Fatalf("read-only HTTP capability metadata: %+v", entry)
			}
		}
		if name == "email.send" {
			t.Fatal("unauthorized static write tool leaked into the planner catalog")
		}
	}
	if httpCount != 1 {
		t.Fatalf("planner must expose exactly one http.request, got %d", httpCount)
	}

	writeRequest := map[string]map[string]any{
		"https://example.com": {"url": "https://example.com", "method": "POST"},
	}
	unauthorizedWrite := plannerToolsWithHTTP(registry, false, false, writeRequest)
	for _, entry := range unauthorizedWrite {
		if entry["name"] == "http.request" {
			t.Fatal("unauthorized authored HTTP write must be absent from the planner catalog")
		}
	}

	authorized := plannerToolsWithHTTP(registry, false, true, writeRequest)
	foundWrite := false
	foundHTTPWrite := false
	for _, entry := range authorized {
		if entry["name"] == "email.send" {
			foundWrite = true
		}
		if entry["name"] == "http.request" && entry["writeSide"] == true && entry["writeAuthorized"] == true {
			foundHTTPWrite = true
		}
	}
	if !foundWrite || !foundHTTPWrite {
		t.Fatal("authorized planner catalog must include static and authored HTTP writes")
	}
	withoutTarget := plannerToolsWithHTTP(registry, false, true, nil)
	for _, entry := range withoutTarget {
		if entry["name"] == "http.request" {
			t.Fatal("http.request must be absent without a literal workflow target")
		}
	}
}

func TestAgentExecutionBoundsFailClosed(t *testing.T) {
	execute := NewAgentExecutor(tools.NewRegistry(), nil)
	for _, config := range []map[string]any{
		{"maxSteps": float64(51)},
		{"maxSteps": 1.5},
		{"maxSteps": "50"},
		{"timeoutMs": float64(agentMaxTimeoutMs + 1)},
		{"timeoutMs": 1.5},
		{"planner": "untrusted"},
		{"planner": float64(1)},
	} {
		if _, err := execute(context.Background(), Input{Config: config}); err == nil {
			t.Fatalf("invalid agent config must fail before allocating or planning: %+v", config)
		}
	}
}

func TestMultiAgentExecutionBoundsFailClosed(t *testing.T) {
	execute := NewMultiAgentExecutor(tools.NewRegistry(), nil)
	tooMany := make([]any, multiAgentMaxAgents+1)
	for index := range tooMany {
		tooMany[index] = map[string]any{"goal": "bounded"}
	}
	for _, config := range []map[string]any{
		{"agents": "not-an-array"},
		{"agents": tooMany},
		{"mode": "unordered"},
		{"mode": float64(1)},
		{"agents": []any{"not-an-object"}},
		{"agents": []any{map[string]any{"maxSteps": float64(agentMaxSteps + 1)}}},
	} {
		if _, err := execute(context.Background(), Input{Config: config}); err == nil {
			t.Fatalf("invalid multi-agent config must fail before spawning work: %+v", config)
		}
	}
}

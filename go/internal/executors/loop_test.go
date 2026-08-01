package executors

import (
	"context"
	"strings"
	"testing"

	"github.com/johnny4young/janusly/go/internal/tools"
)

func loopInput(config map[string]any, dryRun bool) (Input, *[]string) {
	events := &[]string{}
	return Input{
		RunID: "run-loop", NodeID: "loop", Config: config,
		Context: map[string]any{}, DryRun: dryRun,
		Emit: func(eventType string, _ map[string]any) string {
			*events = append(*events, eventType)
			return ""
		},
	}, events
}

// for_each through the SAME tool interception ladder as the tool node:
// ordered results, dry-run write-side skip, bounds, and the exactly-one
// failure budget contract.
func TestForEachLoopExecutor(t *testing.T) {
	registry := tools.NewRegistry()
	loop := NewLoopExecutor(registry)

	// Ordered success across a concurrent pool.
	in, events := loopInput(map[string]any{
		"mode": "for_each", "tool": "text.uppercase",
		"items": []any{"a", "b", "c"}, "concurrency": 2.0,
		"input": map[string]any{"value": "{{item}}"},
	}, false)
	output, err := loop(context.Background(), in)
	if err != nil {
		t.Fatalf("happy path: %v", err)
	}
	result := output.(map[string]any)
	if result["succeededCount"] != 3 || result["failedCount"] != 0 {
		t.Fatalf("counts: %+v", result)
	}
	items := result["items"].([]any)
	first := items[0].(map[string]any)["result"].(map[string]any)
	if first["value"] != "A" || items[2].(map[string]any)["result"].(map[string]any)["value"] != "C" {
		t.Fatalf("ordered per-item results: %+v", items)
	}
	if !contains(*events, "loop.for_each.started") || !contains(*events, "loop.completed") {
		t.Fatalf("events: %v", *events)
	}

	// {ok:false} envelopes count as failures; one tolerated failure passes.
	in, _ = loopInput(map[string]any{
		"mode": "for_each", "tool": "json.parse",
		"items": []any{"not json", `{"a":1}`},
		"input": map[string]any{"value": "{{item}}"}, "toleratedFailureCount": 1.0,
	}, false)
	output, err = loop(context.Background(), in)
	if err != nil {
		t.Fatalf("tolerated budget: %v", err)
	}
	result = output.(map[string]any)
	if result["failedCount"] != 1 || result["succeededCount"] != 1 {
		t.Fatalf("mixed outcome: %+v", result)
	}
	failures := result["failures"].([]any)
	if len(failures) != 1 || failures[0].(map[string]any)["index"] != 0 {
		t.Fatalf("failure sample: %+v", failures)
	}

	// No budget declared → a single failure breaches; write-side tool marks
	// the error so the engine refuses whole-node retries.
	in, events = loopInput(map[string]any{
		"mode": "for_each", "tool": "vector.upsert",
		"items": []any{"x"}, "input": map[string]any{"content": "{{item}}"},
	}, false)
	_, err = loop(context.Background(), in)
	shape, ok := err.(*ExecErrorShape)
	if !ok || shape.Code != "LOOP_FAILURE_BUDGET_EXCEEDED" || !shape.WriteSide {
		t.Fatalf("write-side budget breach: %+v", err)
	}
	if !contains(*events, "loop.failure_budget.exceeded") {
		t.Fatalf("budget event missing: %v", *events)
	}

	// Dry-run skips the write side cooperatively — zero external effects.
	in, events = loopInput(map[string]any{
		"mode": "for_each", "tool": "webhook.send",
		"items": []any{"a", "b"},
		"input": map[string]any{"credential": "c", "url": "https://x.example", "payload": map[string]any{}},
	}, true)
	output, err = loop(context.Background(), in)
	if err != nil {
		t.Fatalf("dry run: %v", err)
	}
	result = output.(map[string]any)
	if result["skippedCount"] != 2 || result["failedCount"] != 0 {
		t.Fatalf("dry-run skip: %+v", result)
	}
	if !contains(*events, "loop.dry_run.skipped") {
		t.Fatalf("dry-run event missing: %v", *events)
	}

	// Config guards: both budgets, bad concurrency, missing tool.
	for label, config := range map[string]map[string]any{
		"both budgets": {"mode": "for_each", "tool": "text.uppercase", "items": []any{"a"},
			"toleratedFailureCount": 1.0, "toleratedFailurePercentage": 10.0},
		"bad concurrency": {"mode": "for_each", "tool": "text.uppercase", "items": []any{"a"},
			"concurrency": 21.0},
		"missing tool": {"mode": "for_each", "items": []any{"a"}},
	} {
		in, _ = loopInput(config, false)
		if _, err := loop(context.Background(), in); err == nil {
			t.Fatalf("%s must be rejected", label)
		}
	}

	// Strict template policy: EVERY per-item input renders before the first
	// effect — the unresolved report fires and the started event never does.
	in, events = loopInput(map[string]any{
		"mode": "for_each", "tool": "text.uppercase",
		"items": []any{"a", "b"},
		"input": map[string]any{"value": "{{context.ghost.output.missing}}"},
	}, false)
	in.ReportUnresolved = func(paths []string) error {
		if len(paths) == 0 {
			t.Fatal("unresolved paths must surface")
		}
		return &ExecErrorShape{Message: "strict template failure", Code: "TEMPLATE_STRICT"}
	}
	if _, err := loop(context.Background(), in); err == nil ||
		!strings.Contains(err.Error(), "strict template failure") {
		t.Fatalf("strict policy must fail before effects: %v", err)
	}
	if contains(*events, "loop.for_each.started") {
		t.Fatal("no effect may start before templates resolve")
	}
}

func contains(haystack []string, needle string) bool {
	for _, candidate := range haystack {
		if candidate == needle {
			return true
		}
	}
	return false
}

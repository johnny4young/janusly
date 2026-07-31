package executors

import (
	"context"
	"reflect"
	"strings"
	"testing"

	"github.com/johnny4young/janusly/go/internal/tools"
)

// The executors mirror the reference registry entries (node-registry.ts:
// noop at 1013, condition at 602, transform at 608): noop emits an empty
// output, condition emits {result: bool}, transform emits the rendered
// mapping — with `inputs.` meaning the node's OWN config in both scopes.

func TestNoopEmitsEmptyOutput(t *testing.T) {
	out, err := Registry()["noop"](context.Background(), Input{})
	if err != nil || !reflect.DeepEqual(out, map[string]any{}) {
		t.Fatalf("got %v err %v", out, err)
	}
}

func TestConditionEmitsResultBoolean(t *testing.T) {
	in := Input{
		Config: map[string]any{"expression": "context.http.output.statusCode === 200"},
		Context: map[string]any{
			"http": map[string]any{"output": map[string]any{"statusCode": float64(200)}},
		},
	}
	out, err := Registry()["condition"](context.Background(), in)
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !reflect.DeepEqual(out, map[string]any{"result": true}) {
		t.Fatalf("got %v", out)
	}

	in.Config["expression"] = "context.http.output.statusCode === 500"
	out, err = Registry()["condition"](context.Background(), in)
	if err != nil || !reflect.DeepEqual(out, map[string]any{"result": false}) {
		t.Fatalf("false branch: %v err %v", out, err)
	}
}

func TestConditionSeesOwnConfigAsInputsScope(t *testing.T) {
	in := Input{
		Config:  map[string]any{"expression": "inputs.threshold > 5", "threshold": float64(10)},
		Context: map[string]any{},
	}
	out, err := Registry()["condition"](context.Background(), in)
	if err != nil || !reflect.DeepEqual(out, map[string]any{"result": true}) {
		t.Fatalf("inputs scope must be the node's own config: %v err %v", out, err)
	}
}

func TestConditionErrorsOnInvalidExpression(t *testing.T) {
	in := Input{Config: map[string]any{"expression": "process.exit()"}, Context: map[string]any{}}
	_, err := Registry()["condition"](context.Background(), in)
	if err == nil || !strings.Contains(err.Error(), "Unsupported expression token") {
		t.Fatalf("invalid expression must fail the node: %v", err)
	}
}

func TestTransformRendersMappingAgainstContextAndOwnConfig(t *testing.T) {
	in := Input{
		Config: map[string]any{
			"mapping": map[string]any{
				"code":  "{{context.http.output.statusCode}}",
				"label": "status={{context.http.output.statusCode}}",
				"self":  "{{inputs.note}}",
			},
			"note": "from-config",
		},
		Context: map[string]any{
			"http": map[string]any{"output": map[string]any{"statusCode": float64(200)}},
		},
	}
	out, err := Registry()["transform"](context.Background(), in)
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	want := map[string]any{
		"code":  float64(200),
		"label": "status=200",
		"self":  "from-config",
	}
	if !reflect.DeepEqual(out, want) {
		t.Fatalf("got %#v want %#v", out, want)
	}
}

func TestTransformNilMappingYieldsEmptyObject(t *testing.T) {
	out, err := Registry()["transform"](context.Background(), Input{Config: map[string]any{}})
	if err != nil || !reflect.DeepEqual(out, map[string]any{}) {
		t.Fatalf("got %v err %v", out, err)
	}
}

// The generic sandbox gate at the tool node: ANY registered write-side
// tool skips cooperatively under DryRun; read-side tools still execute.
func TestToolNodeDryRunWriteSkip(t *testing.T) {
	registry := tools.NewRegistry()
	fired := false
	registry.Register(tools.Definition{
		Name: "test.mutate", Description: "test write",
		Required: []string{}, Fields: []tools.Field{},
		WriteSide: true,
		Execute: func(ctx context.Context, input map[string]any) (map[string]any, error) {
			fired = true
			return map[string]any{"ok": true}, nil
		},
	})
	exec := NewToolExecutor(registry)

	output, err := exec(context.Background(), Input{
		Config: map[string]any{"tool": "test.mutate"}, DryRun: true,
	})
	if err != nil {
		t.Fatalf("dry-run write tool: %v", err)
	}
	result := output.(map[string]any)["result"].(map[string]any)
	if result["skipped"] != true || result["reason"] != "validation_dry_run" || fired {
		t.Fatalf("write-side tool must skip in dry-run: %+v fired=%v", result, fired)
	}

	// Without DryRun the same tool fires.
	if _, err := exec(context.Background(), Input{
		Config: map[string]any{"tool": "test.mutate"},
	}); err != nil || !fired {
		t.Fatalf("production must fire: %v fired=%v", err, fired)
	}

	// A read-side tool executes even in dry-run (real validation signal).
	readOutput, err := exec(context.Background(), Input{
		Config: map[string]any{"tool": "text.uppercase", "input": map[string]any{"value": "hola"}},
		DryRun: true,
	})
	if err != nil {
		t.Fatalf("read-side dry-run: %v", err)
	}
	readResult := readOutput.(map[string]any)["result"].(map[string]any)
	if readResult["skipped"] == true {
		t.Fatalf("read-side must execute in dry-run: %+v", readResult)
	}
}

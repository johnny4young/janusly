package executors

import (
	"context"
	"reflect"
	"strings"
	"testing"
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

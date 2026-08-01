package tools

import (
	"context"
	"reflect"
	"strings"
	"testing"
)

// Cases port packages/engine/src/tools/json.ts semantics, including the
// prototype-pollution guards.

func execute(t *testing.T, name string, input map[string]any) (map[string]any, error) {
	t.Helper()
	return NewRegistry().Execute(context.Background(), name, input)
}

func TestJSONParseRoundTripsAndRejectsGarbage(t *testing.T) {
	out, err := execute(t, "json.parse", map[string]any{"value": `{"customer":{"id":42}}`})
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	customer := out["value"].(map[string]any)["customer"].(map[string]any)
	if customer["id"] != float64(42) {
		t.Fatalf("parsed shape: %v", out)
	}
	if _, err := execute(t, "json.parse", map[string]any{"value": "{broken"}); err == nil ||
		err.Error() != "json.parse received invalid JSON" {
		t.Fatalf("invalid JSON message parity: %v", err)
	}
}

func TestJSONPickWalksDottedPaths(t *testing.T) {
	source := map[string]any{"fetch": map[string]any{"output": map[string]any{"statusCode": float64(200)}}}
	out, _ := execute(t, "json.pick", map[string]any{"source": source, "path": "fetch.output.statusCode"})
	if out["value"] != float64(200) {
		t.Fatalf("pick: %v", out)
	}
	missing, _ := execute(t, "json.pick", map[string]any{"source": source, "path": "fetch.ghost.x"})
	if missing["value"] != nil {
		t.Fatalf("absent path must read nil: %v", missing)
	}
}

func TestJSONSetCopiesAndRefusesPrototypePaths(t *testing.T) {
	source := map[string]any{"user": map[string]any{"id": float64(1)}}
	out, err := execute(t, "json.set", map[string]any{
		"source": source, "path": "user.name", "value": "Ada",
	})
	if err != nil {
		t.Fatalf("set: %v", err)
	}
	user := out["value"].(map[string]any)["user"].(map[string]any)
	if user["name"] != "Ada" || user["id"] != float64(1) {
		t.Fatalf("set must merge into a copy: %v", out)
	}
	// The caller's map must not be mutated.
	if _, leaked := source["user"].(map[string]any)["name"]; leaked {
		t.Fatal("json.set must never mutate the caller's source")
	}
	if _, err := execute(t, "json.set", map[string]any{
		"source": source, "path": "__proto__.polluted", "value": true,
	}); err == nil || !strings.Contains(err.Error(), "refuses prototype-targeting") {
		t.Fatalf("prototype guard: %v", err)
	}
}

func TestJSONMergeIsDeepAndArrayReplacing(t *testing.T) {
	out, _ := execute(t, "json.merge", map[string]any{
		"a": map[string]any{"user": map[string]any{"id": float64(1)}, "tags": []any{"a"}},
		"b": map[string]any{"user": map[string]any{"name": "Ada"}, "tags": []any{"b"}},
	})
	value := out["value"].(map[string]any)
	user := value["user"].(map[string]any)
	if user["id"] != float64(1) || user["name"] != "Ada" {
		t.Fatalf("deep merge: %v", value)
	}
	if !reflect.DeepEqual(value["tags"], []any{"b"}) {
		t.Fatalf("arrays replace wholesale: %v", value["tags"])
	}
}

func TestRegistryValidationAndCatalog(t *testing.T) {
	if _, err := execute(t, "json.set", map[string]any{"path": "x"}); err == nil ||
		!strings.Contains(err.Error(), "Invalid tool input for json.set") {
		t.Fatalf("missing required field must fail with the reference shape: %v", err)
	}
	if _, err := execute(t, "ghost.tool", map[string]any{}); err == nil ||
		err.Error() != "Unknown tool: ghost.tool" {
		t.Fatalf("unknown tool: %v", err)
	}
	// 4 json tools + 3 buffered csv tools + vector pair + text.uppercase
	// + webhook.send (integration chokepoint); csv.fetch registers from
	// the executors package on top of this base set.
	catalog := NewRegistry().Catalog()
	if len(catalog) != 11 {
		t.Fatalf("catalog size: %d", len(catalog))
	}
	first := catalog[0]
	for _, key := range []string{"name", "description", "required", "inputFields", "writeSide"} {
		if _, present := first[key]; !present {
			t.Fatalf("catalog entry missing %s: %v", key, first)
		}
	}
	if first["writeSide"] != false {
		t.Fatal("json tools are read-side")
	}
}

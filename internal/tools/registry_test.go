package tools

import (
	"context"
	"encoding/json"
	"math"
	"reflect"
	"strings"
	"testing"
)

// Cases port the source contract semantics, including the
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
		!strings.Contains(err.Error(), "value must contain valid JSON") {
		t.Fatalf("invalid JSON message consistency: %v", err)
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
	}); err == nil || !strings.Contains(err.Error(), "forbidden segment") {
		t.Fatalf("prototype guard: %v", err)
	}
}

func TestJSONToolsRejectAmbiguousOrUnboundedValues(t *testing.T) {
	registry := NewRegistry()
	if err := registry.ValidateInput("json.set", map[string]any{
		"path": "{{context.target.output.path}}", "value": "{{context.target.output.value}}",
		"source": "{{context.source.output.value}}",
	}); err != nil {
		t.Fatalf("deferred native JSON bindings should validate at authoring time: %v", err)
	}

	deep := any("leaf")
	for range jsonToolMaxDepth + 1 {
		deep = map[string]any{"next": deep}
	}
	left := map[string]any{"a": strings.Repeat("x", jsonToolMaxBytes/2+1)}
	right := map[string]any{"b": strings.Repeat("y", jsonToolMaxBytes/2+1)}
	tests := []struct {
		name    string
		tool    string
		input   map[string]any
		message string
	}{
		{name: "empty path", tool: "json.pick", input: map[string]any{"path": ""}, message: "trimmed non-empty"},
		{name: "empty path segment", tool: "json.set", input: map[string]any{"path": "a..b", "value": true}, message: "must not be empty"},
		{name: "prototype in source", tool: "json.set", input: map[string]any{"path": "safe", "value": true, "source": map[string]any{"nested": map[string]any{"constructor": "x"}}}, message: "forbidden object key"},
		{name: "prototype in merge left", tool: "json.merge", input: map[string]any{"a": map[string]any{"__proto__": true}, "b": map[string]any{}}, message: "forbidden object key"},
		{name: "excess depth", tool: "json.set", input: map[string]any{"path": "safe", "value": deep}, message: "nesting exceeds"},
		{name: "oversized parse", tool: "json.parse", input: map[string]any{"value": `"` + strings.Repeat("x", jsonToolMaxBytes) + `"`}, message: "JSON text exceeds"},
		{name: "trailing document", tool: "json.parse", input: map[string]any{"value": `{}` + " true"}, message: "exactly one JSON document"},
		{name: "oversized merge result", tool: "json.merge", input: map[string]any{"a": left, "b": right}, message: "result: JSON value exceeds"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := registry.ValidateInput(test.tool, test.input)
			if err == nil || !strings.Contains(err.Error(), test.message) {
				t.Fatalf("expected %q rejection, got %v", test.message, err)
			}
		})
	}

	if got := pickByPath([]any{"zero", "one"}, "1junk"); got != nil {
		t.Fatalf("array index parsing must consume the whole segment, got %#v", got)
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
		t.Fatalf("missing required field must fail with the contract shape: %v", err)
	}
	if _, err := execute(t, "ghost.tool", map[string]any{}); err == nil ||
		err.Error() != "Unknown tool: ghost.tool" {
		t.Fatalf("unknown tool: %v", err)
	}
	// 4 json tools + 3 buffered csv tools + vector pair + text.uppercase
	// + webhook.send + github.create_issue + slack.post + email.send + pdf.generate
	// + sheet.append (integration chokepoint)
	// + time.now/time.window + 5 pagerduty.* + 4 db.*; csv.fetch registers from the
	// executors package on top of this base set.
	catalog := NewRegistry().Catalog()
	if len(catalog) != 27 {
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
	var github map[string]any
	for _, entry := range catalog {
		if entry["name"] == "github.create_issue" {
			github = entry
			break
		}
	}
	if github == nil || github["writeSide"] != true {
		t.Fatalf("github.create_issue catalog entry: %+v", github)
	}
	encoded, _ := json.Marshal(github["inputFields"])
	if !strings.Contains(string(encoded), `"kind":"string"`) || strings.Contains(string(encoded), `"type":`) {
		t.Fatalf("inputFields must use the contract kind wire: %s", encoded)
	}
}

func TestRegistryValidatesPresentFieldTypesInStrictAndPartialModes(t *testing.T) {
	registry := NewRegistry()
	validPolicy := map[string]any{
		"eventType": "incident.triggered", "occurredAt": "2026-01-10T03:00:00Z",
		"receivedAt": "2026-01-10T03:00:01Z", "evaluatedAt": "2026-01-10T03:00:02Z",
		"incident": map[string]any{
			"id": "P1", "status": "triggered", "assignedUserIds": []any{"PU1"}, "pendingActions": []any{},
		}, "pagerDutyUserId": "PU1",
		"snoozeSeconds": float64(43_200), "timeZone": "UTC",
		"workingHours": []any{map[string]any{"days": []any{1.0}, "start": "09:00", "end": "17:00"}},
	}
	if err := registry.ValidateInput("pagerduty.policy.evaluate", validPolicy); err != nil {
		t.Fatalf("valid typed policy input: %v", err)
	}

	for _, test := range []struct {
		name  string
		tool  string
		input map[string]any
		want  string
	}{
		{name: "string", tool: "text.uppercase", input: map[string]any{"value": true}, want: "value: Expected string"},
		{name: "boolean", tool: "csv.parse", input: map[string]any{"hasHeader": "yes"}, want: "hasHeader: Expected boolean"},
		{name: "object", tool: "json.pick", input: map[string]any{"source": []any{}}, want: "source: Expected object"},
		{name: "array", tool: "sheet.append", input: map[string]any{"rows": map[string]any{}}, want: "rows: Expected array"},
		{name: "number text", tool: "pagerduty.incident.snooze", input: map[string]any{"durationSeconds": "43200"}, want: "durationSeconds: Expected number"},
		{name: "number nan", tool: "pagerduty.incident.snooze", input: map[string]any{"durationSeconds": math.NaN()}, want: "durationSeconds: Expected number"},
		{name: "nil required", tool: "text.uppercase", input: map[string]any{"value": nil}, want: "value: Expected string"},
	} {
		t.Run(test.name, func(t *testing.T) {
			err := registry.ValidatePartialInput(test.tool, test.input)
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("partial type validation = %v, want %q", err, test.want)
			}
		})
	}

	if err := registry.ValidatePartialInput("text.uppercase", map[string]any{}); err != nil {
		t.Fatalf("partial validation must permit missing required values: %v", err)
	}
	if err := registry.ValidateInput("text.uppercase", map[string]any{}); err == nil ||
		!strings.Contains(err.Error(), "value: Required") {
		t.Fatalf("strict validation must retain required-field contract: %v", err)
	}
}

func TestRegistryRejectsUnknownInputFieldsDeterministically(t *testing.T) {
	registry := NewRegistry()
	err := registry.ValidatePartialInput("text.uppercase", map[string]any{
		"value": "hello", "zeta": true, "alpha": "unexpected",
	})
	if err == nil || !strings.Contains(err.Error(), "alpha: Unsupported field, zeta: Unsupported field") {
		t.Fatalf("unknown fields must reject in stable order: %v", err)
	}
}

func TestRegistryUnderstandsWholeTemplateReferenceTypes(t *testing.T) {
	registry := NewRegistry()
	for _, test := range []struct {
		name  string
		tool  string
		input map[string]any
	}{
		{name: "dynamic object", tool: "json.pick", input: map[string]any{"source": "{{context.fetch.output.payload}}"}},
		{name: "dynamic array", tool: "sheet.append", input: map[string]any{"rows": "{{context.prepare.output.rows}}"}},
		{name: "dynamic number", tool: "pagerduty.incident.snooze", input: map[string]any{"durationSeconds": "{{context.policy.output.snoozeSeconds}}"}},
		{name: "deferred loop item", tool: "json.pick", input: map[string]any{"source": "{{item}}"}},
		{name: "secret string", tool: "text.uppercase", input: map[string]any{"value": "{{secret.VALUE}}"}},
		{name: "env string", tool: "text.uppercase", input: map[string]any{"value": "{{env.VALUE}}"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			if err := registry.ValidatePartialInput(test.tool, test.input); err != nil {
				t.Fatalf("whole template reference rejected: %v", err)
			}
		})
	}

	for _, value := range []any{"duration={{context.policy.output.seconds}}", "{{secret.SECONDS}}", "{{env.SECONDS}}"} {
		err := registry.ValidatePartialInput("pagerduty.incident.snooze", map[string]any{"durationSeconds": value})
		if err == nil || !strings.Contains(err.Error(), "durationSeconds: Expected number") {
			t.Fatalf("string-only number reference %q was accepted: %v", value, err)
		}
	}
}

func TestRegistryRejectsNonJSONValuesForJSONFields(t *testing.T) {
	registry := NewRegistry()
	registry.Register(Definition{
		Name: "test.json", Fields: []Field{{Name: "value", Type: "json"}},
		Execute: func(context.Context, map[string]any) (map[string]any, error) { return map[string]any{}, nil },
	})
	cyclic := map[string]any{}
	cyclic["self"] = cyclic
	err := registry.ValidatePartialInput("test.json", map[string]any{"value": cyclic})
	if err == nil || !strings.Contains(err.Error(), "value: Expected json") {
		t.Fatalf("cyclic JSON value was accepted: %v", err)
	}
	registry.Register(Definition{
		Name: "test.object", Fields: []Field{{Name: "value", Type: "object"}},
		Execute: func(context.Context, map[string]any) (map[string]any, error) { return map[string]any{}, nil },
	})
	err = registry.ValidatePartialInput("test.object", map[string]any{"value": cyclic})
	if err == nil || !strings.Contains(err.Error(), "value: Expected object") {
		t.Fatalf("cyclic object value was accepted: %v", err)
	}
}

func TestPlannerJSONSchemasUseRealJSONSchemaTypes(t *testing.T) {
	registry := NewRegistry()
	var slack map[string]any
	for _, entry := range registry.PlannerTools(false) {
		if entry["name"] == "slack.post" {
			slack = entry
			break
		}
	}
	if slack == nil {
		t.Fatal("slack planner tool missing")
	}
	schema := slack["jsonSchema"].(map[string]any)
	properties := schema["properties"].(map[string]any)
	if schema["additionalProperties"] != false {
		t.Fatalf("planner schema must reject invented fields: %+v", schema)
	}
	blocks := properties["blocks"].(map[string]any)
	if blocks["type"] != "array" {
		t.Fatalf("planner array schema drifted: %+v", blocks)
	}
	encoded, err := json.Marshal(registry.PlannerTools(false))
	if err != nil || strings.Contains(string(encoded), `"type":"json"`) || strings.Contains(string(encoded), `"type":"unknown"`) {
		t.Fatalf("planner emitted invalid JSON-Schema type: err=%v schema=%s", err, encoded)
	}
}

func TestRegistryClassifiesExternalToolsConservatively(t *testing.T) {
	registry := NewRegistry()
	if !registry.Has("pagerduty.incident.get") || registry.Has("unknown.tool") {
		t.Fatal("registry presence must distinguish executable tools from conservative unknown metadata")
	}
	for _, name := range []string{"json.parse", "time.now", "pagerduty.policy.evaluate", "pagerduty.outcome.verify"} {
		if registry.IsExternal(name) {
			t.Fatalf("%s is a deterministic in-process tool", name)
		}
	}
	for _, name := range []string{"pagerduty.incident.get", "db.query.read", "vector.search", "unknown.tool"} {
		if !registry.IsExternal(name) {
			t.Fatalf("%s must retain external retry posture", name)
		}
	}
	registry.Register(Definition{Name: "extension.read"})
	registry.Register(Definition{Name: "extension.local", Local: true})
	if !registry.IsExternal("extension.read") || registry.IsExternal("extension.local") {
		t.Fatal("extension tools must default external and opt into local execution explicitly")
	}
}

func TestVectorAndTextToolsRejectUnboundedInputsAtAuthoring(t *testing.T) {
	registry := NewRegistry()
	if err := registry.ValidateInput("vector.upsert", map[string]any{
		"content":  "{{context.summary.output.text}}",
		"metadata": "{{context.summary.output.metadata}}",
	}); err != nil {
		t.Fatalf("deferred vector bindings should validate at authoring time: %v", err)
	}
	for _, test := range []struct {
		tool    string
		input   map[string]any
		message string
	}{
		{tool: "vector.search", input: map[string]any{"query": "   "}, message: "query must be non-empty"},
		{tool: "vector.upsert", input: map[string]any{"content": strings.Repeat("x", vectorTextMaxBytes+1)}, message: "content must be non-empty"},
		{tool: "vector.upsert", input: map[string]any{"content": "safe", "metadata": map[string]any{"blob": strings.Repeat("x", vectorMetadataMaxBytes)}}, message: "metadata: JSON value exceeds"},
		{tool: "text.uppercase", input: map[string]any{"value": strings.Repeat("x", jsonToolMaxBytes+1)}, message: "uppercase input or output exceeds"},
	} {
		err := registry.ValidateInput(test.tool, test.input)
		if err == nil || !strings.Contains(err.Error(), test.message) {
			t.Fatalf("%s expected %q rejection, got %v", test.tool, test.message, err)
		}
	}
}

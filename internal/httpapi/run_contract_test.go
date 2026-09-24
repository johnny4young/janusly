package httpapi

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/google/jsonschema-go/jsonschema"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/internal/contract"
	"github.com/johnny4young/janusly/internal/store"
)

func manifestResponse(t *testing.T, method, path string) contract.Schema {
	t.Helper()
	for _, route := range contract.Routes {
		if route.Method == method && route.Path == path {
			return route.Response
		}
	}
	t.Fatalf("manifest has no %s %s", method, path)
	return nil
}

func resolvedResponseSchema(t *testing.T, path string) *jsonschema.Resolved {
	t.Helper()
	return resolvedManifestSchema(t, "GET", path)
}

func resolvedManifestSchema(t *testing.T, method, path string) *jsonschema.Resolved {
	t.Helper()
	raw, err := json.Marshal(manifestResponse(t, method, path))
	if err != nil {
		t.Fatal(err)
	}
	return resolveSchemaJSON(t, raw)
}

func resolveSchemaJSON(t *testing.T, raw []byte) *jsonschema.Resolved {
	t.Helper()
	var schema jsonschema.Schema
	if err := json.Unmarshal(raw, &schema); err != nil {
		t.Fatal(err)
	}
	resolved, err := schema.Resolve(nil)
	if err != nil {
		t.Fatal(err)
	}
	return resolved
}

func requireManifestData(t *testing.T, path string, data any) {
	t.Helper()
	requireManifestDataFor(t, "GET", path, data)
}

func requireManifestDataFor(t *testing.T, method, path string, data any) {
	t.Helper()
	if err := resolvedManifestSchema(t, method, path).Validate(data); err != nil {
		t.Fatalf("%s %s wire data violates manifest: %v", method, path, err)
	}
}

func runSnapshotFixture(t *testing.T) map[string]any {
	t.Helper()
	view := RunSnapshotView{
		Run:    newRunView(store.GetRunRow{ID: "run", OrgID: "org", WorkflowVersionID: "version", Status: "running"}),
		Nodes:  []RunNodeView{{ID: "row", RunID: "run", NodeID: "node", Status: "pending"}},
		Events: []RunEventView{{ID: "event", RunID: "run", Type: "run.started"}},
	}
	raw, err := json.Marshal(view)
	if err != nil {
		t.Fatal(err)
	}
	var data map[string]any
	if err := json.Unmarshal(raw, &data); err != nil {
		t.Fatal(err)
	}
	return data
}

func TestRunSnapshotManifestMatchesTypedWire(t *testing.T) {
	for _, path := range []string{"/v1/run", "/v1/status"} {
		data := runSnapshotFixture(t)
		requireManifestData(t, path, data)
		data["nodes"], data["events"] = []any{}, []any{}
		requireManifestData(t, path, data)
		data["eventsCursor"], data["eventsHasMore"] = "2026-09-21T00:00:00.000Z|event", true
		requireManifestData(t, path, data)
	}
}

func TestRunSnapshotManifestRejectsMalformedWire(t *testing.T) {
	cases := map[string]func(map[string]any){
		"missing summary":        func(v map[string]any) { delete(v, "run") },
		"empty summary":          func(v map[string]any) { v["run"] = map[string]any{} },
		"unknown status":         func(v map[string]any) { v["run"].(map[string]any)["status"] = "complete" },
		"missing nullable key":   func(v map[string]any) { delete(v["run"].(map[string]any), "createdAt") },
		"invalid timestamp type": func(v map[string]any) { v["run"].(map[string]any)["createdAt"] = 1.0 },
		"negative count":         func(v map[string]any) { v["run"].(map[string]any)["semanticViolationCount"] = -1.0 },
		"null nodes":             func(v map[string]any) { v["nodes"] = nil },
		"incomplete event":       func(v map[string]any) { v["events"] = []any{map[string]any{"id": "event"}} },
		"missing pagination":     func(v map[string]any) { delete(v, "eventsHasMore") },
		"wrong pagination":       func(v map[string]any) { v["eventsHasMore"] = "false" },
		"fractional attempts":    func(v map[string]any) { v["nodes"].([]any)[0].(map[string]any)["attempts"] = 0.5 },
		"oversized page": func(v map[string]any) {
			event := v["events"].([]any)[0]
			events := make([]any, 501)
			for i := range events {
				events[i] = event
			}
			v["events"] = events
		},
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			data := runSnapshotFixture(t)
			mutate(data)
			if err := resolvedResponseSchema(t, "/v1/status").Validate(data); err == nil {
				t.Fatal("malformed data satisfied the status contract")
			}
		})
	}
}

func TestTypedRunNullableValuesPreserveLegacyEncoding(t *testing.T) {
	instant := time.Date(2026, 9, 21, 12, 3, 4, 567890123, time.FixedZone("offset", -5*60*60))
	for _, pair := range [][2]any{
		{nullableTextValue(pgtype.Text{}), textOrNull(pgtype.Text{})},
		{nullableTextValue(pgtype.Text{String: "", Valid: true}), textOrNull(pgtype.Text{String: "", Valid: true})},
		{nullableTimeValue(nil), timeOrNull(nil)},
		{nullableTimeValue(&instant), timeOrNull(&instant)},
		{nullableIntValue(pgtype.Int4{}), nullableInt(pgtype.Int4{})},
		{nullableIntValue(pgtype.Int4{Int32: 0, Valid: true}), nullableInt(pgtype.Int4{Int32: 0, Valid: true})},
	} {
		actual, _ := json.Marshal(pair[0])
		previous, _ := json.Marshal(pair[1])
		if string(actual) != string(previous) {
			t.Fatalf("wire changed: %s != %s", actual, previous)
		}
	}
}

package httpapi

import (
	"encoding/json"
	"reflect"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/johnny4young/janusly/internal/store"
	"github.com/johnny4young/janusly/internal/tools"
)

func listWire(t *testing.T, value any) any {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var decoded any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatal(err)
	}
	return decoded
}

func listViewFixtures() map[string]any {
	return map[string]any{
		"/v1/runs":               []RunSummaryView{newRunSummaryView(store.ListRunSummariesRow{ID: "run", OrgID: "org", WorkflowID: "workflow", Status: "running"})},
		"/v1/workflows":          []WorkflowListItemView{newWorkflowListItemView(store.ListWorkflowRowsRow{ID: "workflow", OrgID: "org", Name: "Example", Status: "active"})},
		"/v1/workflows/versions": []VersionView{newVersionView("version", "org", "workflow", 1, json.RawMessage(`{"nodes":[],"edges":[]}`), pgtype.Text{}, nil)},
		"/v1/templates":          templateCatalog,
		"/v1/tools":              tools.NewRegistry().CatalogEntries(),
	}
}

func TestListManifestMatchesTypedWire(t *testing.T) {
	for path, view := range listViewFixtures() {
		t.Run(path, func(t *testing.T) {
			requireManifestData(t, path, listWire(t, view))
			requireManifestData(t, path, []any{})
			if err := resolvedResponseSchema(t, path).Validate(nil); err == nil {
				t.Fatal("null must not be an empty page")
			}
		})
	}
	requireManifestData(t, "/v1/workflows/latest", nil)
	requireManifestData(t, "/v1/workflows/latest", listWire(t, listViewFixtures()["/v1/workflows/versions"]).([]any)[0])
}

func TestListManifestRejectsMalformedRows(t *testing.T) {
	for path, view := range listViewFixtures() {
		t.Run(path, func(t *testing.T) {
			schema := resolvedResponseSchema(t, path)
			for _, mutate := range []func(map[string]any){
				func(row map[string]any) { row["unexpectedWireKey"] = true },
				func(row map[string]any) { clear(row) },
			} {
				data := listWire(t, view).([]any)
				mutate(data[0].(map[string]any))
				if err := schema.Validate(data); err == nil {
					t.Fatal("malformed row accepted")
				}
			}
		})
	}
	for _, path := range []string{"/v1/runs", "/v1/workflows", "/v1/workflows/versions"} {
		row := listWire(t, listViewFixtures()[path]).([]any)[0]
		page := make([]any, 201)
		for i := range page {
			page[i] = row
		}
		schema := resolvedResponseSchema(t, path)
		if err := schema.Validate(page[:200]); err != nil {
			t.Fatal(err)
		}
		if err := schema.Validate(page); err == nil {
			t.Fatalf("%s accepted oversized page", path)
		}
	}
	for _, tc := range []struct {
		path, key string
		value     any
	}{
		{"/v1/runs", "status", "complete"}, {"/v1/runs", "createdAt", 1.0},
		{"/v1/workflows", "runCount", -1.0}, {"/v1/workflows", "tags", nil},
		{"/v1/workflows/versions", "version", 0.0}, {"/v1/workflows/versions", "version", 1.5},
		{"/v1/tools", "writeSide", "false"}, {"/v1/templates", "requiredCredentials", nil},
	} {
		data := listWire(t, listViewFixtures()[tc.path]).([]any)
		data[0].(map[string]any)[tc.key] = tc.value
		if err := resolvedResponseSchema(t, tc.path).Validate(data); err == nil {
			t.Errorf("%s accepted invalid %s", tc.path, tc.key)
		}
	}
}

func TestTypedTemplateCatalogPreservesEmbeddedWire(t *testing.T) {
	var embedded any
	if err := json.Unmarshal(templateCatalogJSON, &embedded); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(embedded, listWire(t, templateCatalog)) {
		t.Fatal("typed catalog changed embedded workflow or optional credential fields")
	}
}

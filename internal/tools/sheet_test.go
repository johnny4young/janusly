package tools

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func sheetDeps(t *testing.T, org string) *IntegrationDeps {
	t.Helper()
	t.Setenv("JANUSLY_OBJECT_STORE_PROVIDER", "local")
	t.Setenv("JANUSLY_OBJECT_STORE_LOCAL_DIR", t.TempDir())
	var lock sync.Mutex
	return &IntegrationDeps{
		OrgID: func() string { return org },
		Lock: func(context.Context, string) (func(), string) {
			lock.Lock()
			return lock.Unlock, ""
		},
	}
}

func TestSheetAppendValidatesShapeAndNeutralizesFormulas(t *testing.T) {
	deps := sheetDeps(t, "org-safe-sheet")
	root := os.Getenv("JANUSLY_OBJECT_STORE_LOCAL_DIR")
	result := executeSheetAppend(context.Background(), map[string]any{
		"name": "safe", "header": []any{"account", "value"},
		"rows": []any{[]any{"  =cmd|' /C calc'!A0", float64(-42)}},
	}, deps)
	if result["ok"] != true {
		t.Fatalf("explicit-header array row: %+v", result)
	}
	raw, err := os.ReadFile(filepath.Join(root, "orgs", "org-safe-sheet", "sheets", "safe.csv"))
	if err != nil {
		t.Fatal(err)
	}
	if got := string(raw); !strings.Contains(got, "'  =cmd") || !strings.Contains(got, ",-42") {
		t.Fatalf("string formulas must be literal while numeric negatives remain numeric: %q", got)
	}

	for name, header := range map[string]any{
		"non-string": []any{"a", float64(2)},
		"duplicate":  []any{"a", "a"},
		"empty":      []any{"a", " "},
	} {
		bad := executeSheetAppend(context.Background(), map[string]any{
			"name": name, "header": header, "rows": []any{map[string]any{"a": "x"}},
		}, deps)
		if bad["ok"] != false {
			t.Fatalf("%s header must fail closed: %+v", name, bad)
		}
	}
}

// First append creates the sheet with a derived header; later appends
// align to the SHEET's columns even when rows arrive shaped differently.
func TestSheetAppendCreatesThenAligns(t *testing.T) {
	deps := sheetDeps(t, "org-sheet")
	root := os.Getenv("JANUSLY_OBJECT_STORE_LOCAL_DIR")

	first := executeSheetAppend(context.Background(), map[string]any{
		"name": "weekly", "rows": []any{
			map[string]any{"customer": "acme", "total": float64(42)},
		},
	}, deps)
	if first["ok"] != true || first["appended"] != 1 {
		t.Fatalf("first append: %+v", first)
	}
	rejected := executeSheetAppend(context.Background(), map[string]any{
		"name": "weekly", "rows": []any{
			// Silently dropping an unknown key would lose report data.
			map[string]any{"total": float64(7), "customer": "globex", "sneaky": "x"},
		},
	}, deps)
	if rejected["ok"] != false || !strings.Contains(rejected["error"].(string), "outside the sheet header") {
		t.Fatalf("unknown columns must fail closed: %+v", rejected)
	}
	second := executeSheetAppend(context.Background(), map[string]any{
		"name": "weekly", "rows": []any{
			map[string]any{"total": float64(7), "customer": "globex"},
		},
	}, deps)
	if second["ok"] != true || second["appended"] != 1 {
		t.Fatalf("second append: %+v", second)
	}

	raw, err := os.ReadFile(filepath.Join(root, "orgs", "org-sheet", "sheets", "weekly.csv"))
	if err != nil {
		t.Fatalf("read sheet: %v", err)
	}
	lines := strings.Split(strings.TrimRight(string(raw), "\n"), "\n")
	if len(lines) != 3 || lines[0] != "customer,total" {
		t.Fatalf("sheet shape: %q", lines)
	}
	if lines[1] != "acme,42" || lines[2] != "globex,7" {
		t.Fatalf("rows must align to the sheet header: %q", lines)
	}
}

// The name is workflow-author input feeding an object key: traversal is
// stripped and an unconfigured store answers an envelope, never a panic.
func TestSheetAppendGuardsKeyAndProvider(t *testing.T) {
	deps := sheetDeps(t, "org-guard")
	root := os.Getenv("JANUSLY_OBJECT_STORE_LOCAL_DIR")

	result := executeSheetAppend(context.Background(), map[string]any{
		"name": "../../escape", "rows": []any{[]any{"a"}},
	}, deps)
	if result["ok"] != false || !strings.Contains(result["error"].(string), "safe base name") {
		t.Fatalf("hostile name must fail rather than be silently rewritten: %+v", result)
	}
	if _, err := os.Stat(filepath.Join(root, "orgs", "org-guard", "sheets", "escape.csv")); !os.IsNotExist(err) {
		t.Fatalf("a rejected sheet must not be written: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "escape.csv")); !os.IsNotExist(err) {
		t.Fatal("traversal must never escape the prefix")
	}

	t.Setenv("JANUSLY_OBJECT_STORE_PROVIDER", "noop")
	unconfigured := executeSheetAppend(context.Background(), map[string]any{
		"name": "x", "rows": []any{[]any{"a"}},
	}, deps)
	if unconfigured["ok"] != false || unconfigured["provider"] != "noop" {
		t.Fatalf("noop provider must answer an honest envelope: %+v", unconfigured)
	}
}

func TestSheetAppendDerivesUnionHeaderAndAcceptsTypedSlices(t *testing.T) {
	deps := sheetDeps(t, "org-union-sheet")
	root := os.Getenv("JANUSLY_OBJECT_STORE_LOCAL_DIR")
	result := executeSheetAppend(context.Background(), map[string]any{
		"name": "union.csv",
		"rows": []map[string]any{
			{"customer": "acme"},
			{"total": 42},
		},
	}, deps)
	if result["ok"] != true {
		t.Fatalf("typed object rows: %+v", result)
	}
	raw, err := os.ReadFile(filepath.Join(root, "orgs", "org-union-sheet", "sheets", "union.csv"))
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.TrimSpace(string(raw)); got != "customer,total\nacme,\n,42" {
		t.Fatalf("derived header must preserve every first-batch column: %q", got)
	}
}

func TestSheetInputContractRejectsLossyOrUnboundedShapes(t *testing.T) {
	registry := NewRegistry()
	if err := registry.ValidatePartialInput("sheet.append", map[string]any{
		"rows": "{{context.report.output.rows}}",
	}); err != nil {
		t.Fatalf("deferred rows should remain representable in a proposal: %v", err)
	}
	if err := registry.ValidateInput("sheet.append", map[string]any{
		"name": "weekly", "header": []string{"account", "total"},
		"rows": [][]any{{"acme", 42}},
	}); err != nil {
		t.Fatalf("typed arrays should validate: %v", err)
	}

	tests := []struct {
		name    string
		input   map[string]any
		message string
	}{
		{name: "empty rows", input: map[string]any{"name": "x", "rows": []any{}}, message: "rows must contain"},
		{name: "nested cell", input: map[string]any{"name": "x", "rows": []any{[]any{map[string]any{"hidden": true}}}}, message: "JSON scalar"},
		{name: "oversized cell", input: map[string]any{"name": "x", "rows": []any{[]any{strings.Repeat("x", sheetCellMaxBytes+1)}}}, message: "JSON scalar"},
		{name: "whitespace header", input: map[string]any{"name": "x", "header": []any{" account"}, "rows": []any{[]any{"a"}}}, message: "must be trimmed"},
		{name: "unknown explicit column", input: map[string]any{"name": "x", "header": []any{"account"}, "rows": []any{map[string]any{"other": "a"}}}, message: "outside the sheet header"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := registry.ValidateInput("sheet.append", test.input)
			if err == nil || !strings.Contains(err.Error(), test.message) {
				t.Fatalf("expected %q rejection, got %v", test.message, err)
			}
		})
	}
}

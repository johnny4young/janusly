package tools

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func sheetDeps(t *testing.T, org string) *IntegrationDeps {
	t.Helper()
	t.Setenv("JANUSLY_OBJECT_STORE_PROVIDER", "local")
	t.Setenv("JANUSLY_OBJECT_STORE_LOCAL_DIR", t.TempDir())
	return &IntegrationDeps{OrgID: func() string { return org }}
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
	second := executeSheetAppend(context.Background(), map[string]any{
		"name": "weekly", "rows": []any{
			// extra key must not add a column; missing key renders empty
			map[string]any{"total": float64(7), "customer": "globex", "sneaky": "x"},
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
	if result["ok"] != true {
		t.Fatalf("sanitized name must still work: %+v", result)
	}
	if _, err := os.Stat(filepath.Join(root, "orgs", "org-guard", "sheets", "escape.csv")); err != nil {
		t.Fatalf("the sheet must land INSIDE the tenant prefix: %v", err)
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

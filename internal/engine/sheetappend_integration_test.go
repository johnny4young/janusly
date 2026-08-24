//go:build integration

package engine

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/johnny4young/janusly/internal/tools"
)

// sheet.append holds a PostgreSQL advisory lock across object read+write, so
// concurrent worker processes cannot lose rows through last-writer-wins.
func TestSheetAppendSerializesConcurrentWriters(t *testing.T) {
	_, _, engine, orgID := newHarness(t)
	root := t.TempDir()
	t.Setenv("JANUSLY_OBJECT_STORE_PROVIDER", "local")
	t.Setenv("JANUSLY_OBJECT_STORE_LOCAL_DIR", root)
	deps := engine.buildIntegrationDeps(orgID, "", "")

	first := tools.ExecuteIntegrationTool(t.Context(), "sheet.append", map[string]any{
		"name": "events", "header": []any{"writer"}, "rows": []any{[]any{"seed"}},
	}, deps)
	if first["ok"] != true {
		t.Fatalf("seed sheet: %+v", first)
	}

	const writers = 12
	start := make(chan struct{})
	results := make(chan map[string]any, writers)
	var wg sync.WaitGroup
	for index := range writers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			results <- tools.ExecuteIntegrationTool(ctx, "sheet.append", map[string]any{
				"name": "events", "rows": []any{[]any{fmt.Sprintf("writer-%02d", index)}},
			}, deps)
		}()
	}
	close(start)
	wg.Wait()
	close(results)
	for result := range results {
		if result["ok"] != true {
			t.Fatalf("concurrent append: %+v", result)
		}
	}

	raw, err := os.ReadFile(filepath.Join(root, "orgs", orgID, "sheets", "events.csv"))
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(string(raw)), "\n")
	if len(lines) != writers+2 { // header + seed + every concurrent writer
		t.Fatalf("lost sheet rows: got %d lines, want %d\n%s", len(lines), writers+2, raw)
	}
}

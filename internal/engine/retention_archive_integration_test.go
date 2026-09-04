//go:build integration

package engine

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Archival is an export-then-delete tier: a row may only leave the
// database once a copy of it is durable, and a store that refuses the
// object must leave the data exactly where it was.
func TestRunEventArchivalExportsBeforeDeleting(t *testing.T) {
	dsn := os.Getenv("JANUSLY_DATABASE_URL")
	if dsn == "" {
		t.Skip("JANUSLY_DATABASE_URL not set")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	defer pool.Close()
	eng := New(pool)

	org := fmt.Sprintf("org-archive-%d", time.Now().UnixNano())
	runID := "run-" + org
	if _, err := pool.Exec(ctx, `INSERT INTO runs (id, org_id, status, input_json, workflow_version_id)
		VALUES ($1, $2, 'succeeded', '{}', 'wv-archive')`, runID, org); err != nil {
		t.Fatalf("seed run: %v", err)
	}
	expired := time.Now().UTC().AddDate(0, 0, -40)
	const expiredEvents = 12
	for i := range expiredEvents {
		if _, err := pool.Exec(ctx, `INSERT INTO run_events (id, run_id, node_id, type, payload, created_at)
			VALUES ($1, $2, 'step', 'node.succeeded', $3::jsonb, $4)`,
			fmt.Sprintf("%s-ev-%d", runID, i), runID,
			fmt.Sprintf(`{"index":%d}`, i), expired); err != nil {
			t.Fatalf("seed events: %v", err)
		}
	}
	seedConfig := func(key, value, valueType string) {
		if _, err := pool.Exec(ctx, `INSERT INTO org_configs (id, org_id, key, value_json, category, description, value_type)
			VALUES ($1, $2, $3, $4::jsonb, 'retention', 'test', $5)`,
			org+"-"+key, org, key, value, valueType); err != nil {
			t.Fatalf("seed config %s: %v", key, err)
		}
	}
	seedConfig("retention.runEventsDays", "30", "number")
	seedConfig("retention.archiveRunEvents", "true", "boolean")

	remaining := func() int {
		var count int
		if err := pool.QueryRow(ctx,
			`SELECT count(*) FROM run_events WHERE run_id = $1`, runID).Scan(&count); err != nil {
			t.Fatalf("count events: %v", err)
		}
		return count
	}

	// No object store configured: the sweep must refuse to delete rows it
	// cannot archive, and report the failure rather than swallow it.
	t.Setenv("JANUSLY_OBJECT_STORE_PROVIDER", "noop")
	if _, err := eng.ProcessDataRetentionSweep(ctx, 5, 5); err == nil {
		t.Fatal("an unavailable archive target must fail the sweep, not delete silently")
	}
	if got := remaining(); got != expiredEvents {
		t.Fatalf("nothing may be deleted without a stored export: %d rows left", got)
	}

	// With a working store, every deleted row is present in an object.
	root := t.TempDir()
	t.Setenv("JANUSLY_OBJECT_STORE_PROVIDER", "local")
	t.Setenv("JANUSLY_OBJECT_STORE_LOCAL_DIR", root)
	if _, err := eng.ProcessDataRetentionSweep(ctx, 5, 5); err != nil {
		t.Fatalf("archiving sweep: %v", err)
	}
	if got := remaining(); got != 0 {
		t.Fatalf("archived rows must be purged: %d left", got)
	}

	exported := map[string]bool{}
	err = filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil || entry.IsDir() || !strings.HasSuffix(path, ".jsonl") {
			return err
		}
		key := filepath.ToSlash(path)
		if !strings.Contains(key, "archive/run-events/") {
			t.Fatalf("unexpected archive key: %s", path)
		}
		// The sweep archives every org with aged events; only this org's
		// objects are this test's evidence on a shared database.
		if !strings.Contains(key, "/orgs/"+org+"/") {
			return nil
		}
		raw, readErr := os.ReadFile(path)
		if readErr != nil {
			return readErr
		}
		for _, line := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
			var record struct {
				ID      string          `json:"id"`
				RunID   string          `json:"runId"`
				NodeID  string          `json:"nodeId"`
				Type    string          `json:"type"`
				Payload json.RawMessage `json:"payload"`
			}
			if err := json.Unmarshal([]byte(line), &record); err != nil {
				t.Fatalf("archived line is not JSON: %v", err)
			}
			if record.RunID != runID || record.NodeID != "step" || record.Type != "node.succeeded" {
				t.Fatalf("archived record lost its identity: %+v", record)
			}
			if len(record.Payload) == 0 {
				t.Fatalf("archived record lost its payload: %+v", record)
			}
			exported[record.ID] = true
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk archive: %v", err)
	}
	if len(exported) != expiredEvents {
		t.Fatalf("every purged row must be exported: exported %d of %d", len(exported), expiredEvents)
	}
}

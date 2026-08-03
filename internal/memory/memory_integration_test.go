//go:build integration

package memory

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func testPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv("JANUSLY_GO_DATABASE_URL")
	if dsn == "" {
		t.Skip("JANUSLY_GO_DATABASE_URL not set")
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func fakeOllama(t *testing.T) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Prompt string `json:"prompt"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		// A deterministic 1024-dim embedding derived from the prompt so
		// similarity ordering is testable: same text → same vector.
		vector := make([]float64, 1024)
		for i, ch := range body.Prompt {
			vector[i%1024] += float64(ch%23) / 23
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"embedding": vector})
	}))
	t.Cleanup(server.Close)
	return server
}

// The two-flag consent + never-throw ladder: consent off is byte-equal to
// today (no rows), a dead Ollama degrades silently, and consented
// commit/recall round-trips with runId attribution on the usage rows.
func TestMemoryConsentAndRecall(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	org := fmt.Sprintf("org-mem-%d", time.Now().UnixNano())

	countEntries := func() int {
		var n int
		_ = pool.QueryRow(ctx, `SELECT count(*) FROM memory_entries WHERE org_id = $1`, org).Scan(&n)
		return n
	}

	// 1. Consent OFF (default): commit refuses, recall empties, no rows.
	t.Setenv("JANUSLY_MEMORY_ENABLED", "")
	if result := Commit(ctx, pool, CommitInput{OrgID: org, Kind: "workflow_vector", Content: "x"}); result.OK || result.Error != "memory_disabled" {
		t.Fatalf("consent off must refuse: %+v", result)
	}
	if entries := Recall(ctx, pool, RecallInput{OrgID: org, Kind: "workflow_vector", Query: "x"}); len(entries) != 0 {
		t.Fatalf("consent off must recall empty: %d", len(entries))
	}
	if countEntries() != 0 {
		t.Fatal("consent off must write nothing")
	}
	// Process flag alone is NOT enough (org flag still off).
	t.Setenv("JANUSLY_MEMORY_ENABLED", "true")
	if result := Commit(ctx, pool, CommitInput{OrgID: org, Kind: "workflow_vector", Content: "x"}); result.OK {
		t.Fatal("org consent must also gate")
	}

	// 2. Full consent + allowed kind.
	seed := func(key, valueJSON, valueType string) {
		if _, err := pool.Exec(ctx, `INSERT INTO org_configs (id, org_id, key, value_json, category, description, value_type)
			VALUES ($1, $2, $3, $4, 'memory', 'test', $5)`, org+"-"+key, org, key, valueJSON, valueType); err != nil {
			t.Fatalf("seed %s: %v", key, err)
		}
	}
	seed("memory.enabled", "true", "boolean")
	seed("memory.allowedKinds", `"workflow_vector"`, "string")
	ollama := fakeOllama(t)
	seed("memory.embeddingBaseUrl", fmt.Sprintf("%q", ollama.URL), "string")

	// A kind OUTSIDE the allowlist still refuses.
	if result := Commit(ctx, pool, CommitInput{OrgID: org, Kind: "agent_episode", Content: "x"}); result.OK {
		t.Fatal("kind outside the allowlist must refuse")
	}

	committed := Commit(ctx, pool, CommitInput{
		OrgID: org, RunID: "run-mem-1", Kind: "workflow_vector",
		Content:  "los reintentos con backoff arreglaron el timeout",
		Metadata: map[string]any{"source": "test"},
	})
	if !committed.OK {
		t.Fatalf("consented commit: %+v", committed)
	}
	Commit(ctx, pool, CommitInput{
		OrgID: org, Kind: "workflow_vector", Content: "el webhook de facturación duplicaba pagos",
	})
	if countEntries() != 2 {
		t.Fatalf("two entries expected: %d", countEntries())
	}
	var retainDays float64
	_ = pool.QueryRow(ctx, `SELECT EXTRACT(epoch FROM retain_until - now())/86400
		FROM memory_entries WHERE org_id = $1 AND id = $2`, org, committed.ID).Scan(&retainDays)
	if retainDays < 179 || retainDays > 181 {
		t.Fatalf("workflow_vector retention must be ~180d: %f", retainDays)
	}

	// Recall: similarity ordering + runId attribution on the usage row.
	entries := Recall(ctx, pool, RecallInput{
		OrgID: org, RunID: "run-mem-2", Kind: "workflow_vector",
		Query: "los reintentos con backoff arreglaron el timeout",
	})
	if len(entries) != 2 || !strings.Contains(entries[0].Content, "reintentos") {
		t.Fatalf("similarity order: %+v", entries)
	}
	var recallRows int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM usage_events
		WHERE org_id = $1 AND run_id = 'run-mem-2' AND metric = 'memory.recall'
		  AND metadata @> '{"ok":true,"kind":"workflow_vector"}'`, org).Scan(&recallRows)
	if recallRows != 1 {
		t.Fatalf("recall must attribute its runId on usage: %d", recallRows)
	}

	// 3. Ollama down: both paths degrade silently, nothing breaks.
	ollama.Close()
	if result := Commit(ctx, pool, CommitInput{OrgID: org, Kind: "workflow_vector", Content: "y"}); result.OK || result.Error != "embedding_failed" {
		t.Fatalf("dead ollama commit must degrade: %+v", result)
	}
	if entries := Recall(ctx, pool, RecallInput{OrgID: org, Kind: "workflow_vector", Query: "y"}); len(entries) != 0 {
		t.Fatalf("dead ollama recall must empty: %d", len(entries))
	}
}

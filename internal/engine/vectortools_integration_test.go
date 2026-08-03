//go:build integration

package engine

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

	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/grammar"
)

// The vector tools through real workflow runs: consent off answers the
// closed envelopes without ever throwing, consent on round-trips an
// upsert into a later search, and a validation replay SKIPS the write.
func TestVectorToolsThroughRuns(t *testing.T) {
	dsn := os.Getenv("JANUSLY_GO_DATABASE_URL")
	if dsn == "" {
		t.Skip("JANUSLY_GO_DATABASE_URL not set")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	defer pool.Close()
	eng := New(pool)
	dispatcher := eng.NewDispatcher(grammar.RenderOptions{})
	workerCtx, stop := context.WithCancel(context.Background())
	defer stop()
	go func() { _ = eng.RunWorkers(workerCtx, 2, 20*time.Millisecond, dispatcher.Execute, quietLogger()) }()

	org := fmt.Sprintf("org-vectool-%d", time.Now().UnixNano())
	toolWorkflow := func(id, tool string, input map[string]any) *domain.Workflow {
		return &domain.Workflow{
			ID: id, Name: "Vector Tool", DSLVersion: "1.0",
			Nodes: []domain.Node{{ID: "v", Type: "tool", Config: map[string]any{
				"tool": tool, "input": input,
			}}},
			Edges: []domain.Edge{},
		}
	}
	runTool := func(id, tool string, input map[string]any, replayMode string) map[string]any {
		runID, err := eng.StartRun(ctx, StartInput{
			OrgID: org, Workflow: toolWorkflow(id, tool, input), ReplayMode: replayMode,
		})
		if err != nil {
			t.Fatalf("start %s: %v", id, err)
		}
		waitRunStatus(t, pool, runID, "succeeded", 0)
		var raw []byte
		if err := pool.QueryRow(ctx, `SELECT state_json FROM run_nodes WHERE run_id = $1 AND node_id = 'v'`, runID).Scan(&raw); err != nil {
			t.Fatalf("state: %v", err)
		}
		var state struct {
			Output struct {
				Result map[string]any `json:"result"`
			} `json:"output"`
		}
		_ = json.Unmarshal(raw, &state)
		return state.Output.Result
	}

	// 1. Consent OFF: upsert answers memory_disabled, search stays empty —
	// both runs SUCCEED (never throw).
	t.Setenv("JANUSLY_MEMORY_ENABLED", "")
	result := runTool("wf-vec-off-up", "vector.upsert", map[string]any{"content": "algo"}, "")
	if result["ok"] != false || result["error"] != "memory_disabled" {
		t.Fatalf("consent-off upsert: %+v", result)
	}
	result = runTool("wf-vec-off-search", "vector.search", map[string]any{"query": "algo"}, "")
	if result["ok"] != true || len(result["entries"].([]any)) != 0 {
		t.Fatalf("consent-off search: %+v", result)
	}

	// 2. Consent ON: upsert lands, search finds it.
	t.Setenv("JANUSLY_MEMORY_ENABLED", "true")
	ollama := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Prompt string `json:"prompt"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		vector := make([]float64, 1024)
		for i, ch := range body.Prompt {
			vector[i%1024] += float64(ch%23) / 23
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"embedding": vector})
	}))
	defer ollama.Close()
	seed := func(key, valueJSON, valueType string) {
		if _, err := pool.Exec(ctx, `INSERT INTO org_configs (id, org_id, key, value_json, category, description, value_type)
			VALUES ($1, $2, $3, $4, 'memory', 'test', $5)`, org+"-"+key, org, key, valueJSON, valueType); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}
	seed("memory.enabled", "true", "boolean")
	seed("memory.allowedKinds", `"workflow_vector"`, "string")
	seed("memory.embeddingBaseUrl", fmt.Sprintf("%q", ollama.URL), "string")

	result = runTool("wf-vec-up", "vector.upsert", map[string]any{
		"content": "el backoff arregló los timeouts", "metadata": map[string]any{"origen": "smoke"},
	}, "")
	if result["ok"] != true || result["id"] == nil {
		t.Fatalf("consented upsert: %+v", result)
	}
	result = runTool("wf-vec-search", "vector.search", map[string]any{"query": "timeouts y backoff"}, "")
	entries := result["entries"].([]any)
	if len(entries) != 1 || !strings.Contains(entries[0].(map[string]any)["content"].(string), "backoff") {
		t.Fatalf("search must find the upsert: %+v", entries)
	}

	// 3. Validation replay: the WRITE side skips (no new row).
	var before int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM memory_entries WHERE org_id = $1`, org).Scan(&before)
	result = runTool("wf-vec-dry", "vector.upsert", map[string]any{"content": "no debería escribirse"}, "validation")
	if result["skipped"] != true {
		t.Fatalf("validation upsert must skip: %+v", result)
	}
	var after int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM memory_entries WHERE org_id = $1`, org).Scan(&after)
	if after != before {
		t.Fatalf("validation must not write: %d -> %d", before, after)
	}
}

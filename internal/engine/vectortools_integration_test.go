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
	"sync"
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
	dsn := os.Getenv("JANUSLY_DATABASE_URL")
	if dsn == "" {
		t.Skip("JANUSLY_DATABASE_URL not set")
	}
	// The org-config embedding URL points at a loopback fixture, which the
	// tenant-URL SSRF policy refuses without the documented dev escape hatch.
	t.Setenv("ALLOW_PRIVATE_HTTP_TARGETS", "true")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	defer pool.Close()
	eng := New(pool)
	const resolvedSecret = "opaque-vector-secret-918274"
	dispatcher := eng.NewDispatcher(grammar.RenderOptions{
		LookupSecret: func(name string) (string, bool) {
			return resolvedSecret, name == "VECTOR_TOKEN"
		},
	})
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
	var promptMu sync.Mutex
	var embeddingPrompts []string
	ollama := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Prompt string `json:"prompt"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		promptMu.Lock()
		embeddingPrompts = append(embeddingPrompts, body.Prompt)
		promptMu.Unlock()
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
		"content":  "el backoff {{secret.VECTOR_TOKEN}} arregló los timeouts",
		"metadata": map[string]any{"origen": "smoke", "opaque": "Bearer {{secret.VECTOR_TOKEN}}"},
	}, "")
	if result["ok"] != true || result["id"] == nil {
		t.Fatalf("consented upsert: %+v", result)
	}
	var storedContent string
	var storedMetadata []byte
	var storedWorkflowID string
	if err := pool.QueryRow(ctx, `SELECT content, metadata, COALESCE(workflow_id, '') FROM memory_entries
		WHERE org_id = $1 AND kind = 'workflow_vector'`, org).Scan(&storedContent, &storedMetadata, &storedWorkflowID); err != nil {
		t.Fatalf("stored memory: %v", err)
	}
	if storedWorkflowID != "wf-vec-up" {
		t.Fatalf("vector memory lost workflow attribution: %q", storedWorkflowID)
	}
	if strings.Contains(storedContent, resolvedSecret) || strings.Contains(string(storedMetadata), resolvedSecret) {
		t.Fatalf("resolved secret reached memory: content=%q metadata=%s", storedContent, storedMetadata)
	}
	if !strings.Contains(storedContent, grammar.RedactedPlaceholder) || !strings.Contains(string(storedMetadata), grammar.RedactedPlaceholder) {
		t.Fatalf("memory must preserve explicit redaction evidence: content=%q metadata=%s", storedContent, storedMetadata)
	}

	result = runTool("wf-vec-search", "vector.search", map[string]any{
		"query": "{{secret.VECTOR_TOKEN}} timeouts y backoff",
	}, "")
	entries := result["entries"].([]any)
	if len(entries) != 1 || !strings.Contains(entries[0].(map[string]any)["content"].(string), "backoff") {
		t.Fatalf("search must find the upsert: %+v", entries)
	}
	promptMu.Lock()
	prompts := append([]string(nil), embeddingPrompts...)
	promptMu.Unlock()
	if len(prompts) < 2 {
		t.Fatalf("expected commit and recall embedding prompts: %v", prompts)
	}
	for _, prompt := range prompts {
		if strings.Contains(prompt, resolvedSecret) {
			t.Fatalf("resolved secret reached embedding provider: %q", prompt)
		}
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

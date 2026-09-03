//go:build integration

package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"
)

// Semantic run search, read half: the route requires a query, answers an
// honest {enabled:false} for a memory-disabled org, and under full
// consent recalls committed run_summary rows with runId attribution.
func TestSemanticRunSearchRoute(t *testing.T) {
	t.Setenv("ALLOW_PRIVATE_HTTP_TARGETS", "true")
	t.Setenv("JANUSLY_MEMORY_ENABLED", "true")
	h := newAPIHarness(t)
	pool := testPool(t)
	ctx := t.Context()

	// Missing q is a client error, not an empty result.
	if res := h.call("GET", "/runs/semantic-search", nil, ""); res.status != http.StatusBadRequest {
		t.Fatalf("missing q must 400, got %d", res.status)
	}

	// Memory disabled for the org: honest disabled envelope.
	res := h.call("GET", "/runs/semantic-search?q=timeout", nil, "")
	if res.status != 200 || res.body["enabled"] != false {
		t.Fatalf("disabled org must answer enabled:false, got %d %+v", res.status, res.body)
	}

	// Consent on + a committed summary: the entry comes back with runId.
	var promptMu sync.Mutex
	lastPrompt := ""
	embedder := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload struct {
			Prompt string `json:"prompt"`
		}
		_ = json.NewDecoder(r.Body).Decode(&payload)
		promptMu.Lock()
		lastPrompt = payload.Prompt
		promptMu.Unlock()
		vector := make([]float64, 1024)
		vector[0] = 1
		_ = json.NewEncoder(w).Encode(map[string]any{"embedding": vector})
	}))
	t.Cleanup(embedder.Close)
	seed := func(key, valueJSON, valueType string) {
		if _, err := pool.Exec(ctx, `INSERT INTO org_configs (id, org_id, key, value_json, category, description, value_type)
			VALUES ($1, $2, $3, $4, 'memory', 'test', $5)`, h.org+"-"+key, h.org, key, valueJSON, valueType); err != nil {
			t.Fatalf("seed %s: %v", key, err)
		}
	}
	seed("memory.enabled", "true", "boolean")
	seed("memory.allowedKinds", `"run_summary"`, "string")
	seed("memory.embeddingBaseUrl", fmt.Sprintf("%q", embedder.URL), "string")

	runID := fmt.Sprintf("run-search-%d", time.Now().UnixNano())
	if _, err := pool.Exec(ctx, `INSERT INTO memory_entries
		(id, org_id, run_id, kind, content, embedding, embedding_provider,
		 embedding_model, embedding_dimension, metadata, retain_until)
		VALUES ($1, $2, $3, 'run_summary',
		 'Workflow "Refund triage" failed. Failed at node "fetch": http_error',
		 (SELECT ('[1' || repeat(',0', 1023) || ']')::vector), 'ollama', 'bge-m3', 1024,
		 '{"status":"failed"}', now() + interval '90 days')`,
		runID+"-mem", h.org, runID); err != nil {
		t.Fatalf("seed memory entry: %v", err)
	}

	res = h.call("GET", "/runs/semantic-search?q=refund+timeout+failure", nil, "")
	if res.status != 200 || res.body["enabled"] != true {
		t.Fatalf("consented search: %d %+v", res.status, res.body)
	}
	entries, _ := res.body["entries"].([]any)
	if len(entries) != 1 {
		t.Fatalf("one recalled entry expected, got %+v", res.body["entries"])
	}
	entry, _ := entries[0].(map[string]any)
	if entry["runId"] != runID {
		t.Fatalf("entry must attribute its run, got %+v", entry)
	}

	// Query truncation is rune-safe: a multi-byte UTF-8 query can never be
	// sliced into malformed text before it reaches the embedding provider.
	longQuery := strings.Repeat("😀", runSearchMaxQueryChars+1)
	if unicodeResult := h.call("GET", "/runs/semantic-search?q="+url.QueryEscape(longQuery), nil, ""); unicodeResult.status != 200 {
		t.Fatalf("unicode semantic search: %d %+v", unicodeResult.status, unicodeResult.body)
	}
	promptMu.Lock()
	boundedPrompt := lastPrompt
	promptMu.Unlock()
	if !utf8.ValidString(boundedPrompt) || utf8.RuneCountInString(boundedPrompt) != runSearchMaxQueryChars {
		t.Fatalf("embedding prompt must be valid and rune-bounded: valid=%v runes=%d",
			utf8.ValidString(boundedPrompt), utf8.RuneCountInString(boundedPrompt))
	}

	// A viewer-visible GET still consumes embedding resources; the dedicated
	// tenant bucket prevents unlimited provider work.
	if tag, err := pool.Exec(ctx, `UPDATE rate_limit_windows SET count = 30
		WHERE name = 'memory.run_semantic_search' AND key = $1`, h.org); err != nil || tag.RowsAffected() != 1 {
		t.Fatalf("prime semantic-search rate bucket: rows=%d err=%v", tag.RowsAffected(), err)
	}
	if limited := h.call("GET", "/runs/semantic-search?q=bounded", nil, ""); limited.status != http.StatusTooManyRequests || limited.body["code"] != "rate_limited" {
		t.Fatalf("semantic search must be tenant-rate-limited: %d %+v", limited.status, limited.body)
	}
}

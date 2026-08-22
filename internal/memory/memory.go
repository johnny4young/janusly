// Persistent cross-run memory substrate over pgvector, implements the
// contract's memory repo: the shared memory_entries table, an Ollama
// embeddings client (bge-m3, 1024 dims), and the two-flag consent —
// JANUSLY_MEMORY_ENABLED at the process level AND the org catalog's
// memory.enabled AND the kind present in memory.allowedKinds. Consent off
// (the default) means zero entries written and empty recalls. Commit and
// recall NEVER throw: every failure degrades silently (ok:false / empty)
// with a best-effort usage row — a broken memory substrate must never
// break the surface that consulted it. Every usage row forwards the
// caller's runId so /run/usage can attribute recalls to their run.
package memory

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/johnny4young/janusly/internal/executors"
	"github.com/johnny4young/janusly/internal/httpjson"
	"github.com/johnny4young/janusly/internal/orgconfig"
)

// Kinds is the closed memory-kind vocabulary.
var Kinds = map[string]bool{
	"recovery_rationale": true, "run_summary": true, "runbook_fragment": true,
	"patch_rationale": true, "generated_workflow": true,
	"workflow_vector": true, "agent_episode": true,
}

// defaultRetentionDays mirrors the contract table.
var defaultRetentionDays = map[string]int{
	"recovery_rationale": 180, "run_summary": 90, "runbook_fragment": 365,
	"patch_rationale": 365, "generated_workflow": 365,
	"workflow_vector": 180, "agent_episode": 180,
}

const (
	embeddingDimension        = 1024
	embeddingResponseMaxBytes = 256 << 10
)

// CommitInput is one memory write.
type CommitInput struct {
	OrgID      string
	WorkflowID string
	RunID      string
	Kind       string
	Content    string
	Metadata   map[string]any
}

// CommitResult mirrors the contract.
type CommitResult struct {
	OK    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
	ID    string `json:"id,omitempty"`
}

// RecallInput is one similarity query.
type RecallInput struct {
	OrgID      string
	WorkflowID string
	RunID      string
	Kind       string
	Query      string
}

// RecallEntry is one recalled row.
type RecallEntry struct {
	ID         string         `json:"id"`
	Kind       string         `json:"kind"`
	Content    string         `json:"content"`
	WorkflowID string         `json:"workflowId,omitempty"`
	RunID      string         `json:"runId,omitempty"`
	Similarity float64        `json:"similarity"`
	Metadata   map[string]any `json:"metadata,omitempty"`
}

// Enabled evaluates only the two master consent flags. Route callers use it
// before scheduling asynchronous commits so a memory-disabled organization
// observes no usage rows, audit noise, or embedding work at all.
func Enabled(ctx context.Context, pool *pgxpool.Pool, orgID string) bool {
	if os.Getenv("JANUSLY_MEMORY_ENABLED") != "true" {
		return false
	}
	if !orgconfig.LoadBool(ctx, pool, orgID, "memory.enabled") {
		return false
	}
	return true
}

// consent evaluates the two-flag gate + kind allowlist.
func consent(ctx context.Context, pool *pgxpool.Pool, orgID, kind string) (bool, string) {
	if !Enabled(ctx, pool, orgID) {
		return false, "memory_disabled"
	}
	allowed, _ := orgconfig.LoadValue(ctx, pool, orgID, "memory.allowedKinds").(string)
	for entry := range strings.SplitSeq(allowed, ",") {
		if strings.TrimSpace(entry) == kind {
			return true, ""
		}
	}
	return false, "memory_disabled"
}

// Commit embeds and persists one entry under consent. Never throws.
func Commit(ctx context.Context, pool *pgxpool.Pool, input CommitInput) CommitResult {
	startedAt := time.Now()
	provider, model, baseURL, tenantURL := embeddingConfig(ctx, pool, input.OrgID)
	fail := func(reason string) CommitResult {
		fireMemoryUsage(ctx, pool, "memory.commit", input.OrgID, input.RunID, input.WorkflowID,
			input.Kind, provider, model, false, reason, time.Since(startedAt))
		return CommitResult{OK: false, Error: reason}
	}
	if !Kinds[input.Kind] {
		return fail("unknown_kind")
	}
	if allowed, reason := consent(ctx, pool, input.OrgID, input.Kind); !allowed {
		return fail(reason)
	}
	embedding, err := embed(ctx, baseURL, model, input.Content, tenantURL)
	if err != nil {
		return fail("embedding_failed")
	}
	retention := defaultRetentionDays[input.Kind]
	metadataJSON, _ := json.Marshal(input.Metadata)
	id := uuid.NewString()
	_, err = pool.Exec(ctx, `INSERT INTO memory_entries
		(id, org_id, workflow_id, run_id, kind, content, embedding, embedding_provider,
		 embedding_model, embedding_dimension, metadata, retain_until)
		VALUES ($1, $2, NULLIF($3,''), NULLIF($4,''), $5, $6, $7::vector, $8, $9, $10, $11, now() + ($12 || ' days')::interval)`,
		id, input.OrgID, input.WorkflowID, input.RunID, input.Kind, input.Content,
		vectorLiteral(embedding), provider, model, embeddingDimension, metadataJSON, fmt.Sprint(retention))
	if err != nil {
		return fail("persist_failed")
	}
	fireMemoryUsage(ctx, pool, "memory.commit", input.OrgID, input.RunID, input.WorkflowID,
		input.Kind, provider, model, true, "", time.Since(startedAt))
	return CommitResult{OK: true, ID: id}
}

// Recall runs the similarity query under consent. Never throws — every
// failure returns an empty list.
func Recall(ctx context.Context, pool *pgxpool.Pool, input RecallInput) []RecallEntry {
	startedAt := time.Now()
	provider, model, baseURL, tenantURL := embeddingConfig(ctx, pool, input.OrgID)
	fail := func(reason string) []RecallEntry {
		fireMemoryUsage(ctx, pool, "memory.recall", input.OrgID, input.RunID, input.WorkflowID,
			input.Kind, provider, model, false, reason, time.Since(startedAt))
		return []RecallEntry{}
	}
	if allowed, reason := consent(ctx, pool, input.OrgID, input.Kind); !allowed {
		return fail(reason)
	}
	maxEntries := int(orgconfig.LoadNumber(ctx, pool, input.OrgID, "memory.recallMaxEntries"))
	if maxEntries <= 0 {
		maxEntries = 8
	}
	maxBytes := int(orgconfig.LoadNumber(ctx, pool, input.OrgID, "memory.recallMaxBytes"))
	if maxBytes <= 0 {
		maxBytes = 8192
	}
	embedding, err := embed(ctx, baseURL, model, input.Query, tenantURL)
	if err != nil {
		return fail("embedding_failed")
	}
	rows, err := pool.Query(ctx, `SELECT id, kind, content, COALESCE(workflow_id, ''),
		  COALESCE(run_id, ''), 1 - (embedding <=> $3::vector) AS similarity, metadata
		FROM memory_entries
		WHERE org_id = $1 AND kind = $2 AND retain_until > now()
		  AND (hold_until IS NULL OR hold_until <= now())
		ORDER BY embedding <=> $3::vector
		LIMIT $4`, input.OrgID, input.Kind, vectorLiteral(embedding), maxEntries)
	if err != nil {
		return fail("query_failed")
	}
	defer rows.Close()
	var entries []RecallEntry
	totalBytes := 0
	for rows.Next() {
		var entry RecallEntry
		var metadataRaw []byte
		if err := rows.Scan(&entry.ID, &entry.Kind, &entry.Content, &entry.WorkflowID, &entry.RunID, &entry.Similarity, &metadataRaw); err != nil {
			continue
		}
		_ = json.Unmarshal(metadataRaw, &entry.Metadata)
		totalBytes += len(entry.Content)
		if totalBytes > maxBytes {
			break // the byte budget bounds what any prompt can absorb
		}
		entries = append(entries, entry)
	}
	fireMemoryUsage(ctx, pool, "memory.recall", input.OrgID, input.RunID, input.WorkflowID,
		input.Kind, provider, model, true, "", time.Since(startedAt))
	if entries == nil {
		entries = []RecallEntry{}
	}
	return entries
}

// embeddingConfig resolves provider/model/base URL: catalog first, env
// defaults after (ollama / bge-m3 / OLLAMA_BASE_URL). tenantURL reports
// whether the base URL came from tenant-writable org config rather than
// the operator's process environment.
func embeddingConfig(ctx context.Context, pool *pgxpool.Pool, orgID string) (provider, model, baseURL string, tenantURL bool) {
	provider, _ = orgconfig.LoadValue(ctx, pool, orgID, "memory.embeddingProvider").(string)
	model, _ = orgconfig.LoadValue(ctx, pool, orgID, "memory.embeddingModel").(string)
	baseValue, baseSource := orgconfig.LoadValueWithSource(ctx, pool, orgID, "memory.embeddingBaseUrl")
	baseURL, _ = baseValue.(string)
	// Only an org_configs row is tenant input; the same key also resolves
	// OLLAMA_BASE_URL, which is the operator's own infrastructure.
	tenantURL = baseSource == "tenant" && baseURL != ""
	if provider == "" {
		provider = "ollama"
	}
	if model == "" {
		model = "bge-m3"
	}
	if baseURL == "" {
		baseURL = os.Getenv("OLLAMA_BASE_URL")
	}
	if baseURL == "" {
		baseURL = "http://ollama:11434"
	}
	return provider, model, baseURL, tenantURL
}

// embed calls the Ollama embeddings endpoint. An operator-supplied base
// URL (env default) may point at private infrastructure and uses the
// plain client; a tenant-supplied org-config URL is an org-admin input,
// so it goes through the outbound SSRF policy (validation + DNS pinning;
// ALLOW_PRIVATE_HTTP_TARGETS keeps development loopback working).
func embed(ctx context.Context, baseURL, model, text string, tenantURL bool) ([]float64, error) {
	payload, _ := json.Marshal(map[string]any{"model": model, "prompt": text})
	callCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	endpoint := strings.TrimRight(baseURL, "/") + "/api/embeddings"
	client := http.DefaultClient
	if tenantURL {
		pinned, err := executors.NewPinnedHTTPClient(callCtx, endpoint, executors.HTTPOptions{})
		if err != nil {
			return nil, err
		}
		client = pinned
	}
	req, err := http.NewRequestWithContext(callCtx, http.MethodPost,
		endpoint, bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("embeddings endpoint answered %d", res.StatusCode)
	}
	var decoded struct {
		Embedding []float64 `json:"embedding"`
	}
	if err := httpjson.Decode(res.Body, embeddingResponseMaxBytes, &decoded); err != nil {
		return nil, err
	}
	if len(decoded.Embedding) != embeddingDimension {
		return nil, fmt.Errorf("embedding dimension %d, want %d", len(decoded.Embedding), embeddingDimension)
	}
	return decoded.Embedding, nil
}

func vectorLiteral(embedding []float64) string {
	parts := make([]string, len(embedding))
	for i, value := range embedding {
		parts[i] = fmt.Sprintf("%g", value)
	}
	return "[" + strings.Join(parts, ",") + "]"
}

// fireMemoryUsage writes the contract's memory usage row — best-effort,
// a telemetry failure never breaks the caller.
func fireMemoryUsage(ctx context.Context, pool *pgxpool.Pool, metric, orgID, runID, workflowID,
	kind, provider, model string, ok bool, reason string, latency time.Duration) {
	metadata := map[string]any{
		"kind": kind, "embeddingProvider": provider, "embeddingModel": model,
		"ok": ok, "latencyMs": latency.Milliseconds(),
	}
	if workflowID != "" {
		metadata["workflowId"] = workflowID
	}
	if reason != "" {
		metadata["error"] = reason
	}
	raw, err := json.Marshal(metadata)
	if err != nil {
		return
	}
	_, _ = pool.Exec(ctx, `INSERT INTO usage_events (id, org_id, run_id, metric, quantity, metadata)
		VALUES ($1, $2, NULLIF($3,''), $4, 1, $5)`, uuid.NewString(), orgID, runID, metric, raw)
}

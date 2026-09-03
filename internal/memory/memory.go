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
	"math"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/johnny4young/janusly/internal/aiguidance"
	"github.com/johnny4young/janusly/internal/executors"
	"github.com/johnny4young/janusly/internal/grammar"
	"github.com/johnny4young/janusly/internal/httpjson"
	"github.com/johnny4young/janusly/internal/memorypolicy"
	"github.com/johnny4young/janusly/internal/orgconfig"
)

const (
	embeddingDimension        = 1024
	embeddingResponseMaxBytes = 256 << 10
	// Memory inputs may be workflow-authored or model-produced. Keep both the
	// embedding request and the durable row bounded independently from the
	// recall response budget configured by each organization.
	memoryTextMaxBytes         = 64 << 10
	memoryMetadataMaxBytes     = 16 << 10
	memoryMetadataScanMaxBytes = 64 << 10
	embeddingModelMaxBytes     = 256
	embeddingBaseURLMaxBytes   = 2048
)

var embeddingModelPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:/-]*$`)

// CommitInput is one memory write.
type CommitInput struct {
	OrgID      string
	WorkflowID string
	RunID      string
	Kind       string
	Content    string
	Metadata   map[string]any
	// RedactedValues are exact secret/env literals resolved by the dispatcher.
	// Shape-based scrubbing remains mandatory when this list is empty.
	RedactedValues []string
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
	// PreferWorkflow orders rows from WorkflowID before organization-wide
	// fallbacks, before LIMIT is applied. It does not filter cross-workflow
	// organizational memory.
	PreferWorkflow bool
	// RedactedValues protects both the provider-bound query and legacy rows
	// returned to the current execution.
	RedactedValues []string
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

var operationConfigKeys = []string{
	"memory.enabled",
	"memory.allowedKinds",
	"memory.retentionDaysByKind",
	"memory.recallMaxEntries",
	"memory.recallMaxBytes",
	"memory.embeddingModel",
	"memory.embeddingBaseUrl",
}

type operationConfig map[string]orgconfig.ValueWithSource

func loadOperationConfig(ctx context.Context, pool *pgxpool.Pool, orgID string) operationConfig {
	return orgconfig.LoadValuesWithSources(ctx, pool, orgID, operationConfigKeys...)
}

func (c operationConfig) value(key string) any { return c[key].Value }

// consent evaluates the process/tenant gates and kind allowlist against one
// immutable config snapshot for this operation.
func (c operationConfig) consent(kind string) (bool, string) {
	if os.Getenv("JANUSLY_MEMORY_ENABLED") != "true" {
		return false, "memory_disabled"
	}
	enabled, _ := c.value("memory.enabled").(bool)
	if !enabled {
		return false, "memory_disabled"
	}
	allowed, _ := c.value("memory.allowedKinds").(string)
	for entry := range strings.SplitSeq(allowed, ",") {
		if strings.TrimSpace(entry) == kind {
			return true, ""
		}
	}
	return false, "memory_disabled"
}

// prepareMemoryText validates one caller-controlled content/query value before
// it may cross either the embedding-provider or persistence boundary. It
// rejects oversize input rather than silently changing its semantic meaning.
func prepareMemoryText(value string, redactedValues []string, field string) (string, string) {
	if strings.TrimSpace(value) == "" {
		return "", field + "_required"
	}
	if len(value) > memoryTextMaxBytes {
		return "", field + "_too_large"
	}
	safe := grammar.RedactString(aiguidance.ScrubGuidanceSecrets(value), redactedValues)
	// Redaction usually shrinks credentials, but exact-value lists are an
	// execution seam and may contain very short strings. Replacing a repeated
	// one-byte value with "[redacted]" can expand an otherwise admitted input
	// by an order of magnitude, so enforce the provider/storage bound again on
	// the actual sanitized representation.
	if len(safe) > memoryTextMaxBytes {
		return "", field + "_too_large"
	}
	return safe, ""
}

// scrubNormalizedMemoryValue sanitizes a previously normalized metadata tree
// without mutating the caller's containers.
func scrubNormalizedMemoryValue(value any, redactedValues []string) any {
	switch typed := value.(type) {
	case string:
		return grammar.RedactString(aiguidance.ScrubGuidanceSecrets(typed), redactedValues)
	case []any:
		out := make([]any, len(typed))
		for index, item := range typed {
			out[index] = scrubNormalizedMemoryValue(item, redactedValues)
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(typed))
		for key, item := range typed {
			out[key] = scrubNormalizedMemoryValue(item, redactedValues)
		}
		return out
	default:
		return typed
	}
}

func safeMemoryMetadata(value any, redactedValues []string) json.RawMessage {
	normalized := grammar.NormalizeJSON(value)
	raw, err := json.Marshal(normalized)
	if err != nil {
		return json.RawMessage(`{}`)
	}
	if len(raw) > memoryMetadataScanMaxBytes {
		// Do not include a preview: this branch deliberately avoids running
		// secret-shape regexes over an attacker-sized legacy/direct-SQL value.
		return json.RawMessage(`{"__truncated":true}`)
	}
	return grammar.SafePersistPayload(scrubNormalizedMemoryValue(normalized, redactedValues), grammar.PersistOptions{
		RedactedValues: redactedValues,
		MaxBytes:       memoryMetadataMaxBytes,
	})
}

// Commit embeds and persists one entry under consent. Never throws.
func Commit(ctx context.Context, pool *pgxpool.Pool, input CommitInput) CommitResult {
	startedAt := time.Now()
	config := loadOperationConfig(ctx, pool, input.OrgID)
	provider, model, baseURL, tenantURL := config.embeddingConfig()
	fail := func(reason string) CommitResult {
		fireMemoryUsage(ctx, pool, "memory.commit", input.OrgID, input.RunID, input.WorkflowID,
			input.Kind, provider, model, false, reason, time.Since(startedAt))
		return CommitResult{OK: false, Error: reason}
	}
	if !memorypolicy.IsKind(input.Kind) {
		return fail("unknown_kind")
	}
	if allowed, reason := config.consent(input.Kind); !allowed {
		return fail(reason)
	}
	content, reason := prepareMemoryText(input.Content, input.RedactedValues, "content")
	if reason != "" {
		return fail(reason)
	}
	embedding, err := embed(ctx, baseURL, model, content, tenantURL)
	if err != nil {
		return fail("embedding_failed")
	}
	retention, _ := memorypolicy.DefaultRetentionDays(input.Kind)
	if raw, _ := config.value("memory.retentionDaysByKind").(string); raw != "" {
		var overrides map[string]int
		if json.Unmarshal([]byte(raw), &overrides) == nil {
			if configured, ok := overrides[input.Kind]; ok {
				retention = configured
			}
		}
	}
	metadataJSON := safeMemoryMetadata(input.Metadata, input.RedactedValues)
	id := uuid.NewString()
	tag, err := pool.Exec(ctx, `INSERT INTO memory_entries
		(id, org_id, workflow_id, run_id, kind, content, embedding, embedding_provider,
		 embedding_model, embedding_dimension, metadata, retain_until)
		VALUES ($1, $2, NULLIF($3,''), NULLIF($4,''), $5, $6, $7::vector, $8, $9, $10, $11, now() + ($12 || ' days')::interval)
		ON CONFLICT (org_id, run_id, kind)
		WHERE kind = 'run_summary' AND run_id IS NOT NULL
		DO NOTHING`,
		id, input.OrgID, input.WorkflowID, input.RunID, input.Kind, content,
		vectorLiteral(embedding), provider, model, embeddingDimension, metadataJSON, fmt.Sprint(retention))
	if err != nil {
		return fail("persist_failed")
	}
	if tag.RowsAffected() == 0 {
		// A durable producer may redeliver after an expired lease. The unique
		// run-summary key turns that replay into success without another row.
		id = ""
	}
	fireMemoryUsage(ctx, pool, "memory.commit", input.OrgID, input.RunID, input.WorkflowID,
		input.Kind, provider, model, true, "", time.Since(startedAt))
	return CommitResult{OK: true, ID: id}
}

// Recall runs the similarity query under consent. Never throws — every
// failure returns an empty list.
func Recall(ctx context.Context, pool *pgxpool.Pool, input RecallInput) []RecallEntry {
	startedAt := time.Now()
	config := loadOperationConfig(ctx, pool, input.OrgID)
	provider, model, baseURL, tenantURL := config.embeddingConfig()
	fail := func(reason string) []RecallEntry {
		fireMemoryUsage(ctx, pool, "memory.recall", input.OrgID, input.RunID, input.WorkflowID,
			input.Kind, provider, model, false, reason, time.Since(startedAt))
		return []RecallEntry{}
	}
	if !memorypolicy.IsKind(input.Kind) {
		return fail("unknown_kind")
	}
	if allowed, reason := config.consent(input.Kind); !allowed {
		return fail(reason)
	}
	maxEntriesValue, _ := config.value("memory.recallMaxEntries").(float64)
	maxEntries := int(maxEntriesValue)
	if maxEntries <= 0 {
		maxEntries = 8
	}
	maxBytesValue, _ := config.value("memory.recallMaxBytes").(float64)
	maxBytes := int(maxBytesValue)
	if maxBytes <= 0 {
		maxBytes = 8192
	}
	query, reason := prepareMemoryText(input.Query, input.RedactedValues, "query")
	if reason != "" {
		return fail(reason)
	}
	embedding, err := embed(ctx, baseURL, model, query, tenantURL)
	if err != nil {
		return fail("embedding_failed")
	}
	rows, err := pool.Query(ctx, `SELECT id, kind, content, COALESCE(workflow_id, ''),
		  COALESCE(run_id, ''), 1 - (embedding <=> $3::vector) AS similarity, metadata
		FROM memory_entries
		WHERE org_id = $1 AND kind = $2 AND retain_until > now()
		  AND (hold_until IS NULL OR hold_until <= now())
		ORDER BY CASE WHEN $4::boolean AND workflow_id = NULLIF($5::text, '') THEN 0 ELSE 1 END,
		         embedding <=> $3::vector, id
		LIMIT $6`, input.OrgID, input.Kind, vectorLiteral(embedding), input.PreferWorkflow, input.WorkflowID, maxEntries)
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
		if len(entry.Content) > memoryTextMaxBytes {
			continue
		}
		entry.Content = grammar.RedactString(aiguidance.ScrubGuidanceSecrets(entry.Content), input.RedactedValues)
		safeMetadata := safeMemoryMetadata(json.RawMessage(metadataRaw), input.RedactedValues)
		_ = json.Unmarshal(safeMetadata, &entry.Metadata)
		encoded, marshalErr := json.Marshal(entry)
		if marshalErr != nil || totalBytes+len(encoded) > maxBytes {
			break // the byte budget bounds what any prompt can absorb
		}
		totalBytes += len(encoded)
		entries = append(entries, entry)
	}
	if rows.Err() != nil {
		return fail("query_failed")
	}
	fireMemoryUsage(ctx, pool, "memory.recall", input.OrgID, input.RunID, input.WorkflowID,
		input.Kind, provider, model, true, "", time.Since(startedAt))
	if entries == nil {
		entries = []RecallEntry{}
	}
	return entries
}

// embeddingConfig resolves the supported Ollama model/base URL from the
// operation's one config snapshot. tenantURL reports whether the base URL came
// from tenant-writable org config rather than the operator's process
// environment. The provider remains explicit in persistence and usage records,
// but is deliberately not configurable until another protocol is implemented.
func (c operationConfig) embeddingConfig() (provider, model, baseURL string, tenantURL bool) {
	provider = "ollama"
	model, _ = c.value("memory.embeddingModel").(string)
	base := c["memory.embeddingBaseUrl"]
	baseURL, _ = base.Value.(string)
	// Only an org_configs row is tenant input; the same key also resolves
	// OLLAMA_BASE_URL, which is the operator's own infrastructure.
	tenantURL = base.Source == "tenant" && baseURL != ""
	if model == "" {
		model = "bge-m3"
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
	model = strings.TrimSpace(model)
	if len(model) == 0 || len(model) > embeddingModelMaxBytes || !embeddingModelPattern.MatchString(model) {
		return nil, fmt.Errorf("invalid embedding model id")
	}
	endpoint, err := embeddingEndpoint(baseURL)
	if err != nil {
		return nil, err
	}
	payload, _ := json.Marshal(map[string]any{"model": model, "prompt": text})
	callCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	client := http.DefaultClient
	if tenantURL {
		pinned, err := executors.NewPinnedHTTPClient(callCtx, endpoint, executors.HTTPOptions{})
		if err != nil {
			return nil, err
		}
		client = pinned
	}
	// Embedding endpoints are fixed, credential-free service contracts. A
	// 307/308 redirect would replay the memory text to a second destination;
	// reject every redirect instead of delegating that authority to the peer.
	redirectPolicy := func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }
	if client == http.DefaultClient {
		client = &http.Client{CheckRedirect: redirectPolicy}
	} else {
		client.CheckRedirect = redirectPolicy
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
	if err := validateEmbedding(decoded.Embedding); err != nil {
		return nil, err
	}
	return decoded.Embedding, nil
}

// validateEmbedding rejects vectors pgvector cannot safely compare. JSON
// decoding already rejects textual NaN/Infinity, but a finite float64 may
// still overflow pgvector's float32 element representation. An all-zero vector
// has no cosine similarity and would make recall ordering undefined.
func validateEmbedding(embedding []float64) error {
	if len(embedding) != embeddingDimension {
		return fmt.Errorf("embedding dimension %d, want %d", len(embedding), embeddingDimension)
	}
	nonZero := false
	for _, value := range embedding {
		value32 := float32(value)
		if math.IsNaN(value) || math.IsInf(value, 0) || math.IsInf(float64(value32), 0) {
			return fmt.Errorf("embedding contains a non-finite or out-of-range element")
		}
		if value32 != 0 {
			nonZero = true
		}
	}
	if !nonZero {
		return fmt.Errorf("embedding must not be a zero vector")
	}
	return nil
}

func embeddingEndpoint(baseURL string) (string, error) {
	baseURL = strings.TrimSpace(baseURL)
	if len(baseURL) == 0 || len(baseURL) > embeddingBaseURLMaxBytes {
		return "", fmt.Errorf("invalid embedding base URL")
	}
	parsed, err := url.Parse(baseURL)
	if err != nil || parsed == nil || !parsed.IsAbs() || parsed.Host == "" || parsed.User != nil ||
		(parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", fmt.Errorf("invalid embedding base URL")
	}
	parsed.Path = strings.TrimRight(parsed.Path, "/") + "/api/embeddings"
	parsed.RawPath = ""
	return parsed.String(), nil
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

// LLM usage telemetry substrate, implements the contract's
// usage-recorder seam + usage repo: a process-global Recorder registered
// at boot (the setUsageRecorder equivalent) that the future LLM client
// fires once per attempt — success AND fallback. Recorder failures are
// caught and dropped: telemetry must never break the call it measures.
// The DB writer emits the contract's exact row: metric "llm.completion",
// quantity = totalTokens, and the metadata block with explicit nulls so
// downstream aggregation reads one stable shape.
package usage

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/johnny4young/janusly/internal/store"
)

// Record is the wire contract between the LLM client (producer) and the
// data layer (writer) — the contract's UsageRecord.
type Record struct {
	OrgID      string
	UserID     string
	RunID      string
	NodeID     string
	WorkflowID string
	Provider   string
	Model      string

	InputTokens              *int
	OutputTokens             *int
	TotalTokens              *int
	CachedInputTokens        *int
	CacheCreationInputTokens *int

	LatencyMs int64
	// CostUsd nil = no price entry for the model (never guessed).
	CostUsd *float64
	// ProviderSimulated marks the explicit local simulator; its usage is
	// persisted but never billed (cost stays zero).
	ProviderSimulated bool
	// Mode is "ai" on success, "fallback" when the underlying call threw.
	Mode string
	// AiError is set when Mode == "fallback".
	AiError string
}

// Recorder is called once per LLM attempt.
type Recorder func(ctx context.Context, record Record) error

var (
	mu       sync.RWMutex
	recorder Recorder
)

// SetRecorder registers the process-global recorder (nil disables).
func SetRecorder(fn Recorder) {
	mu.Lock()
	defer mu.Unlock()
	recorder = fn
}

// Fire invokes the registered recorder defensively: absent orgId or
// recorder is a silent no-op, and a recorder error or panic is logged
// and dropped — never propagated to the LLM call.
func Fire(ctx context.Context, record Record) {
	mu.RLock()
	fn := recorder
	mu.RUnlock()
	if fn == nil || record.OrgID == "" {
		return
	}
	defer func() {
		if recovered := recover(); recovered != nil {
			slog.Warn("usage recorder panicked (call unaffected)", "panic", recovered)
		}
	}()
	if err := fn(ctx, record); err != nil {
		slog.Warn("usage recorder failed (call unaffected)", "error", err)
	}
}

// NewDBRecorder builds the production writer over the shared pool — the
// contract's recordUsage. Registered at api/worker boot via SetRecorder.
func NewDBRecorder(pool *pgxpool.Pool) Recorder {
	return func(ctx context.Context, record Record) error {
		quantity := 0
		if record.TotalTokens != nil {
			quantity = *record.TotalTokens
		}
		metadata, err := json.Marshal(map[string]any{
			"provider":                 record.Provider,
			"model":                    record.Model,
			"inputTokens":              intOrNull(record.InputTokens),
			"outputTokens":             intOrNull(record.OutputTokens),
			"cachedInputTokens":        intOrNull(record.CachedInputTokens),
			"cacheCreationInputTokens": intOrNull(record.CacheCreationInputTokens),
			"latencyMs":                record.LatencyMs,
			"costUsd":                  floatOrNull(record.CostUsd),
			"providerSimulated":        record.ProviderSimulated,
			"nodeId":                   stringOrNull(record.NodeID),
			"workflowId":               stringOrNull(record.WorkflowID),
			"mode":                     record.Mode,
			"aiError":                  stringOrNull(record.AiError),
		})
		if err != nil {
			return err
		}
		return store.New(pool).InsertUsageEvent(ctx, store.InsertUsageEventParams{
			ID: uuid.NewString(), OrgID: record.OrgID,
			UserID: pgtype.Text{String: record.UserID, Valid: record.UserID != ""},
			RunID:  pgtype.Text{String: record.RunID, Valid: record.RunID != ""},
			Metric: "llm.completion", Quantity: int32(quantity), Metadata: metadata,
		})
	}
}

func intOrNull(v *int) any {
	if v == nil {
		return nil
	}
	return *v
}

func floatOrNull(v *float64) any {
	if v == nil {
		return nil
	}
	return *v
}

func stringOrNull(v string) any {
	if v == "" {
		return nil
	}
	return v
}

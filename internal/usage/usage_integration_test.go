//go:build integration

package usage

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func testPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv("JANUSLY_DATABASE_URL")
	if dsn == "" {
		t.Skip("JANUSLY_DATABASE_URL not set")
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func intPtr(v int) *int           { return &v }
func floatPtr(v float64) *float64 { return &v }
func resetRecorder(t *testing.T)  { t.Cleanup(func() { SetRecorder(nil) }) }

// The DB recorder writes the contract's exact row: metric, quantity =
// totalTokens, and the metadata block with explicit nulls where a field
// is absent so aggregation reads one stable shape.
func TestDBRecorderWritesReferenceShape(t *testing.T) {
	pool := testPool(t)
	resetRecorder(t)
	SetRecorder(NewDBRecorder(pool))
	org := fmt.Sprintf("org-usage-%d", time.Now().UnixNano())

	Fire(context.Background(), Record{
		OrgID: org, UserID: "u1", RunID: "run-1", NodeID: "n1",
		Provider: "anthropic", Model: "claude-haiku-4-5-20251001",
		InputTokens: intPtr(120), OutputTokens: intPtr(30), TotalTokens: intPtr(150),
		CachedInputTokens: intPtr(100),
		LatencyMs:         420, CostUsd: floatPtr(0.00042),
		ProviderSimulated: false, Mode: "ai",
	})

	var metric string
	var quantity int
	var rawMetadata []byte
	if err := pool.QueryRow(context.Background(),
		`SELECT metric, quantity, metadata FROM usage_events WHERE org_id = $1`,
		org).Scan(&metric, &quantity, &rawMetadata); err != nil {
		t.Fatalf("read row: %v", err)
	}
	if metric != "llm.completion" || quantity != 150 {
		t.Fatalf("row identity: %s %d", metric, quantity)
	}
	var metadata map[string]any
	_ = json.Unmarshal(rawMetadata, &metadata)
	for key, want := range map[string]any{
		"provider": "anthropic", "model": "claude-haiku-4-5-20251001",
		"inputTokens": float64(120), "outputTokens": float64(30),
		"cachedInputTokens": float64(100), "latencyMs": float64(420),
		"costUsd": 0.00042, "providerSimulated": false, "nodeId": "n1",
		"mode": "ai",
	} {
		if metadata[key] != want {
			t.Fatalf("metadata[%s]: want %v got %v", key, want, metadata[key])
		}
	}
	// Absent fields persist as EXPLICIT nulls, present as keys.
	for _, key := range []string{"cacheCreationInputTokens", "workflowId", "aiError"} {
		value, present := metadata[key]
		if !present || value != nil {
			t.Fatalf("metadata[%s] must be explicit null: %v (present=%v)", key, value, present)
		}
	}

	// A fallback attempt records too, with the error and null cost.
	Fire(context.Background(), Record{
		OrgID: org, Provider: "anthropic", Model: "claude-haiku-4-5-20251001",
		LatencyMs: 80, Mode: "fallback", AiError: "provider timeout",
	})
	var fallbackRows int
	_ = pool.QueryRow(context.Background(), `SELECT count(*) FROM usage_events
		WHERE org_id = $1 AND metadata @> '{"mode":"fallback","aiError":"provider timeout"}'`,
		org).Scan(&fallbackRows)
	if fallbackRows != 1 {
		t.Fatalf("fallback attempt must record: %d", fallbackRows)
	}
}

// The seam's defensive contract: no recorder / no org = silent no-op;
// an erroring or panicking recorder never propagates to the caller.
func TestFireNeverBreaksTheCall(t *testing.T) {
	pool := testPool(t)
	resetRecorder(t)
	org := fmt.Sprintf("org-usage-safe-%d", time.Now().UnixNano())

	// No recorder registered: no-op.
	Fire(context.Background(), Record{OrgID: org, Mode: "ai"})

	// Recorder registered but the record has no org: skipped entirely.
	fired := 0
	SetRecorder(func(context.Context, Record) error { fired++; return nil })
	Fire(context.Background(), Record{Mode: "ai"})
	if fired != 0 {
		t.Fatalf("org-less record must not fire: %d", fired)
	}

	// Erroring and panicking recorders are absorbed.
	SetRecorder(func(context.Context, Record) error { return errors.New("db down") })
	Fire(context.Background(), Record{OrgID: org, Mode: "ai"})
	SetRecorder(func(context.Context, Record) error { panic("recorder bug") })
	Fire(context.Background(), Record{OrgID: org, Mode: "ai"})

	// And the real writer still works afterwards.
	SetRecorder(NewDBRecorder(pool))
	Fire(context.Background(), Record{
		OrgID: org, Provider: "anthropic", Model: "m", Mode: "ai", TotalTokens: intPtr(1),
	})
	var rows int
	_ = pool.QueryRow(context.Background(),
		`SELECT count(*) FROM usage_events WHERE org_id = $1`, org).Scan(&rows)
	if rows != 1 {
		t.Fatalf("recovered recorder must write: %d", rows)
	}
}

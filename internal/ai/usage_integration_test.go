//go:build integration

package ai

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/johnny4young/janusly/internal/usage"
)

// The chokepoint writes one usage_events row per attempt through the
// recorder: the exact reference row on success (tokens, cache
// counts, computed cost) and the fallback row with the classified error;
// an unpriced real model is rejected before egress, while a simulated provider
// always records zero.
func TestChokepointRecordsUsagePerAttempt(t *testing.T) {
	dsn := os.Getenv("JANUSLY_DATABASE_URL")
	if dsn == "" {
		t.Skip("JANUSLY_DATABASE_URL not set")
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	t.Cleanup(pool.Close)
	usage.SetRecorder(usage.NewDBRecorder(pool))
	t.Cleanup(func() { usage.SetRecorder(nil) })

	ctx := context.Background()
	org := fmt.Sprintf("org-ai-usage-%d", time.Now().UnixNano())
	server := fakeProvider(t, 200, successBody, 0)
	client := New(Config{APIKey: "k", BaseURL: server.URL})

	result, aiErr := client.GenerateText(ctx, GenerateTextInput{
		Prompt:  "hola",
		Context: CallContext{OrgID: org, RunID: "run-u", NodeID: "n1"},
	})
	if aiErr != nil {
		t.Fatalf("success call: %v", aiErr)
	}
	// costUsd from the table: ordinary input + 5m cache creation + cache read
	// + output, each at its own measured rate.
	wantCost := (10*1.0 + 1*1.25 + 2*0.1 + 5*5.0) / 1_000_000
	if result.CostUsd == nil || math.Abs(*result.CostUsd-wantCost) > 1e-12 {
		t.Fatalf("computed cost: %v want %f", result.CostUsd, wantCost)
	}

	readRow := func(mode string) map[string]any {
		var raw []byte
		var quantity int
		if err := pool.QueryRow(ctx, `SELECT quantity, metadata FROM usage_events
			WHERE org_id = $1 AND metadata @> jsonb_build_object('mode', $2::text)`,
			org, mode).Scan(&quantity, &raw); err != nil {
			t.Fatalf("read %s row: %v", mode, err)
		}
		var metadata map[string]any
		_ = json.Unmarshal(raw, &metadata)
		metadata["__quantity"] = float64(quantity)
		return metadata
	}
	row := readRow("ai")
	for key, want := range map[string]any{
		"__quantity": float64(18), "provider": "anthropic",
		"model": "claude-haiku-4-5-20251001", "inputTokens": float64(10),
		"outputTokens": float64(5), "cachedInputTokens": float64(2),
		"cacheCreationInputTokens": float64(1),
		"providerSimulated":        false, "nodeId": "n1", "aiError": nil,
	} {
		if row[key] != want {
			t.Fatalf("ai row %s: want %v got %v", key, want, row[key])
		}
	}
	rowCost, ok := row["costUsd"].(float64)
	if !ok || math.Abs(rowCost-wantCost) > 1e-12 {
		t.Fatalf("ai row costUsd: want %.12f got %v", wantCost, row["costUsd"])
	}

	// A fallback attempt records too, with the classified error.
	dead := New(Config{APIKey: "k", BaseURL: "http://127.0.0.1:1", TimeoutMs: 300})
	if _, aiErr := dead.GenerateText(ctx, GenerateTextInput{
		Prompt: "x", Context: CallContext{OrgID: org},
	}); aiErr == nil {
		t.Fatal("dead endpoint must fail")
	}
	fallback := readRow("fallback")
	if fallback["aiError"] == nil || fallback["costUsd"] != nil {
		t.Fatalf("fallback row: %+v", fallback)
	}

	// Unknown real model: fail closed before the paid call rather than creating
	// an unpriced usage row that budget aggregation could not count.
	unknown, aiErr := client.GenerateText(ctx, GenerateTextInput{
		Prompt: "x", ModelHint: "claude-mystery-9",
		Context: CallContext{OrgID: org + "-unknown"},
	})
	if unknown != nil || aiErr == nil || aiErr.Class != "invalid_request" {
		t.Fatalf("unknown model must be rejected before egress: result=%+v err=%v", unknown, aiErr)
	}

	// Simulated provider: zero cost even for a PRICED model.
	simulated := New(Config{APIKey: "k", BaseURL: server.URL, ProviderSimulated: true})
	simResult, aiErr := simulated.GenerateText(ctx, GenerateTextInput{
		Prompt: "x", Context: CallContext{OrgID: org + "-sim"},
	})
	if aiErr != nil || simResult.CostUsd == nil || *simResult.CostUsd != 0 {
		t.Fatalf("simulated must cost zero: %v %v", simResult, aiErr)
	}

	// Env price override wins over the table.
	t.Setenv("JANUSLY_LLM_PRICE_CLAUDE_HAIKU_4_5_20251001", "2,10")
	overridden, aiErr := client.GenerateText(ctx, GenerateTextInput{
		Prompt: "x", Context: CallContext{OrgID: org + "-override"},
	})
	wantOverridden := (10*2.0 + 1*2.5 + 2*0.2 + 5*10.0) / 1_000_000
	if aiErr != nil || overridden.CostUsd == nil || math.Abs(*overridden.CostUsd-wantOverridden) > 1e-12 {
		t.Fatalf("env override: %v (%v)", overridden.CostUsd, aiErr)
	}
}

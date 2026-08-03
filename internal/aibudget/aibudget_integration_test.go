//go:build integration

package aibudget

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/johnny4young/janusly/internal/ai"
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

// The budget ladder: no budget = no-op gate, warn crosses with ONE
// deduped audit, block flips exactly at the limit auditing every block,
// and a blocked call never reaches the provider.
func TestBudgetGateLadder(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	org := fmt.Sprintf("org-budget-%d", time.Now().UnixNano())

	seedConfig := func(key, valueJSON, valueType string) {
		if _, err := pool.Exec(ctx, `INSERT INTO org_configs (id, org_id, key, value_json, category, description, value_type)
			VALUES ($1, $2, $3, $4, 'ai', 'test', $5)
			ON CONFLICT (org_id, key) DO UPDATE SET value_json = EXCLUDED.value_json`,
			org+"-"+key, org, key, valueJSON, valueType); err != nil {
			t.Fatalf("seed %s: %v", key, err)
		}
	}
	seedSpend := func(id string, costUsd float64) {
		if _, err := pool.Exec(ctx, `INSERT INTO usage_events (id, org_id, metric, quantity, metadata)
			VALUES ($1, $2, 'llm.completion', 100, jsonb_build_object('costUsd', $3::double precision))`,
			org+"-"+id, org, costUsd); err != nil {
			t.Fatalf("seed spend: %v", err)
		}
	}
	countAudit := func(action string) int {
		var n int
		_ = pool.QueryRow(ctx, `SELECT count(*) FROM audit_logs WHERE org_id = $1 AND action = $2`, org, action).Scan(&n)
		return n
	}

	// 1. No budget configured: gate is a no-op.
	result := Check(ctx, pool, org)
	if !result.Allowed || result.MonthlyUsdLimit != nil {
		t.Fatalf("no budget must no-op: %+v", result)
	}

	// 2. Warn policy at 80%: crossing warns once (deduped), still allowed.
	seedConfig("ai.budgetMonthlyUsd", "10", "number")
	seedSpend("s1", 9.0) // 90% of 10
	result = Gate(ctx, pool, org, "u1", "generate-workflow")
	if !result.Allowed || !result.WarningThresholdCrossed {
		t.Fatalf("warn zone must allow + flag: %+v", result)
	}
	Gate(ctx, pool, org, "u1", "generate-workflow") // same day: deduped
	if got := countAudit("billing.budget.warned"); got != 1 {
		t.Fatalf("warn must audit once per window: %d", got)
	}

	// 3. Block policy: under the limit passes, crossing blocks — and every
	// block audits (deliberately not deduped).
	seedConfig("ai.budgetExceededPolicy", `"block"`, "string")
	result = Gate(ctx, pool, org, "u1", "generate-workflow")
	if !result.Allowed {
		t.Fatalf("under the limit must pass: %+v", result)
	}
	seedSpend("s2", 1.5) // total 10.5 >= 10
	for range 2 {
		result = Gate(ctx, pool, org, "u1", "generate-workflow")
		if result.Allowed {
			t.Fatalf("crossed block budget must block: %+v", result)
		}
	}
	if got := countAudit("billing.budget.exceeded"); got != 2 {
		t.Fatalf("every block must audit: %d", got)
	}

	// 4. A blocked call NEVER touches the SDK.
	var hits atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{}`))
	}))
	t.Cleanup(server.Close)
	client := ai.New(ai.Config{APIKey: "k", BaseURL: server.URL})
	generated, aiErr := GuardedGenerateText(ctx, pool, client, "u1", "generate-workflow",
		ai.GenerateTextInput{Prompt: "hola", Context: ai.CallContext{OrgID: org}})
	if generated != nil || aiErr == nil || aiErr.Class != "budget_blocked" {
		t.Fatalf("blocked call must degrade budget_blocked: %+v %v", generated, aiErr)
	}
	if hits.Load() != 0 {
		t.Fatalf("blocked call must never reach the provider: %d hits", hits.Load())
	}
}

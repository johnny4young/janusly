//go:build integration

package httpapi

import (
	"context"
	"fmt"
	"testing"
)

// /run/usage aggregates the run's usage slice into the contract shape,
// and the metrics cost rollup bounds >100 provider/model groups into 100
// exact rows plus one aggregated remainder with exact totals.
func TestRunUsageAndCostRollup(t *testing.T) {
	h := newAPIHarness(t)
	pool := testPool(t)
	ctx := context.Background()

	// Guards first: runId required; unknown/cross-org run is Forbidden.
	if res := h.call("GET", "/run/usage", nil, ""); res.status != 400 || res.body["code"] != "runs_run_id_required" {
		t.Fatalf("missing runId: %+v", res.body)
	}
	if res := h.call("GET", "/run/usage?runId=ghost", nil, ""); res.status != 403 {
		t.Fatalf("unknown run must be Forbidden: %+v", res.body)
	}

	// A real run with three LLM rows (one without price) + memory rows.
	runID := "run-usage-" + h.org
	if _, err := pool.Exec(ctx, `INSERT INTO runs (id, org_id, status, input_json, workflow_version_id)
		VALUES ($1, $2, 'succeeded', '{}', 'wv-u')`, runID, h.org); err != nil {
		t.Fatalf("seed run: %v", err)
	}
	seedUsage := func(id, metric string, quantity int, metadata string) {
		if _, err := pool.Exec(ctx, `INSERT INTO usage_events (id, org_id, run_id, metric, quantity, metadata)
			VALUES ($1, $2, $3, $4, $5, $6)`, id, h.org, runID, metric, quantity, metadata); err != nil {
			t.Fatalf("seed usage: %v", err)
		}
	}
	seedUsage(runID+"-1", "llm.completion", 150,
		`{"provider":"anthropic","model":"haiku","inputTokens":120,"outputTokens":30,"cachedInputTokens":100,"costUsd":0.001}`)
	seedUsage(runID+"-2", "llm.completion", 50,
		`{"provider":"anthropic","model":"haiku","inputTokens":40,"outputTokens":10,"costUsd":0.0005}`)
	seedUsage(runID+"-3", "llm.completion", 10,
		`{"provider":"anthropic","model":"mystery","inputTokens":8,"outputTokens":2,"costUsd":null}`)
	seedUsage(runID+"-m1", "memory.recall", 1, `{"kind":"agent_episode","ok":true}`)
	seedUsage(runID+"-m2", "memory.commit", 1, `{"kind":"agent_episode","ok":false}`)

	res := h.call("GET", "/run/usage?runId="+runID, nil, "")
	if res.status != 200 {
		t.Fatalf("usage read: %d %+v", res.status, res.body)
	}
	llm := res.body["llm"].(map[string]any)
	if llm["calls"] != float64(3) || llm["totalTokens"] != float64(210) ||
		llm["inputTokens"] != float64(168) || llm["cachedInputTokens"] != float64(100) ||
		llm["knownCostUsd"] != 0.0015 || llm["unknownCostCalls"] != float64(1) {
		t.Fatalf("llm aggregate: %+v", llm)
	}
	memory := res.body["memory"].(map[string]any)
	if memory["recalls"] != float64(1) || memory["commits"] != float64(1) || memory["failures"] != float64(1) {
		t.Fatalf("memory aggregate: %+v", memory)
	}
	if res.body["truncated"] != false || res.body["rowCap"] != float64(10000) || res.body["loadedRows"] != float64(5) {
		t.Fatalf("slice bookkeeping: %+v", res.body)
	}

	// The UI-friendly contract preserves exact totals, presents known provider
	// names, and exposes cache efficiency. The additive legacy list remains raw.
	focusedMetrics := h.call("GET", "/recovery/metrics?windowDays=30", nil, "")
	if focusedMetrics.status != 200 {
		t.Fatalf("focused metrics read: %d %+v", focusedMetrics.status, focusedMetrics.body)
	}
	costMetric := focusedMetrics.body["costThisWindow"].(map[string]any)
	if costMetric["value"] != 0.0015 {
		t.Fatalf("focused UI cost total: %+v", costMetric)
	}
	providers := costMetric["providers"].([]any)
	foundHaiku := false
	for _, raw := range providers {
		row := raw.(map[string]any)
		if row["model"] == "haiku" {
			foundHaiku = true
			if row["provider"] != "Anthropic" || row["inputTokens"] != float64(160) ||
				row["cachedInputTokens"] != float64(100) {
				t.Fatalf("display provider/cache row: %+v", row)
			}
		}
	}
	if !foundHaiku {
		t.Fatal("display cost rows omitted the haiku group")
	}
	cache := costMetric["cache"].(map[string]any)
	if cache["inputTokens"] != float64(168) || cache["readTokens"] != float64(100) ||
		cache["creationTokens"] != float64(0) {
		t.Fatalf("cache totals: %+v", cache)
	}
	share := cache["readSharePercent"].(float64)
	if share < 59.52 || share > 59.53 {
		t.Fatalf("cache share: %+v", cache)
	}

	// Cost rollup: 105 distinct models, $1 + i millis each — the response
	// folds the 5 cheapest into one remainder whose totals stay exact.
	for i := range 105 {
		seedUsage(fmt.Sprintf("%s-cost-%d", runID, i), "llm.completion", 100,
			fmt.Sprintf(`{"provider":"anthropic","model":"model-%03d","costUsd":%f}`, i, 1.0+float64(i)/1000))
	}
	metrics := h.call("GET", "/recovery/metrics?windowDays=30", nil, "")
	if metrics.status != 200 {
		t.Fatalf("metrics read: %d %+v", metrics.status, metrics.body)
	}
	rows := metrics.body["costByProvider"].([]any)
	if len(rows) > 102 { // 100 exact + remainder + the seeded haiku/mystery groups fold in
		t.Fatalf("rollup must bound cardinality: %d rows", len(rows))
	}
	var aggregated map[string]any
	exactCalls, totalUsd := 0.0, 0.0
	for _, raw := range rows {
		row := raw.(map[string]any)
		totalUsd += row["usd"].(float64)
		if row["aggregated"] == true {
			if aggregated != nil {
				t.Fatal("exactly one remainder row")
			}
			aggregated = row
			continue
		}
		exactCalls += row["calls"].(float64)
	}
	if aggregated == nil || aggregated["provider"] != "__other__" || aggregated["model"] != "__other__" {
		t.Fatalf("remainder row: %+v", aggregated)
	}
	// Exact-total invariant: every seeded dollar lands somewhere.
	wantUsd := 0.0015
	for i := range 105 {
		wantUsd += 1.0 + float64(i)/1000
	}
	if diff := totalUsd - wantUsd; diff > 0.000001 || diff < -0.000001 {
		t.Fatalf("totals must stay exact: want %f got %f", wantUsd, totalUsd)
	}
	if exactCalls+aggregated["calls"].(float64) != 108 { // 105 + 3 run rows
		t.Fatalf("call totals: exact=%f remainder=%v", exactCalls, aggregated["calls"])
	}

	// The bounded display projection and legacy list share exact totals even
	// after low-value groups have been folded into the remainder bucket.
	costMetric = metrics.body["costThisWindow"].(map[string]any)
	if costMetric["value"].(float64) != totalUsd {
		t.Fatalf("UI cost total: want %f got %+v", totalUsd, costMetric)
	}
	providers = costMetric["providers"].([]any)
	if len(providers) != len(rows) {
		t.Fatalf("display/legacy cardinality drift: display=%d legacy=%d", len(providers), len(rows))
	}
}

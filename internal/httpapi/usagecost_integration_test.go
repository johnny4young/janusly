//go:build integration

package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func TestUsageCostsDrillThrough(t *testing.T) {
	t.Setenv("ANTHROPIC_API_KEY", "")
	h := newAPIHarness(t)
	pool := testPool(t)
	ctx := context.Background()

	path := "/v1/usage/costs"
	empty := h.call("GET", path, nil, "")
	if empty.status != 200 {
		t.Fatalf("empty: %d %+v", empty.status, empty.body)
	}
	data := empty.body["data"].(map[string]any)
	if data["aiConfigured"] != false || data["windowDays"] != float64(30) {
		t.Fatalf("empty must explain itself: %+v", data)
	}
	if totals := data["totals"].(map[string]any); totals["calls"] != float64(0) || totals["costUsd"] != nil {
		t.Fatalf("no usage must be a null cost, never a measured zero: %+v", totals)
	}

	seedRun := func(id, name string) {
		if _, err := pool.Exec(ctx, `INSERT INTO runs (id, org_id, status, input_json, workflow_version_id)
			VALUES ($1, $2, 'succeeded', $3, 'wv-cost')`, id, h.org,
			fmt.Sprintf(`{"workflow":{"name":%q}}`, name)); err != nil {
			t.Fatalf("seed run: %v", err)
		}
	}
	serial := 0
	seedUsage := func(org string, run any, age, metadata string) {
		serial++
		if _, err := pool.Exec(ctx, `INSERT INTO usage_events (id, org_id, run_id, metric, quantity, metadata, created_at)
			VALUES ($1, $2, $3, 'llm.completion', 10, $4, now() - $5::interval)`,
			fmt.Sprintf("%s-cost-%d", h.org, serial), org, run, metadata, age); err != nil {
			t.Fatalf("seed usage: %v", err)
		}
	}
	cheapRun, dearRun := "run-cheap-"+h.org, "run-dear-"+h.org
	seedRun(cheapRun, "Cheap flow")
	seedRun(dearRun, "Dear flow")
	seedUsage(h.org, dearRun, "1 hour", `{"provider":"anthropic","model":"sonnet","nodeId":"draft","inputTokens":100,"cachedInputTokens":900,"cacheCreationInputTokens":50,"outputTokens":40,"costUsd":0.2,"providerSimulated":false}`)
	seedUsage(h.org, dearRun, "2 hours", `{"provider":"anthropic","model":"sonnet","nodeId":"draft","inputTokens":10,"outputTokens":5,"costUsd":0.1,"providerSimulated":false}`)
	seedUsage(h.org, cheapRun, "3 hours", `{"provider":"anthropic","model":"haiku","nodeId":"score","inputTokens":7,"outputTokens":1,"costUsd":0.01,"providerSimulated":false}`)
	// A failed attempt: no price, and an error text that must never leave the server.
	seedUsage(h.org, cheapRun, "4 hours", `{"provider":"anthropic","model":"haiku","nodeId":"retry","mode":"fallback","costUsd":null,"aiError":"SECRET-PROVIDER-TEXT","providerSimulated":false}`)
	seedUsage(h.org, cheapRun, "5 hours", `{"provider":"anthropic","model":"sim","nodeId":"sim","inputTokens":3,"costUsd":0,"providerSimulated":true}`)
	seedUsage(h.org, nil, "6 hours", `{"provider":"anthropic","model":"haiku","inputTokens":2,"costUsd":0.02,"providerSimulated":false}`)
	seedUsage(h.org, "run-purged-"+h.org, "7 hours", `{"provider":"anthropic","model":"haiku","nodeId":"gone","costUsd":0.005,"providerSimulated":false}`)
	seedUsage(h.org, dearRun, "10 days", `{"provider":"anthropic","model":"haiku","nodeId":"old","costUsd":5,"providerSimulated":false}`)
	seedUsage("other-"+h.org, "other-run", "1 hour", `{"provider":"anthropic","model":"foreign","nodeId":"foreign","costUsd":99,"providerSimulated":false}`)

	type tally struct {
		Calls               int      `json:"calls"`
		UncachedInputTokens int      `json:"uncachedInputTokens"`
		CachedInputTokens   int      `json:"cachedInputTokens"`
		CacheCreation       int      `json:"cacheCreationInputTokens"`
		OutputTokens        int      `json:"outputTokens"`
		CostUsd             *float64 `json:"costUsd"`
		UnknownCostCalls    int      `json:"unknownCostCalls"`
		SimulatedCalls      int      `json:"simulatedCalls"`
	}
	type step struct {
		tally
		RunID        string  `json:"runId"`
		RunAvailable bool    `json:"runAvailable"`
		WorkflowName string  `json:"workflowName"`
		NodeID       *string `json:"nodeId"`
		Model        string  `json:"model"`
	}
	type model struct {
		tally
		Provider string `json:"provider"`
		Model    string `json:"model"`
	}
	type payload struct {
		WindowDays    int     `json:"windowDays"`
		RetentionDays int     `json:"retentionDays"`
		StepsTotal    int     `json:"stepsTotal"`
		Truncated     bool    `json:"truncated"`
		Totals        tally   `json:"totals"`
		WithoutRun    tally   `json:"withoutRun"`
		Steps         []step  `json:"steps"`
		Models        []model `json:"models"`
	}
	read := func(query string) (payload, string) {
		t.Helper()
		res := h.call("GET", path+query, nil, "")
		if res.status != 200 {
			t.Fatalf("%s: %d %+v", query, res.status, res.body)
		}
		raw, err := json.Marshal(res.body["data"])
		if err != nil {
			t.Fatal(err)
		}
		var out payload
		if err := json.Unmarshal(raw, &out); err != nil {
			t.Fatal(err)
		}
		return out, string(raw)
	}

	week, raw := read("?windowDays=7")
	for _, leaked := range []string{"SECRET-PROVIDER-TEXT", "aiError", "foreign"} {
		if strings.Contains(raw, leaked) {
			t.Fatalf("payload leaked %q: %s", leaked, raw)
		}
	}
	if week.WindowDays != 7 || week.RetentionDays != 90 || week.Truncated {
		t.Fatalf("envelope: %+v", week)
	}
	// Stored inputTokens exclude cache reads and writes: they are the uncached count as is.
	if week.Totals.Calls != 7 || week.Totals.UncachedInputTokens != 122 || week.Totals.CachedInputTokens != 900 ||
		week.Totals.CacheCreation != 50 || week.Totals.UnknownCostCalls != 1 || week.Totals.SimulatedCalls != 1 {
		t.Fatalf("totals: %+v", week.Totals)
	}
	if week.WithoutRun.Calls != 1 || week.WithoutRun.CostUsd == nil || *week.WithoutRun.CostUsd != 0.02 {
		t.Fatalf("calls outside a run must stay visible: %+v", week.WithoutRun)
	}
	if week.StepsTotal != 5 || len(week.Steps) != 5 {
		t.Fatalf("steps: %+v", week.Steps)
	}
	first := week.Steps[0]
	if first.RunID != dearRun || *first.NodeID != "draft" || first.Calls != 2 || first.WorkflowName != "Dear flow" ||
		!first.RunAvailable || first.UncachedInputTokens != 110 || first.CostUsd == nil || *first.CostUsd < 0.299 {
		t.Fatalf("the most expensive step must come first: %+v", first)
	}
	stepByNode := map[string]step{}
	for _, row := range week.Steps {
		stepByNode[*row.NodeID] = row
	}
	if stepByNode["old"].Calls != 0 {
		t.Fatalf("a row outside the window must not count: %+v", stepByNode["old"])
	}
	if failed := stepByNode["retry"]; failed.CostUsd != nil || failed.UnknownCostCalls != 1 {
		t.Fatalf("a failed attempt has no cost: %+v", failed)
	}
	if simulated := stepByNode["sim"]; simulated.CostUsd != nil || simulated.SimulatedCalls != 1 {
		t.Fatalf("a simulated call is not a measured zero: %+v", simulated)
	}
	if gone := stepByNode["gone"]; gone.RunAvailable || gone.WorkflowName != "" {
		t.Fatalf("a purged run must not offer a link: %+v", gone)
	}
	if week.Steps[3].CostUsd != nil || week.Steps[4].CostUsd != nil {
		t.Fatalf("unpriced steps sort last: %+v", week.Steps)
	}
	if week.Models[0].Model != "sonnet" || week.Models[0].Provider != "Anthropic" || week.Models[1].Model != "haiku" ||
		week.Models[2].Model != "sim" || week.Models[2].CostUsd != nil {
		t.Fatalf("models: %+v", week.Models)
	}

	month, _ := read("")
	if month.WindowDays != 30 || month.StepsTotal != 6 {
		t.Fatalf("the default window reaches the older row: %+v", month)
	}
	limited, _ := read("?windowDays=7&limit=1")
	if len(limited.Steps) != 1 || limited.StepsTotal != 5 || limited.Steps[0].RunID != dearRun {
		t.Fatalf("limit: %+v", limited.Steps)
	}
	filtered, _ := read("?windowDays=7&model=haiku")
	if filtered.StepsTotal != 3 || len(filtered.Models) != 3 || filtered.Totals.Calls != 7 {
		t.Fatalf("a model selects steps only: %+v", filtered)
	}
	for _, row := range filtered.Steps {
		if row.Model != "haiku" {
			t.Fatalf("filtered step: %+v", row)
		}
	}
	if clamped, _ := read("?windowDays=9999&limit=9999"); clamped.WindowDays != 90 {
		t.Fatalf("window must clamp: %+v", clamped.WindowDays)
	}

	// Same gate as /run/usage: a role with runs.read reads, one without is refused.
	for name, grant := range map[string]string{"cost-reader": "runs.read", "cost-blind": "dlq.read"} {
		if res := h.call("POST", "/org/roles", map[string]any{
			"name": name, "inheritsFrom": "viewer", "grantedPermissions": []any{grant},
		}, ""); res.status != 200 {
			t.Fatalf("role %s: %d %+v", name, res.status, res.body)
		}
		seedMemberRow(t, pool, h.org, "u-"+name, name+"@x.com", name)
	}
	asRole := func(name string) apiResponse {
		return h.callWithHeaders("GET", path, nil, "", map[string]string{"x-user-id": "u-" + name})
	}
	if res := asRole("cost-reader"); res.status != 200 {
		t.Fatalf("runs.read must read: %d %+v", res.status, res.body)
	}
	if res := asRole("cost-blind"); res.status != 403 {
		t.Fatalf("no runs.read must be refused: %d %+v", res.status, res.body)
	}
}

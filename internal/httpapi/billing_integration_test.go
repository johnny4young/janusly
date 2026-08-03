//go:build integration

package httpapi

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/johnny4young/janusly/internal/aibudget"
)

// Bounded usage reporting + the composite budget (workflow
// override bites before the org default) + the per-workflow budget write.

func seedUsage(t *testing.T, org, workflowID, model string, quantity int, costUsd float64, mode string) {
	t.Helper()
	pool := testPool(t)
	metadata := fmt.Sprintf(`{"provider":"anthropic","model":%q,"mode":%q,"costUsd":%v,"latencyMs":120,"workflowId":%q}`,
		model, mode, costUsd, workflowID)
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO usage_events (id, org_id, metric, quantity, metadata)
		 VALUES ($1, $2, 'llm.completion', $3, $4::jsonb)`,
		fmt.Sprintf("ue-%d-%d", time.Now().UnixNano(), quantity), org, quantity, metadata); err != nil {
		t.Fatalf("seed usage: %v", err)
	}
}

func TestBillingUsageSurfaces(t *testing.T) {
	h := newAPIHarness(t)
	seedUsage(t, h.org, "wf-bill-a", "claude-haiku-4-5", 100, 0.5, "ai")
	seedUsage(t, h.org, "wf-bill-a", "claude-haiku-4-5", 40, 0.2, "fallback")
	seedUsage(t, h.org, "wf-bill-b", "claude-haiku-4-5", 60, 0.3, "ai")

	// Flat summary (back-compat shape): Record<metric, quantity>.
	flat := h.call("GET", "/billing/usage", nil, "")
	if flat.status != 200 || flat.body["llm.completion"] != float64(200) {
		t.Fatalf("summary: %d %+v", flat.status, flat.body)
	}

	// Dimensional breakdown: buckets keyed dim=value|…, fallback counted,
	// cost summed, latency aggregated.
	broken := h.call("GET", "/billing/usage?breakdown=workflow,mode", nil, "")
	if broken.status != 200 || broken.body["windowDays"] != float64(30) {
		t.Fatalf("breakdown envelope: %d %+v", broken.status, broken.body)
	}
	buckets := broken.body["breakdown"].([]any)
	if len(buckets) != 3 {
		t.Fatalf("expected 3 buckets, got %d: %+v", len(buckets), buckets)
	}
	var sawFallback bool
	for _, raw := range buckets {
		bucket := raw.(map[string]any)
		if bucket["workflow"] == "wf-bill-a" && bucket["mode"] == "fallback" {
			sawFallback = true
			if bucket["quantity"] != float64(40) || bucket["fallbackCount"] != float64(1) || bucket["costUsd"] != 0.2 {
				t.Fatalf("fallback bucket: %+v", bucket)
			}
			if bucket["latency"].(map[string]any)["p50Ms"] != float64(120) {
				t.Fatalf("latency: %+v", bucket["latency"])
			}
		}
	}
	if !sawFallback {
		t.Fatalf("missing wf-bill-a fallback bucket: %+v", buckets)
	}

	// Unknown dimension: the reference's stable error code.
	if res := h.call("GET", "/billing/usage?breakdown=color", nil, ""); res.status != 400 {
		t.Fatalf("unknown dimension must 400: %d %+v", res.status, res.body)
	}

	// CSV export: header + formula guard + audit.
	req, _ := http.NewRequest("GET", h.server.URL+"/billing/usage/export?breakdown=workflow", nil)
	req.Header.Set("x-org-id", h.org)
	req.Header.Set("x-user-id", "api-tester")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("export: %v", err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	csv := string(raw)
	if res.StatusCode != 200 || !strings.HasPrefix(csv, "workflow,quantity,callCount") {
		t.Fatalf("csv shape: %d %q", res.StatusCode, csv[:min(80, len(csv))])
	}
	if !strings.Contains(res.Header.Get("Content-Disposition"), "janusly-usage-") {
		t.Fatalf("attachment header: %q", res.Header.Get("Content-Disposition"))
	}
	var audited int
	_ = testPool(t).QueryRow(context.Background(), `SELECT count(*) FROM audit_logs
		WHERE org_id = $1 AND action = 'billing.usage.exported'`, h.org).Scan(&audited)
	if audited != 1 {
		t.Fatalf("export must audit once, got %d", audited)
	}
}

func TestWorkflowBudgetCompositeGate(t *testing.T) {
	h := newAPIHarness(t)
	pool := testPool(t)
	suffix := fmt.Sprint(time.Now().UnixNano())
	workflowID := "wf-budget-" + suffix

	// A saved workflow to own the budget.
	saved := h.call("POST", "/workflows/save", map[string]any{
		"id": workflowID, "name": "Budgeted", "dslVersion": "1.0",
		"nodes": []any{map[string]any{"id": "a", "type": "noop", "config": map[string]any{}}},
		"edges": []any{},
	}, "")
	if saved.status != 200 {
		t.Fatalf("save: %d %+v", saved.status, saved.body)
	}

	// Validation ladder + tenancy.
	if res := h.call("POST", "/workflows/"+workflowID+"/budget", map[string]any{}, ""); res.status != 400 {
		t.Fatalf("missing monthlyUsd must 400: %d", res.status)
	}
	if res := h.call("POST", "/workflows/"+workflowID+"/budget", map[string]any{
		"monthlyUsd": 10, "warnPercent": 12.5,
	}, ""); res.status != 400 {
		t.Fatalf("fractional warnPercent must 400: %d", res.status)
	}
	if res := h.call("POST", "/workflows/"+workflowID+"/budget", map[string]any{
		"monthlyUsd": 10, "policy": "explode",
	}, ""); res.status != 400 {
		t.Fatalf("bad policy must 400: %d", res.status)
	}
	if res := h.call("POST", "/workflows/nope/budget", map[string]any{"monthlyUsd": 10}, ""); res.status != 404 {
		t.Fatalf("foreign workflow must 404: %d", res.status)
	}

	// Upsert: response row + audit with before/after.
	created := h.call("POST", "/workflows/"+workflowID+"/budget", map[string]any{
		"monthlyUsd": 1.0, "warnPercent": 50, "policy": "block",
	}, "")
	if created.status != 200 || created.body["workflowId"] != workflowID || created.body["policy"] != "block" {
		t.Fatalf("upsert: %d %+v", created.status, created.body)
	}
	var audited int
	_ = pool.QueryRow(context.Background(), `SELECT count(*) FROM audit_logs
		WHERE org_id = $1 AND action = 'billing.budget.configured'`, h.org).Scan(&audited)
	if audited != 1 {
		t.Fatalf("budget write must audit, got %d", audited)
	}

	// Spend past the WORKFLOW limit while the ORG stays unlimited: the
	// override bites first — blocked at workflow scope.
	seedUsage(t, h.org, workflowID, "claude-haiku-4-5", 500, 2.0, "ai")
	envelope := h.call("GET", "/billing/budget?workflowId="+workflowID, nil, "")
	if envelope.status != 200 || envelope.body["allowed"] != false ||
		envelope.body["resolvedScope"] != "workflow" || envelope.body["exceededAt"] != "workflow" {
		t.Fatalf("workflow budget must bite before org: %+v", envelope.body)
	}
	// The org-scope read stays open (no org budget configured).
	orgEnvelope := h.call("GET", "/billing/budget", nil, "")
	if orgEnvelope.status != 200 || orgEnvelope.body["allowed"] != true {
		t.Fatalf("org scope must stay open: %+v", orgEnvelope.body)
	}
	// Direct composite check (the dispatcher's gate).
	if result := aibudget.CheckScoped(context.Background(), pool, h.org, workflowID); result.Allowed {
		t.Fatalf("CheckScoped must block: %+v", result)
	}
	// A second upsert relaxes it and the gate follows.
	if res := h.call("POST", "/workflows/"+workflowID+"/budget", map[string]any{
		"monthlyUsd": 100.0, "policy": "block",
	}, ""); res.status != 200 {
		t.Fatalf("relax: %d", res.status)
	}
	if result := aibudget.CheckScoped(context.Background(), pool, h.org, workflowID); !result.Allowed {
		t.Fatalf("relaxed budget must allow: %+v", result)
	}
}
